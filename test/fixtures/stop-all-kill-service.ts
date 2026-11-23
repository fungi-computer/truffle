// An owned child process: the real Local service over durable Agent stores.
// `kill` mode blocks every turn and SIGKILLs this process right after the
// middle Agent's cancellation is accepted, so a stop dies half done. `recover`
// mode reopens the same stores with a model that answers at once, so any turn
// recovery resumes shows up as a reply.
import { z } from "zod";
import { fauxModel } from "@fungi.computer/mule/testing";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { nodeRuntimeHost } from "@fungi.computer/shiitake/node";
import { runPrivateLocalService } from "../../src/private-local-service-listener.js";
import { stopAllRuntime } from "./stop-all-runtime.js";

const [directory, mode] = z
  .tuple([z.string(), z.enum(["kill", "recover"])])
  .parse(process.argv.slice(2));

await runPrivateLocalService(
  directory,
  stopAllRuntime(
    () => undefined,
    () => {
      const host = nodeRuntimeHost(() => undefined);
      const model = fauxModel([
        mode === "recover"
          ? () => fauxAssistantMessage("Recovered after restart")
          : async (_context, options) => {
              const signal = options?.signal;
              if (signal === undefined)
                throw new Error("Expected model abort signal");
              await new Promise<void>((resolve) => {
                if (signal.aborted) resolve();
                else
                  signal.addEventListener(
                    "abort",
                    () => {
                      resolve();
                    },
                    { once: true },
                  );
              });
              return fauxAssistantMessage("", { stopReason: "aborted" });
            },
      ]);
      return { model, runtime: host.runtime, close: host.close };
    },
    (agentId) => {
      if (mode === "kill" && agentId === "child")
        process.kill(process.pid, "SIGKILL");
    },
  ),
);
