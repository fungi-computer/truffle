import type { heapStats } from "bun:jsc";
import { Buffer } from "node:buffer";
import fs from "node:fs";
import { join } from "node:path";
import { localFailureMetadata, logEvent } from "./log-event.js";
import { z } from "zod";

export const serviceLogRecordBytes = 32 * 1024;
const serviceLogFileBytes = 1024 * 1024;
const serviceLogBackupFiles = 3;
export const serviceLogSampleIntervalMs = 5 * 60 * 1000;

export type HeapStatistics = ReturnType<typeof heapStats>;
export type FailureMetadata = ReturnType<typeof localFailureMetadata>;
export const serviceDiagnosticsStatusSchema = z.discriminatedUnion("state", [
  z.strictObject({ state: z.literal("active") }),
  z.strictObject({
    state: z.literal("failed"),
    code: z.enum([
      "sink-open-failed",
      "sink-write-failed",
      "sink-close-failed",
    ]),
    since: z.iso.datetime(),
  }),
  z.strictObject({
    state: z.literal("recovery-disabled"),
    code: z.enum(["read-failed", "decode-failed"]),
    since: z.iso.datetime(),
  }),
]);
export type ServiceDiagnosticsStatus = z.infer<
  typeof serviceDiagnosticsStatusSchema
>;
export type ServiceDiagnosticsFailureCode = Extract<
  ServiceDiagnosticsStatus,
  { state: "failed" }
>["code"];
export type RecoveryPersistenceFailureCode = Extract<
  ServiceDiagnosticsStatus,
  { state: "recovery-disabled" }
>["code"];
export type ServiceLogWriter = Readonly<{
  writeLine: (line: string) => void;
  close: () => void;
}>;
export type OpenServiceLogWriter = (directory: string) => ServiceLogWriter;

function privateLogFileSize(file: fs.Stats): number {
  if (!file.isFile() || (file.mode & 0o777) !== 0o600)
    throw new Error("Diagnostic log is not a private regular file");
  if (file.size > serviceLogFileBytes)
    throw new Error("Diagnostic log exceeds its file byte bound");
  return file.size;
}

function existingLogArchive(path: string): fs.Stats | undefined {
  try {
    return fs.statSync(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
}

/**
 * Exactly four owned names, each at most 1 MiB. Rotation happens BEFORE append,
 * oldest destination first; each rename either succeeds or throws to the
 * resource's Option2 latch. Replacing .3 cannot add a fifth file or extra bytes.
 * No retries, asynchronous work, chmod repair or second lifecycle owner.
 */
function openNativeServiceLogWriter(directory: string): ServiceLogWriter {
  const path = join(directory, "service.jsonl");
  for (let index = 1; index <= serviceLogBackupFiles; index++) {
    const file = existingLogArchive(`${path}.${String(index)}`);
    if (file !== undefined) privateLogFileSize(file);
  }
  let descriptor: number | undefined;
  const currentDescriptor = () => {
    if (descriptor === undefined) throw new Error("Diagnostic log is closed");
    return descriptor;
  };
  const close = () => {
    const fd = descriptor;
    // Retire before calling the runtime: never close a reused descriptor.
    descriptor = undefined;
    if (fd !== undefined) fs.closeSync(fd);
  };
  const open = () => {
    descriptor = fs.openSync(path, "a", 0o600);
    try {
      privateLogFileSize(fs.fstatSync(descriptor));
    } catch (cause) {
      try {
        close();
      } catch (closeCause) {
        logEvent("service-log.open-close", closeCause);
      }
      throw cause;
    }
  };
  const rotate = () => {
    close();
    for (let index = serviceLogBackupFiles - 1; index >= 1; index--) {
      const source = `${path}.${String(index)}`;
      const file = existingLogArchive(source);
      if (file === undefined) continue; // only genuinely absent archive slots
      privateLogFileSize(file);
      fs.renameSync(source, `${path}.${String(index + 1)}`);
    }
    // Unlike optional archives, the active pathname MUST exist.
    fs.renameSync(path, `${path}.1`);
    open();
  };
  open();
  return {
    writeLine(line) {
      const bytes = Buffer.byteLength(line, "utf8");
      if (bytes > serviceLogRecordBytes)
        throw new Error("Diagnostic record exceeds its byte bound");
      const size = privateLogFileSize(fs.fstatSync(currentDescriptor()));
      if (size + bytes > serviceLogFileBytes) rotate();
      const written = fs.writeSync(currentDescriptor(), line, null, "utf8");
      if (written !== bytes) throw new Error("Diagnostic log short write");
    },
    close,
  };
}

/** Catchable observations, not an inferred cause for a missing final record. */
export type ServiceLogEvent =
  | Readonly<{ event: "starting" }>
  | Readonly<{ event: "ready"; serviceId: string }>
  | Readonly<{
      event: "stopping" | "stopped";
      reason: "SIGINT" | "SIGTERM" | "startup-failure" | "runtime-failure";
    }>
  | Readonly<{ event: "failure"; failure: FailureMetadata }>
  | Readonly<{
      event: "recovery-persistence-disabled";
      code: RecoveryPersistenceFailureCode;
    }>
  | Readonly<{ event: "memory"; rss: number; heap: HeapStatistics }>
  | Readonly<{ event: "memory-unavailable"; failure: FailureMetadata }>
  | Readonly<{
      event: "drain-timeout";
      deadlineMs: number;
      phase: ServiceDrainPhase;
      unfinishedOwners: readonly string[];
      unfinishedOwnerCount: number;
    }>;

/** Where SIGTERM drain stood; owners settle before listener, record, lease. */
export type ServiceDrainPhase =
  "active" | "owners" | "listener" | "record" | "lease" | "closed";
/** A drain-timeout record names at most this many unfinished owners. */
const drainTimeoutOwnerLimit = 32;

export type ServiceLogRecord = ServiceLogEvent &
  Readonly<{
    source: "local-service";
    timestamp: string;
    pid: number;
    version: string;
  }>;

export type ServiceLogShutdownReason = Extract<
  ServiceLogEvent,
  { event: "stopping" | "stopped" }
>["reason"];

export type ServiceLogLifecycle = Readonly<{
  getStatus: () => ServiceDiagnosticsStatus;
  ready: (serviceId: string) => void;
  stopping: (reason: ServiceLogShutdownReason) => void;
  failure: (failure: FailureMetadata) => void;
  recoveryDisabled: (code: RecoveryPersistenceFailureCode) => void;
  /** Synchronous, so it lands before the bounded drain exits the process. */
  drainTimeout: (
    drain: Readonly<{
      deadlineMs: number;
      phase: ServiceDrainPhase;
      unfinishedOwners: readonly string[];
    }>,
  ) => void;
  close: () => void;
}>;

function omissionSummary(counts: Readonly<Record<string, number>>) {
  return {
    status: "omitted-byte-bound",
    typeCount: Object.keys(counts).length,
    allocatedCells: Object.values(counts).reduce(
      (sum, count) => sum + count,
      0,
    ),
  };
}

/**
 * Preserve ALL maintained count entries, in their producer order, when they fit.
 * If they do not, explicitly omit the maps as a whole. No ranking/top-N policy,
 * count substitution, exception serialization or byte-sliced JSON.
 */
export function encodeServiceLogRecord(record: ServiceLogRecord): string {
  const line = JSON.stringify(record) + "\n";
  const encodedBytes = Buffer.byteLength(line, "utf8");
  if (encodedBytes <= serviceLogRecordBytes) return line;
  if (record.event === "memory") {
    const summary =
      JSON.stringify({
        ...record,
        heap: {
          ...record.heap,
          objectTypeCounts: omissionSummary(record.heap.objectTypeCounts),
          protectedObjectTypeCounts: omissionSummary(
            record.heap.protectedObjectTypeCounts,
          ),
        },
        omittedRecordBytes: encodedBytes,
      }) + "\n";
    if (Buffer.byteLength(summary, "utf8") <= serviceLogRecordBytes)
      return summary;
  }
  // Only fixed classification and numeric size survive an oversized record.
  return (
    JSON.stringify({
      source: "local-service",
      timestamp: record.timestamp,
      pid: record.pid,
      event: "record-omitted",
      recordEvent: record.event,
      encodedBytes,
    }) + "\n"
  );
}

/**
 * One timer per service lifetime. The listener must close it before disposing
 * the writer, and dispose the writer before releasing its existing owner lease.
 * Both entry paths use this same owned resource.
 */
export function createServiceLogSampler(
  input: Readonly<{
    readMemory: () => Readonly<{ rss: number; heap: HeapStatistics }>;
    emit: (event: ServiceLogEvent) => void;
  }>,
) {
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  return {
    start() {
      if (closed)
        throw new Error("Cannot restart a disposed service log sampler");
      if (timer !== undefined) return;
      timer = setInterval(() => {
        let memory: ReturnType<typeof input.readMemory>;
        try {
          memory = input.readMemory();
        } catch (cause) {
          logEvent("service-log.sample", cause);
          input.emit({
            event: "memory-unavailable",
            failure: localFailureMetadata("service-log.sample", cause),
          });
          return;
        }
        // A sink failure must stay observable, not be mislabeled heap failure.
        input.emit({ event: "memory", ...memory });
      }, serviceLogSampleIntervalMs);
      timer.unref();
    },
    close() {
      closed = true;
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

/**
 * Diagnostics resources only: no service lock, signal handler or runtime drain.
 * The existing listener remains the owner. Native file I/O stays in this module.
 * Writer faults latch a typed live failure, stop sampling and close once.
 * They never escape into a request, turn, signal handler or timer callback.
 */
export function createServiceLogLifecycle(
  input: Readonly<{
    pid: number;
    version: string;
    directory: string;
    openWriter?: OpenServiceLogWriter;
    readMemory: () => Readonly<{ rss: number; heap: HeapStatistics }>;
  }>,
): ServiceLogLifecycle {
  let ready = false;
  let closed = false;
  let reason: ServiceLogShutdownReason | undefined;
  let status: Exclude<
    ServiceDiagnosticsStatus,
    { state: "recovery-disabled" }
  > = { state: "active" };
  let recovery:
    | Extract<ServiceDiagnosticsStatus, { state: "recovery-disabled" }>
    | undefined;
  let writer: ServiceLogWriter | undefined;
  let writerClosed = false;
  const closeWriter = () => {
    if (writerClosed) return;
    writerClosed = true;
    try {
      writer?.close();
    } catch (cause) {
      if (status.state === "active")
        status = {
          state: "failed",
          code: "sink-close-failed",
          since: new Date().toISOString(),
        };
      logEvent("service-log.close", cause);
    }
  };
  const fail = (code: ServiceDiagnosticsFailureCode) => {
    if (status.state === "failed") return;
    status = { state: "failed", code, since: new Date().toISOString() };
    sampler.close();
    closeWriter();
  };
  const emit = (event: ServiceLogEvent) => {
    if (closed || status.state === "failed") return;
    try {
      if (writer === undefined)
        throw new Error("Diagnostic writer did not open");
      writer.writeLine(
        encodeServiceLogRecord({
          ...event,
          source: "local-service",
          timestamp: new Date().toISOString(),
          pid: input.pid,
          version: input.version,
        }),
      );
    } catch (cause) {
      // Publish failure before disposal/reporting: even a reentrant status read
      // sees the first code/time. No further writer call or retry is permitted.
      fail("sink-write-failed");
      logEvent("service-log.write", cause);
    }
  };
  const sampler = createServiceLogSampler({
    readMemory: input.readMemory,
    emit,
  });
  try {
    writer = (input.openWriter ?? openNativeServiceLogWriter)(input.directory);
  } catch (cause) {
    fail("sink-open-failed");
    logEvent("service-log.open", cause);
  }
  emit({ event: "starting" });
  return {
    // A sink failure still takes precedence: it means diagnostics cannot be
    // persisted at all. Recovery disablement must not stop a working log sink.
    getStatus: () =>
      status.state === "failed" ? status : (recovery ?? status),
    ready(serviceId) {
      if (closed || ready) return;
      emit({ event: "ready", serviceId });
      ready = true;
      if (status.state === "active") sampler.start();
    },
    stopping(observedReason) {
      if (reason !== undefined) return;
      reason = observedReason;
      sampler.close();
      emit({ event: "stopping", reason });
    },
    failure(failure) {
      emit({ event: "failure", failure });
    },
    recoveryDisabled(code) {
      if (closed || recovery !== undefined) return;
      recovery = {
        state: "recovery-disabled",
        code,
        since: new Date().toISOString(),
      };
      emit({ event: "recovery-persistence-disabled", code });
    },
    drainTimeout(drain) {
      // Owner names only (Agent IDs or store keys), never exception or input
      // text. The record encoder still enforces the per-record byte bound.
      emit({
        event: "drain-timeout",
        deadlineMs: drain.deadlineMs,
        phase: drain.phase,
        unfinishedOwners: drain.unfinishedOwners.slice(
          0,
          drainTimeoutOwnerLimit,
        ),
        unfinishedOwnerCount: drain.unfinishedOwners.length,
      });
    },
    close() {
      if (closed) return;
      sampler.close();
      if (reason !== undefined) emit({ event: "stopped", reason });
      closeWriter();
      closed = true;
    },
  };
}
