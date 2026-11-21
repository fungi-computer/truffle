// The Local service as `fungi` runs it: a supervisor on the main thread and the
// listener in a worker, relayed SIGTERM by message. The worker holds a live
// Miniflare, as it does while a sandboxed command runs.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker, isMainThread } from "node:worker_threads";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { runPrivateLocalService } from "../../src/private-local-service-listener.js";
import { runPrivateLocalServiceProcess } from "../../src/private-local-service-supervisor.js";
import { runLocalServiceWorker } from "../../src/private-local-service-worker-host.js";

const directory = process.argv[2];
if (directory === undefined) throw new Error("Missing fixture directory");
if (isMainThread) {
  const heartbeat = new SharedArrayBuffer(24);
  const worker = new Worker(new URL(import.meta.url), {
    argv: [directory],
    workerData: { directory, heartbeat, heartbeatIntervalMs: 25 },
  });
  await runPrivateLocalServiceProcess(directory, {
    worker,
    heartbeat,
    startupMs: 10_000,
  });
} else {
  await runLocalServiceWorker(async (service, _observe, ready) => {
    // FIXTURE_START_DELAY_MS holds the listener back from starting, so a test
    // can stop the process in the window before it is ready.
    const startDelay = Number(process.env.FIXTURE_START_DELAY_MS ?? 0);
    if (startDelay > 0) {
      await mkdir(service, { recursive: true });
      await writeFile(join(service, "..", "starting"), "");
      await delay(startDelay);
    }
    const sandbox = new Miniflare(
      convertV4MiniflareOptions({
        modules: [
          {
            type: "ESModule",
            path: "worker.mjs",
            contents: "export default { fetch: () => new Response('ok') };",
          },
        ],
        compatibilityDate: "2026-09-02",
        cf: false,
      }),
    );
    await sandbox.ready;
    try {
      await runPrivateLocalService(
        service,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ready,
      );
    } finally {
      await sandbox.dispose();
    }
  });
}
