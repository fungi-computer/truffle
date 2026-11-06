import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";
import { runPrivateLocalService } from "./private-local-service-listener.js";
import { serviceDirectory } from "./private-local-service-discovery.js";
import { createServiceStreamCapture } from "./private-local-service-log.js";
import type { LocalModelStreamObserver } from "./private-local-service-trace.js";

const workerInputSchema = z.strictObject({
  directory: z.string().min(1),
  heartbeat: z
    .instanceof(SharedArrayBuffer)
    .refine((value) => value.byteLength === 24),
  heartbeatIntervalMs: z.number().int().positive().max(1000),
});

/** The listener remains the service owner. This adapter owns only thread IPC. */
export async function runLocalServiceWorker(
  serve: (
    directory: string,
    observe: LocalModelStreamObserver,
    ready: () => void,
  ) => Promise<void> = (directory, observe, ready) =>
    runPrivateLocalService(
      directory,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      observe,
      ready,
    ),
): Promise<void> {
  const input = workerInputSchema.parse(workerData);
  const port = parentPort;
  if (port === null)
    throw new Error("Local service worker needs its process owner");
  // Shared slots: heartbeat sequence, capture failure, listener readiness.
  const heartbeat = new BigInt64Array(input.heartbeat);
  const capture = createServiceStreamCapture(input.directory);
  if (capture.failed()) Atomics.store(heartbeat, 1, 1n);
  const onMessage = (message: unknown) => {
    process.emit(z.enum(["SIGTERM", "SIGINT"]).parse(message));
  };
  port.on("message", onMessage);
  const beat = () => Atomics.add(heartbeat, 0, 1n);
  beat();
  const timer = setInterval(beat, input.heartbeatIntervalMs);
  timer.unref();
  try {
    await serve(
      await serviceDirectory(input.directory),
      (record) => {
        capture.record(record);
        if (capture.failed()) Atomics.store(heartbeat, 1, 1n);
      },
      () => {
        beat();
        Atomics.store(heartbeat, 2, 1n);
      },
    );
  } finally {
    clearInterval(timer);
    capture.close();
    port.off("message", onMessage);
    port.close();
  }
}
