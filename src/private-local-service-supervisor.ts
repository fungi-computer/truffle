import { Worker } from "node:worker_threads";
import { Buffer } from "node:buffer";
import { constants } from "node:fs";
import { open, readdir, type FileHandle } from "node:fs/promises";
import { totalmem } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { privateLocalServiceVersion } from "./private-local-service-discovery.js";
import { logEvent } from "./log-event.js";
import { serviceTraceFileBytes } from "./private-local-service-trace.js";

// The CLI packer embeds its worker digest so worker-only changes also change
// cli.js's existing content-based service identity. Source launches stay source.
const workerDigest = z
  .string()
  .regex(/^(?:source|[a-f0-9]{64})$/u)
  .parse(process.env.FUNGI_SERVICE_WORKER_DIGEST ?? "source");

const mebibyte = 1024 * 1024;
/** The ordinary service holds about 250 MiB; a Local runaway reached 36 GiB. */
const defaultRssLimitBytes = Math.min(4096 * mebibyte, totalmem() / 2);
/** Exit code for a runaway-memory restart; 1 stays the stall and drain code. */
const privateLocalServiceRssExitCode = 75;
const policySchema = z.strictObject({
  stallMs: z.number().int().min(50).max(30_000).default(30_000),
  startupMs: z.number().int().min(50).max(60_000).default(60_000),
  /** Process resident size above which a sustained excess ends the service. */
  rssLimitBytes: z
    .number()
    .int()
    .min(64 * mebibyte)
    .default(Math.floor(defaultRssLimitBytes)),
  /** How long RSS must stay over the limit; a brief spike is not a runaway. */
  rssSustainMs: z.number().int().min(50).max(600_000).default(60_000),
});
const rssSampleLimit = 32;
const captureBudgetMs = 200;
type WatchdogReason =
  "event-loop-stall" | "startup-timeout" | "shutdown-timeout" | "rss-bound";
type RssSample = Readonly<{ atMs: number; rss: number }>;
type Capture =
  | Readonly<{ state: "pending" }>
  | Readonly<{
      state: "failed";
      code: "capture-write-failed" | "capture-sink-failed";
    }>
  | Readonly<{ state: "captured" | "empty"; file: string; bytes: number }>;
export type LocalServiceProcessOptions = Readonly<{
  stallMs?: number;
  startupMs?: number;
  rssLimitBytes?: number;
  rssSustainMs?: number;
}> &
  (
    | Readonly<{ worker: Worker; heartbeat: SharedArrayBuffer }>
    | Readonly<{ worker?: undefined; heartbeat?: undefined }>
  );

async function privateFile(file: FileHandle, maxBytes: number): Promise<void> {
  const stat = await file.stat();
  if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.size > maxBytes)
    throw new Error("Watchdog evidence is not a bounded private regular file");
}

/** Fixed owned files; completion is bounded by the independent exit timer. */
async function writePrivateEvidence(path: string, text: string): Promise<void> {
  const file = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await privateFile(file, serviceTraceFileBytes);
    await file.truncate(0);
    await file.writeFile(text, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Open descriptors of this process, or undefined where no fd directory exists. */
async function countOpenFds(): Promise<number | undefined> {
  for (const path of ["/proc/self/fd", "/dev/fd"]) {
    try {
      return (await readdir(path)).length;
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        continue;
      logEvent("service-watchdog.fd-count", cause);
      return undefined;
    }
  }
  return undefined;
}

/** Freeze a bounded tail under a name that normal post-restart logging never overwrites. */
async function readStreamCapture(directory: string): Promise<string> {
  const chunks: Buffer[] = [];
  for (let index = 3; index >= 0; index--) {
    const path = join(
      directory,
      `service-stream.jsonl${index === 0 ? "" : `.${String(index)}`}`,
    );
    let file;
    try {
      file = await open(path, constants.O_RDWR | constants.O_NOFOLLOW);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        continue;
      throw cause;
    }
    try {
      await privateFile(file, serviceTraceFileBytes / 4);
      chunks.push(await file.readFile());
      await file.sync();
    } finally {
      await file.close();
    }
  }
  const bytes = Buffer.concat(chunks);
  if (bytes.byteLength > serviceTraceFileBytes)
    throw new Error("Service capture exceeds its byte bound");
  return bytes.toString("utf8");
}

/**
 * Main runs no Agent work. The existing listener runs in one worker, retaining
 * the process PID, lease and discovery contract. Main-thread exit(1) ends even
 * a synchronously blocked worker, allowing a bounded asynchronous evidence window.
 */
export async function runPrivateLocalServiceProcess(
  directory: string,
  options: LocalServiceProcessOptions = {},
): Promise<void> {
  const policy = policySchema.parse({
    stallMs: options.stallMs,
    startupMs: options.startupMs,
    rssLimitBytes: options.rssLimitBytes,
    rssSustainMs: options.rssSustainMs,
  });
  const heartbeat = options.heartbeat ?? new SharedArrayBuffer(24);
  if (heartbeat.byteLength !== 24)
    throw new Error("Invalid service watchdog state size");
  // Shared slots: heartbeat sequence, capture failure, listener readiness.
  const state = new BigInt64Array(heartbeat);
  const worker =
    options.worker ??
    new Worker(new URL("./private-local-service-worker.mjs", import.meta.url), {
      workerData: {
        directory,
        heartbeat,
        heartbeatIntervalMs: Math.min(1000, Math.floor(policy.stallMs / 4)),
      },
    });
  const started = process.hrtime.bigint();
  let observedBeat = 0n;
  let lastProgressAt = started;
  let shuttingDownAt: bigint | undefined;
  // Newest samples, about one per second, kept for the RSS incident record.
  const rssSamples: RssSample[] = [];
  let lastSampleAt: bigint | undefined;
  let overSince: bigint | undefined;
  const version = privateLocalServiceVersion();
  const stop = (signal: "SIGINT" | "SIGTERM") => {
    shuttingDownAt ??= process.hrtime.bigint();
    worker.postMessage(signal);
  };
  const onInterrupt = () => {
    stop("SIGINT");
  };
  const onTerminate = () => {
    stop("SIGTERM");
  };
  const exit = (
    reason: WatchdogReason,
    lagMs: number,
    boundMs: number,
  ): void => {
    clearInterval(timer);
    const code = reason === "rss-bound" ? privateLocalServiceRssExitCode : 1;
    // Arm before starting evidence work. No I/O completion or worker cleanup
    // can postpone this exit; 200 ms also fits inside the shutdown grace.
    setTimeout(() => process.exit(code), captureBudgetMs);
    const preserve = async () => {
      const base = {
        source: "local-service",
        event: "watchdog-exit",
        reason,
        timestamp: new Date().toISOString(),
        pid: process.pid,
        version,
        workerDigest,
        lagMs,
        boundMs,
        captureBudgetMs,
        rssLimitBytes: policy.rssLimitBytes,
        rssSamples,
        openFds: await countOpenFds(),
        uptimeMs: Math.round(process.uptime() * 1000),
      };
      const manifest = join(directory, "watchdog-exit.json");
      const write = async (capture: Capture) => {
        await writePrivateEvidence(
          manifest,
          JSON.stringify({ ...base, capture }) + "\n",
        );
      };
      try {
        // Keep the reason even when capture I/O fails. Never claim missing evidence exists.
        await write({ state: "pending" });
        try {
          const stream = await readStreamCapture(directory);
          await writePrivateEvidence(
            join(directory, "watchdog-stream.jsonl"),
            stream,
          );
          await write(
            Atomics.load(state, 1) !== 0n
              ? { state: "failed", code: "capture-sink-failed" }
              : {
                  state: stream.length === 0 ? "empty" : "captured",
                  file: "watchdog-stream.jsonl",
                  bytes: Buffer.byteLength(stream),
                },
          );
        } catch (cause) {
          logEvent("service-watchdog.capture", cause);
          await write({ state: "failed", code: "capture-write-failed" });
        }
      } catch (cause) {
        logEvent("service-watchdog.evidence", cause);
      }
    };
    void preserve().then(
      () => {
        process.exit(code);
      },
      (cause: unknown) => {
        logEvent("service-watchdog.evidence", cause);
        process.exit(code);
      },
    );
  };
  let timer: ReturnType<typeof setInterval> | undefined;
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Local service worker exited (${String(code)})`));
      });
      timer = setInterval(
        () => {
          const now = process.hrtime.bigint();
          // Normal drain has its own budget; a tightened steady-state test bound
          // must not turn ordinary synchronous SQLite close into a stall incident.
          if (shuttingDownAt !== undefined) {
            const drainingMs = Number(now - shuttingDownAt) / 1e6;
            if (drainingMs > 4500) exit("shutdown-timeout", drainingMs, 4500);
            return;
          }
          const rss = process.memoryUsage.rss();
          if (
            lastSampleAt === undefined ||
            now - lastSampleAt >= 1_000_000_000n
          ) {
            lastSampleAt = now;
            rssSamples.push({
              atMs: Math.round(Number(now - started) / 1e6),
              rss,
            });
            if (rssSamples.length > rssSampleLimit) rssSamples.shift();
          }
          if (rss > policy.rssLimitBytes) {
            overSince ??= now;
            const overMs = Number(now - overSince) / 1e6;
            if (overMs >= policy.rssSustainMs)
              exit("rss-bound", overMs, policy.rssSustainMs);
          } else overSince = undefined;
          const last = Atomics.load(state, 0);
          if (last !== observedBeat) {
            observedBeat = last;
            lastProgressAt = now;
          }
          const ready = Atomics.load(state, 2) !== 0n;
          const lagMs = Number(now - (ready ? lastProgressAt : started)) / 1e6;
          const bound = ready ? policy.stallMs : policy.startupMs;
          if (lagMs > bound)
            exit(ready ? "event-loop-stall" : "startup-timeout", lagMs, bound);
        },
        Math.min(250, Math.floor(policy.stallMs / 4)),
      );
    });
  } finally {
    clearInterval(timer);
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onTerminate);
    await worker.terminate();
  }
}
