import { DatabaseSync } from "node:sqlite";
import { Shiitake } from "@fungi.computer/shiitake";
import { fauxModel } from "@fungi.computer/mule/testing";
import {
  createPrivateLocalRuntimeHost,
  createPrivateLocalTools,
} from "../../src/private-local-runtime-host.js";
import { createPrivateSqliteOwner } from "../../src/private-sqlite-owner.js";

/**
 * Assemble the real Local tools for one Agent store, open Shiitake over them,
 * and print what the roster holds. Run as its own process so the OS home the
 * host reads is the scratch home the test installed into.
 */
const [project, store] = process.argv.slice(2);
if (project === undefined || store === undefined)
  throw new Error("Usage: zookeeper-slot-probe <project> <store>");
const tools = await createPrivateLocalTools(
  project,
  undefined,
  undefined,
  undefined,
  store,
);
const faux = fauxModel([]);
const database = new DatabaseSync(":memory:");
const agent = await Shiitake.make({
  store: createPrivateSqliteOwner(database),
  extensions: tools.extensions,
  runtime: createPrivateLocalRuntimeHost(),
  instructions: {
    load: () => Promise.resolve({ revision: "slot", text: "Answer." }),
  },
  model: {
    acquire: () =>
      Promise.resolve({
        model: faux.model,
        retryable: () => false,
        stream: faux.stream,
        release: () => Promise.resolve(),
      }),
  },
});
console.log(
  JSON.stringify({
    roster: tools.extensions.roster.map(({ manifest }) => manifest.id),
    handoffHolders: tools.extensions.grants
      .filter(({ capabilities }) => capabilities.includes("compaction_handoff"))
      .map(({ id }) => id),
    opened: true,
  }),
);
await agent.close();
database.close();
await tools.processes.close();
