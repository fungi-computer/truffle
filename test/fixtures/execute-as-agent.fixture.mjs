// One faux Agent turn through Local's real tool composition: the Agent store's
// owner-enabled extensions, the real workerd execute sandbox, and HOME taken
// from the environment. Prints the execute tool result.
// Usage: bun execute-as-agent.fixture.mjs <project> <agent-store> <code>
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { fauxModel } from "@fungi.computer/mule/testing";
import { Shiitake } from "@fungi.computer/shiitake";
import {
  createPrivateLocalRuntimeHost,
  createPrivateLocalTools,
} from "../../dist/private-local-runtime-host.js";
import { createPrivateSqliteOwner } from "../../dist/private-sqlite-owner.js";

const [project, store, code] = process.argv.slice(2);
if (project === undefined || store === undefined || code === undefined)
  throw new Error("Usage: <project> <agent-store> <code>");
const tools = await createPrivateLocalTools(
  project,
  undefined,
  undefined,
  undefined,
  store,
);
const faux = fauxModel([]);
faux.setResponses([
  fauxAssistantMessage(fauxToolCall("execute", { code }), {
    stopReason: "toolUse",
  }),
  fauxAssistantMessage("done"),
]);
const database = new DatabaseSync(":memory:");
const agent = await Shiitake.make({
  store: createPrivateSqliteOwner(database),
  extensions: tools.extensions,
  runtime: createPrivateLocalRuntimeHost(),
  instructions: {
    load: () => Promise.resolve({ revision: "fixture", text: "Use tools." }),
  },
  model: {
    acquire: () =>
      Promise.resolve({
        model: faux.model,
        stream: faux.stream,
        release: () => Promise.resolve(),
      }),
  },
  tools: tools.tools,
});
try {
  const session = agent.session("main");
  await session.send("Use the tool.", { requestId: "fixture" });
  for (;;) {
    const snapshot = await session.read();
    const result = snapshot.messages.find(
      ({ value }) => value.role === "toolResult",
    );
    if (result !== undefined && snapshot.terminals.length > 0) {
      process.stdout.write(
        result.value.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join(""),
      );
      break;
    }
    await delay(20);
  }
} finally {
  await agent.close();
  database.close();
  await tools.processes.close();
}
