import { Worker, isMainThread } from "node:worker_threads";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { runPrivateLocalService } from "../../src/private-local-service-listener.js";
import { runPrivateLocalServiceProcess } from "../../src/private-local-service-supervisor.js";
import { runLocalServiceWorker } from "../../src/private-local-service-worker-host.js";
import { createPrivateLocalModelSource } from "../../src/private-local-runtime-host.js";

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
    stallMs: 200,
    startupMs: 10_000,
  });
} else {
  await runLocalServiceWorker((directory, observe, ready) => {
    const models = createModels();
    const faux = fauxProvider({
      provider: "watchdog-fixture",
      models: [{ id: "probe" }],
    });
    faux.setResponses([
      async (_context, options, _state, model) => {
        await options?.onProviderStreamEvent?.(
          { type: "response.output_text.delta", delta: "raw-fixture-marker" },
          model,
        );
        return fauxAssistantMessage("fixture-stream-marker");
      },
    ]);
    models.setProvider(faux.provider);
    const source = createPrivateLocalModelSource(
      models,
      "watchdog-fixture",
      "probe",
      "watchdog-fixture",
      undefined,
      undefined,
      observe,
    );
    return runPrivateLocalService(
      directory,
      undefined,
      async () => {
        const lease = await source.acquire({
          sessionId: "fixture",
          preference: null,
          signal: new AbortController().signal,
        });
        if (lease.stream === undefined)
          throw new Error("Missing fixture provider stream");
        const stream = await lease.stream(lease.model, {
          messages: [{ role: "user", content: "fixture prompt", timestamp: 1 }],
        });
        for await (const event of stream) {
          if (event.type === "text_delta") {
            // Deliberately endless. Nothing on this event loop can arrange exit.
            for (;;) Math.sqrt(2);
          }
        }
        throw new Error("The fixture did not produce a text delta");
      },
      undefined,
      undefined,
      undefined,
      undefined,
      observe,
      ready,
    );
  });
}
