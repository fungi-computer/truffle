// A real service and workerd sandbox, with only reply transport refused during
// the first process. The restarted process has the ordinary working transport.
import { mock } from "bun:test";
import * as Effect from "effect/Effect";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { z } from "zod";
import * as mail from "../../dist/private-local-mail.js";

const [directory, parentPath, childId, phase] = z
  .tuple([z.string(), z.string(), z.string(), z.enum(["withhold", "deliver"])])
  .parse(process.argv.slice(2));
const makeMailRoom = mail.createPrivateLocalMailRoom;
let refused = false;
let reported = false;
await mock.module("../../dist/private-local-mail.js", () => ({
  ...mail,
  createPrivateLocalMailRoom: (
    database: Parameters<typeof makeMailRoom>[0],
    options: Parameters<typeof makeMailRoom>[1],
  ) => {
    const room = makeMailRoom(database, {
      ...options,
      deliver: (message) => {
        if (phase === "deliver") return options.deliver(message);
        refused = true;
        return Promise.reject(new Error("Test-owned parent is unreachable"));
      },
    });
    return {
      ...room,
      drainOutbox: () =>
        room.drainOutbox().pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (refused && !reported) {
                reported = true;
                process.send?.("retry-persisted");
              }
            }),
          ),
        ),
    };
  },
}));
const { runPrivateLocalService } =
  await import("../../dist/private-local-service-listener.js");
const { openPrivateLocalRuntimeHost } =
  await import("../../dist/private-local-runtime-host.js");
const { serviceDirectory } =
  await import("../../dist/private-local-service-discovery.js");
const models = createModels();
const parent = fauxProvider({
  provider: "faux-parent",
  models: [{ id: "parent-model", name: "Parent" }],
});
const child = fauxProvider({
  provider: "faux-child",
  models: [{ id: "child-model", name: "Child" }],
});
parent.setResponses(
  phase === "withhold"
    ? [
        fauxAssistantMessage(
          fauxToolCall("execute", {
            code: `async () => agents.send({ agentId: ${JSON.stringify(childId)}, sessionId: "main", requestId: "find-answer", text: "Find the answer", delivery: "followUp" })`,
          }),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("Delegated; waiting"),
      ]
    : [
        () => {
          process.send?.("reply-received");
          return fauxAssistantMessage("Reply received");
        },
      ],
);
child.setResponses([fauxAssistantMessage("Child result")]);
models.setProvider(parent.provider);
models.setProvider(child.provider);
await runPrivateLocalService(
  await serviceDirectory(directory),
  (options) => {
    const isParent = options.databasePath === parentPath;
    return openPrivateLocalRuntimeHost(
      {
        ...options,
        providerId: isParent ? "faux-parent" : "faux-child",
        modelId: isParent ? "parent-model" : "child-model",
      },
      models,
    );
  },
  undefined,
  undefined,
  3_600_000,
);
if (process.connected) process.disconnect();
