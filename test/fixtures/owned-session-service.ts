// The real Local service listener, owning one Shiitake Agent store, run as its
// own process. In "hang" mode the Agent's close never settles, so SIGTERM
// starts a drain that cannot finish: the shape of client-surfaces-v1-68.
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
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

const [directory, databasePath, mode] = z
  .tuple([z.string().min(1), z.string().min(1), z.enum(["hang", "drain"])])
  .parse(process.argv.slice(2));

// Report the moment SIGTERM arrives, so the test measures the grace from it.
process.on("SIGTERM", () => {
  process.stdout.write(`sigterm ${String(Date.now())}\n`);
});

await runPrivateLocalService(await serviceDirectory(directory), async () => {
  const database = new DatabaseSync(databasePath);
  const agent = await Shiitake.make({
    store: createPrivateSqliteOwner(database),
    extensions: { roster: [], grants: [] },
    runtime: createPrivateLocalRuntimeHost(),
    instructions: {
      load: () => Promise.resolve({ revision: "stop", text: "Answer" }),
    },
    model: {
      acquire: () => Promise.reject(new Error("This fixture runs no turns")),
    },
  });
  return {
    databasePath,
    agentId: "stop-agent",
    getSession: agent.session,
    listSessions: agent.listSessions,
    createSession: agent.createSession,
    deleteSession: agent.deleteSession,
    extensions: agent.extensions,
    effectiveModel: fixtureEffectiveModel,
    ...fixtureModelControls,
    ...fixtureMailControls,
    name: "stop-agent",
    bindSessionPath: () => true,
    close:
      mode === "hang"
        ? () => new Promise<void>(() => undefined)
        : async () => {
            await agent.close();
            database.close();
          },
  };
});
