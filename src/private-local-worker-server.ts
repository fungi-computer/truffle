import { logEvent } from "./log-event.js";
import {
  fungiMcpSelectionSchema,
  readFungiMcpSelection,
} from "./private-fungi-mcp-selection.js";
import type { PrivateLocalShiitakeWorkerInput } from "./private-local-shiitake-host.js";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { dirname, resolve } from "node:path";
import { z } from "zod";

import type { PrivateLocalShiitakeWorkerBatch } from "./private-local-shiitake-host.js";
import type { openPrivateLocalBunShiitakeWorkerBatch } from "./private-bun-shiitake-host.js";

const reasoningSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const ownerSchema = z.strictObject({
  invocationRoot: z.string().min(1),
  databasePath: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  reasoning: reasoningSchema.optional(),
  fungiMcp: fungiMcpSelectionSchema.optional(),
});
const workerSchema = z.strictObject({
  name: z.string(),
  owner: ownerSchema,
});
const workersSchema = z.array(workerSchema).min(1);

export type ShutdownSignal = "SIGINT" | "SIGTERM";
export type Signals = Readonly<{
  on: (signal: ShutdownSignal, listener: () => void) => void;
  off: (signal: ShutdownSignal, listener: () => void) => void;
}>;
export type Output = Pick<NodeJS.WritableStream, "write">;
export type OpenWorkerBatch = typeof openPrivateLocalBunShiitakeWorkerBatch;

export type PrivateLocalWorkerServerIo = Readonly<{
  cwd: string;
  stdout?: Output | undefined;
  signals?: Signals | undefined;
}>;

function parseWorkers(value: unknown, filePath: string) {
  const decoded = workersSchema.safeParse(value);
  if (!decoded.success) throw new Error("Invalid workers file: " + filePath);
  const root = dirname(filePath);
  return decoded.data.map(({ name, owner }) => ({
    name,
    owner: {
      ...owner,
      invocationRoot: resolve(root, owner.invocationRoot),
    },
  }));
}

async function readWorkers(filePath: string, cwd: string) {
  const absolutePath = resolve(cwd, filePath);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(absolutePath, "utf8"));
  } catch (cause) {
    throw new Error("Could not read workers file: " + absolutePath, { cause });
  }
  const workers: PrivateLocalShiitakeWorkerInput[] = [];
  for (const { name, owner } of parseWorkers(value, absolutePath)) {
    const { fungiMcp, ...local } = owner;
    let configured: PrivateLocalShiitakeWorkerInput["owner"] = local;
    if (fungiMcp !== undefined)
      configured = {
        ...configured,
        fungiMcp: readFungiMcpSelection(fungiMcp),
      };
    workers.push({ name, owner: configured });
  }
  return workers;
}

function asFailure(cause: unknown, message: string): Error {
  return cause instanceof Error ? cause : new Error(message, { cause });
}

function readyRecord(batch: PrivateLocalShiitakeWorkerBatch) {
  return JSON.stringify({
    status: "ready",
    baseUrl: batch.baseUrl,
    workers: batch.workers.map(({ name, routePath, databasePath }) => ({
      name,
      routePath,
      databasePath,
    })),
  });
}

/** Retained explicit static worker batch; ordinary clients use the persistent manager. */
export async function runPrivateLocalWorkerServer(
  workersFile: string,
  listen: string,
  io: PrivateLocalWorkerServerIo,
  openBatch: OpenWorkerBatch = async (...args) => {
    const { openPrivateLocalBunShiitakeWorkerBatch } =
      await import("./private-bun-shiitake-host.js");
    return openPrivateLocalBunShiitakeWorkerBatch(...args);
  },
): Promise<void> {
  const workers = await readWorkers(workersFile, io.cwd);
  const stdout = io.stdout ?? process.stdout;
  const signals = io.signals ?? process;
  const stopped = Promise.withResolvers<undefined>();
  const stop = { requested: false };
  let batch: Awaited<ReturnType<OpenWorkerBatch>> | undefined;
  let initiating: Error | undefined;
  let closeFailure: Error | undefined;
  const onSignal = () => {
    if (stop.requested) return;
    stop.requested = true;
    stopped.resolve(undefined);
  };
  signals.on("SIGINT", onSignal);
  signals.on("SIGTERM", onSignal);
  try {
    try {
      batch = await openBatch(workers, listen);
      if (!stop.requested) {
        try {
          stdout.write(readyRecord(batch) + "\n");
        } catch (cause) {
          logEvent("worker-server.ready-output", cause);
          initiating = asFailure(cause, "Worker server ready output failed");
        }
      }
      if (initiating === undefined) await stopped.promise;
    } catch (cause) {
      logEvent("worker-server.opening", cause);
      initiating = asFailure(cause, "Worker server opening failed");
    }
    if (batch !== undefined) {
      try {
        await batch.close();
      } catch (cause) {
        logEvent("worker-server.close", cause);
        closeFailure = asFailure(cause, "Worker server close failed");
      }
    }
  } finally {
    signals.off("SIGINT", onSignal);
    signals.off("SIGTERM", onSignal);
  }
  if (initiating !== undefined && closeFailure !== undefined)
    throw new AggregateError(
      [initiating, closeFailure],
      "Worker server startup and close failed",
    );
  if (initiating !== undefined) throw initiating;
  if (closeFailure !== undefined) throw closeFailure;
}
