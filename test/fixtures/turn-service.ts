// The real Local service listener owning one Shiitake Agent store, run as its
// own process. In "hang" mode the model call never answers and the fixture
// marks that the turn reached it, so a test can SIGKILL the service mid-turn.
// In "answer" mode the model replies, so a restarted service can finish it.
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { fauxModel } from "@fungi.computer/mule/testing";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Shiitake } from "@fungi.computer/shiitake";
import { createPrivateSqliteOwner } from "../../src/private-sqlite-owner.js";
import { createPrivateLocalRuntimeHost } from "../../src/private-local-runtime-host.js";
import { runPrivateLocalService } from "../../src/private-local-service-listener.js";
import { serviceDirectory } from "../../src/private-local-service-discovery.js";
import {
  fixtureEffectiveModel,
  fixtureMailControls,
  fixtureModelControls,
} from "./effective-model.js";

const [directory, databasePath, mode, marker] = z
  .tuple([
    z.string().min(1),
    z.string().min(1),
    z.enum(["hang", "answer"]),
    z.string().min(1),
  ])
  .parse(process.argv.slice(2));

const faux = fauxModel([]);
faux.setResponses([fauxAssistantMessage("finished after the restart")]);

await runPrivateLocalService(await serviceDirectory(directory), async () => {
  const database = new DatabaseSync(databasePath);
  const agent = await Shiitake.make({
    store: createPrivateSqliteOwner(database),
    extensions: { roster: [], grants: [] },
    runtime: createPrivateLocalRuntimeHost(),
    instructions: {
      load: () => Promise.resolve({ revision: "kill", text: "Answer" }),
    },
    model: {
      acquire: () =>
        Promise.resolve({
          model: faux.model,
          retryable: () => false,
          stream: (model, context, options) => {
            if (mode === "answer") return faux.stream(model, context, options);
            writeFileSync(marker, "model-started");
            return new Promise<never>(() => undefined);
          },
          release: () => Promise.resolve(),
        }),
    },
  });
  return {
    databasePath,
    agentId: "kill-agent",
    getSession: agent.session,
    listSessions: agent.listSessions,
    createSession: agent.createSession,
    deleteSession: agent.deleteSession,
    extensions: agent.extensions,
    effectiveModel: fixtureEffectiveModel,
    ...fixtureModelControls,
    ...fixtureMailControls,
    name: "kill-agent",
    bindSessionPath: () => true,
    close: async () => {
      await agent.close();
      database.close();
    },
  };
});
