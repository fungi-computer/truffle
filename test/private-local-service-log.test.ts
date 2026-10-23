import { Buffer } from "node:buffer";
import type { heapStats } from "bun:jsc";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createServiceLogSampler,
  createServiceLogLifecycle,
  encodeServiceLogRecord,
  serviceLogRecordBytes,
  serviceLogSampleIntervalMs,
} from "../src/private-local-service-log.js";
import { localFailureMetadata } from "../src/log-event.js";

const heap: ReturnType<typeof heapStats> = {
  heapSize: 100,
  heapCapacity: 200,
  extraMemorySize: 20,
  objectCount: 4,
  protectedObjectCount: 1,
  globalObjectCount: 1,
  protectedGlobalObjectCount: 1,
  objectTypeCounts: { Promise: 2, Object: 1, SQLStatement: 1 },
  protectedObjectTypeCounts: { Object: 1 },
};
const envelope = {
  source: "local-service",
  timestamp: "2026-10-18T00:00:00.000Z",
  pid: 123,
  version: "source",
} satisfies Readonly<{
  source: "local-service";
  timestamp: string;
  pid: number;
  version: string;
}>;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function memoryRecord(typeCount: number) {
  const objectTypeCounts = Object.fromEntries(
    Array.from(
      { length: typeCount },
      (_, index) =>
        [
          `SyntheticRuntimeObjectClass${String(index).padStart(3, "0")}`,
          index + 1,
        ] as const,
    ),
  );
  const protectedObjectTypeCounts = Object.fromEntries(
    Object.keys(objectTypeCounts).map((name) => [name, 1] as const),
  );
  return {
    ...envelope,
    event: "memory" as const,
    rss: 731_705_344,
    heap: {
      ...heap,
      objectCount: (typeCount * (typeCount + 1)) / 2,
      protectedObjectCount: typeCount,
      objectTypeCounts,
      protectedObjectTypeCounts,
    },
  };
}

describe("diagnostics resource lifecycle", () => {
  it("reports disabled recovery once without disabling logging or hiding a sink failure", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(envelope.timestamp));
    const lines: string[] = [];
    let failWrites = false;
    const lifecycle = createServiceLogLifecycle({
      pid: envelope.pid,
      version: envelope.version,
      directory: "/owned-fixture",
      openWriter: () => ({
        writeLine: (line) => {
          if (failWrites) throw new Error("owned-sink-failure");
          lines.push(line);
        },
        close: () => undefined,
      }),
      readMemory: () => ({ rss: 300, heap }),
    });
    lifecycle.ready("fixture-service");
    lifecycle.recoveryDisabled("read-failed");
    const first = lifecycle.getStatus();
    expect(first).toEqual({
      state: "recovery-disabled",
      code: "read-failed",
      since: envelope.timestamp,
    });
    vi.advanceTimersByTime(serviceLogSampleIntervalMs);
    lifecycle.recoveryDisabled("decode-failed");
    expect(lifecycle.getStatus()).toBe(first);
    const records = lines.map((line) =>
      z.record(z.string(), z.unknown()).parse(JSON.parse(line)),
    );
    expect(
      records.filter(
        (record) => record.event === "recovery-persistence-disabled",
      ),
    ).toEqual([
      {
        ...envelope,
        event: "recovery-persistence-disabled",
        code: "read-failed",
      },
    ]);
    expect(records.at(-1)?.event).toBe("memory");
    failWrites = true;
    vi.advanceTimersByTime(serviceLogSampleIntervalMs);
    expect(lifecycle.getStatus()).toMatchObject({
      state: "failed",
      code: "sink-write-failed",
    });
    lifecycle.close();
  });

  it("latches a periodic write fault once, with stable code/time and no retries", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T00:00:00.000Z"));
    let failWrites = false;
    const writeLine = vi.fn(() => {
      if (failWrites) throw new Error("synthetic-private-periodic-cause");
    });
    const close = vi.fn();
    const readMemory = vi.fn(() => ({ rss: 300, heap }));
    const lifecycle = createServiceLogLifecycle({
      pid: 123,
      version: "source",
      directory: "/owned-fixture",
      openWriter: () => ({ writeLine, close }),
      readMemory,
    });
    lifecycle.ready("fixture-service");
    failWrites = true;
    expect(() =>
      vi.advanceTimersByTime(serviceLogSampleIntervalMs),
    ).not.toThrow();
    const first = lifecycle.getStatus();
    expect(first).toEqual({
      state: "failed",
      code: "sink-write-failed",
      since: "2026-10-18T00:05:00.000Z",
    });
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    lifecycle.ready("fixture-service");
    lifecycle.failure(localFailureMetadata("fixture", new Error("private")));
    lifecycle.stopping("SIGTERM");
    lifecycle.close();
    expect(lifecycle.getStatus()).toBe(first);
    expect(readMemory).toHaveBeenCalledTimes(1);
    expect(writeLine).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first)).not.toContain("private");
  });

  it("classifies opening and closing failures without throwing", () => {
    const base = {
      pid: 123,
      version: "source",
      directory: "/owned-fixture",
      readMemory: () => ({ rss: 300, heap }),
    };
    expect(
      createServiceLogLifecycle({
        ...base,
        openWriter() {
          throw new Error("private-open");
        },
      }).getStatus(),
    ).toMatchObject({ state: "failed", code: "sink-open-failed" });
    const closing = createServiceLogLifecycle({
      ...base,
      openWriter: () => ({
        writeLine: vi.fn<(line: string) => void>(),
        close() {
          throw new Error("private-close");
        },
      }),
    });
    expect(() => {
      closing.close();
    }).not.toThrow();
    expect(closing.getStatus()).toMatchObject({
      state: "failed",
      code: "sink-close-failed",
    });
  });
  it("writes versioned startup/ready/observed stop and closes its single sampler", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-18T00:00:00.000Z"));
    const lines: string[] = [];
    const closeWriter = vi.fn();
    const readMemory = vi.fn(() => ({ rss: 300, heap }));
    const lifecycle = createServiceLogLifecycle({
      pid: 123,
      version: "source",
      directory: "/owned-fixture",
      openWriter: () => ({
        writeLine: (line) => {
          lines.push(line);
        },
        close: closeWriter,
      }),
      readMemory,
    });
    lifecycle.ready("fixture-service");
    lifecycle.ready("fixture-service");
    expect(vi.getTimerCount()).toBe(1);
    lifecycle.stopping("SIGTERM");
    lifecycle.stopping("SIGINT");
    expect(vi.getTimerCount()).toBe(0);
    lifecycle.close();
    lifecycle.close();
    expect(closeWriter).toHaveBeenCalledTimes(1);
    expect(readMemory).not.toHaveBeenCalled();
    expect(lines.map((line) => z.json().parse(JSON.parse(line)))).toEqual([
      { ...envelope, event: "starting" },
      { ...envelope, event: "ready", serviceId: "fixture-service" },
      { ...envelope, event: "stopping", reason: "SIGTERM" },
      { ...envelope, event: "stopped", reason: "SIGTERM" },
    ]);
  });

  it("does not invent SIGKILL/OOM causes on an unobserved close", () => {
    const lines: string[] = [];
    const closeWriter = vi.fn();
    const lifecycle = createServiceLogLifecycle({
      pid: 123,
      version: "source",
      directory: "/owned-fixture",
      openWriter: () => ({
        writeLine: (line) => {
          lines.push(line);
        },
        close: closeWriter,
      }),
      readMemory: () => ({ rss: 300, heap }),
    });
    lifecycle.close();
    expect(lines).toHaveLength(1);
    expect(closeWriter).toHaveBeenCalledOnce();
  });

  it("latches an initial write failure without throwing and closes once", () => {
    const failure = new Error("synthetic-start-write-failure");
    const closeWriter = vi.fn();
    const lifecycle = createServiceLogLifecycle({
      pid: 123,
      version: "source",
      directory: "/owned-fixture",
      openWriter: () => ({
        writeLine() {
          throw failure;
        },
        close: closeWriter,
      }),
      readMemory: () => ({ rss: 300, heap }),
    });
    expect(lifecycle.getStatus()).toMatchObject({
      state: "failed",
      code: "sink-write-failed",
    });
    lifecycle.ready("fixture-service");
    lifecycle.close();
    expect(closeWriter).toHaveBeenCalledOnce();
  });

  it("preserves the first write code/time when disposal also fails", () => {
    const writeFailure = new Error("synthetic-final-write-failure");
    const closeFailure = new Error("synthetic-close-failure");
    let failWrites = false;
    const lifecycle = createServiceLogLifecycle({
      pid: 123,
      version: "source",
      directory: "/owned-fixture",
      openWriter: () => ({
        writeLine() {
          if (failWrites) throw writeFailure;
        },
        close() {
          throw closeFailure;
        },
      }),
      readMemory: () => ({ rss: 300, heap }),
    });
    lifecycle.stopping("SIGTERM");
    failWrites = true;
    expect(() => {
      lifecycle.close();
    }).not.toThrow();
    expect(lifecycle.getStatus()).toMatchObject({
      state: "failed",
      code: "sink-write-failed",
    });
    const first = lifecycle.getStatus();
    lifecycle.close();
    lifecycle.failure(localFailureMetadata("fixture.failure", closeFailure));
    expect(lifecycle.getStatus()).toBe(first);
  });
});

describe("drain-timeout record", () => {
  it("names at most 32 unfinished owners with their total, synchronously", () => {
    const lines: string[] = [];
    const lifecycle = createServiceLogLifecycle({
      pid: 123,
      version: "source",
      directory: "/owned-fixture",
      openWriter: () => ({
        writeLine: (line) => {
          lines.push(line);
        },
        close: () => undefined,
      }),
      readMemory: () => ({ rss: 300, heap }),
    });
    const owners = Array.from(
      { length: 40 },
      (_, index) => "agent-" + String(index),
    );
    lifecycle.drainTimeout({
      deadlineMs: 4_000,
      phase: "owners",
      unfinishedOwners: owners,
    });
    const record = z
      .object({
        event: z.literal("drain-timeout"),
        deadlineMs: z.number(),
        phase: z.string(),
        unfinishedOwners: z.array(z.string()),
        unfinishedOwnerCount: z.number(),
      })
      .parse(JSON.parse(lines.at(-1) ?? ""));
    expect(record.unfinishedOwners).toEqual(owners.slice(0, 32));
    expect(record.unfinishedOwnerCount).toBe(40);
    expect(record.phase).toBe("owners");
    lifecycle.close();
  });
});

describe("service log record contract", () => {
  it("retains both complete type-count maps in a memory observation above 16 KiB and below 32 KiB", () => {
    // Representative of the original service's 228–231 reported types;
    // synthetic labels/counts, never a copy of a private diagnostic record.
    const record = memoryRecord(230);
    const originalBytes = Buffer.byteLength(JSON.stringify(record) + "\n");
    expect(originalBytes).toBeGreaterThan(16_384);
    expect(originalBytes).toBeLessThan(32_768);
    const line = encodeServiceLogRecord(record);
    expect(line.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(line)).toBe(originalBytes);
    expect(JSON.parse(line)).toEqual(record);
  });

  it("explicitly omits both whole type-count maps above 32 KiB without slicing JSON", () => {
    const record = memoryRecord(650);
    const originalBytes = Buffer.byteLength(JSON.stringify(record) + "\n");
    expect(originalBytes).toBeGreaterThan(32_768);
    const line = encodeServiceLogRecord(record);
    expect(line.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(32_768);
    expect(JSON.parse(line)).toEqual({
      ...record,
      heap: {
        ...record.heap,
        objectTypeCounts: {
          status: "omitted-byte-bound",
          typeCount: 650,
          allocatedCells: 211_575,
        },
        protectedObjectTypeCounts: {
          status: "omitted-byte-bound",
          typeCount: 650,
          allocatedCells: 650,
        },
      },
      omittedRecordBytes: originalBytes,
    });
  });

  it("round trips every maintained count, without a top-N projection", () => {
    const line = encodeServiceLogRecord({
      ...envelope,
      event: "memory",
      rss: 300,
      heap,
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(serviceLogRecordBytes);
    expect(JSON.parse(line)).toEqual({
      ...envelope,
      event: "memory",
      rss: 300,
      heap,
    });
  });

  it("persists only the shared failure projection, not text/stack/nested causes", () => {
    const marker = "synthetic-private-provider-response";
    const cause = new Error(marker, { cause: new Error(marker) });
    const line = encodeServiceLogRecord({
      ...envelope,
      event: "failure",
      failure: localFailureMetadata("fixture.operation", cause),
    });
    expect(line).not.toContain(marker);
    expect(JSON.parse(line)).toEqual({
      ...envelope,
      event: "failure",
      failure: {
        source: "local-runtime",
        operation: "fixture.operation",
        failureKind: "Error",
      },
    });
  });

  it("replaces an oversized UTF-8 record with explicit parseable metadata", () => {
    const line = encodeServiceLogRecord({
      ...envelope,
      event: "failure",
      failure: localFailureMetadata("é".repeat(serviceLogRecordBytes), 123),
    });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(serviceLogRecordBytes);
    expect(JSON.parse(line)).toMatchObject({
      event: "record-omitted",
      recordEvent: "failure",
    });
    expect(line).not.toContain("é");
  });
});

describe("service-owned five-minute sampler", () => {
  it("has exactly one timer, no early sample, and idempotent cleanup", () => {
    vi.useFakeTimers();
    const readMemory = vi.fn(() => ({ rss: 300, heap }));
    const emit = vi.fn();
    const sampler = createServiceLogSampler({ readMemory, emit });
    sampler.start();
    sampler.start();
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(serviceLogSampleIntervalMs - 1);
    expect(readMemory).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(readMemory).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenLastCalledWith({ event: "memory", rss: 300, heap });
    vi.advanceTimersByTime(serviceLogSampleIntervalMs);
    expect(readMemory).toHaveBeenCalledTimes(2);
    sampler.close();
    sampler.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(serviceLogSampleIntervalMs);
    expect(readMemory).toHaveBeenCalledTimes(2);
    expect(() => {
      sampler.start();
    }).toThrow("disposed");
  });

  it("reports unavailable statistics without fake zeros or private text", () => {
    vi.useFakeTimers();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const emit = vi.fn();
    const sampler = createServiceLogSampler({
      readMemory() {
        throw new Error("synthetic-private-sampling-failure");
      },
      emit,
    });
    sampler.start();
    try {
      vi.advanceTimersByTime(serviceLogSampleIntervalMs);
      expect(emit).toHaveBeenCalledExactlyOnceWith({
        event: "memory-unavailable",
        failure: {
          source: "local-runtime",
          operation: "service-log.sample",
          failureKind: "Error",
        },
      });
      expect(JSON.stringify(emit.mock.calls)).not.toContain(
        "synthetic-private-sampling-failure",
      );
    } finally {
      sampler.close();
    }
  });

  it("does not swallow a writer failure or misreport it as unavailable heap", () => {
    vi.useFakeTimers();
    const failure = new Error("synthetic-file-write-failure");
    const emit = vi.fn(() => {
      throw failure;
    });
    const sampler = createServiceLogSampler({
      readMemory: () => ({ rss: 300, heap }),
      emit,
    });
    sampler.start();
    try {
      expect(() => vi.advanceTimersByTime(serviceLogSampleIntervalMs)).toThrow(
        failure,
      );
      expect(emit).toHaveBeenCalledTimes(1);
    } finally {
      sampler.close();
    }
  });
});
