import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Shiitake } from "@fungi.computer/shiitake";
import { fauxModel } from "@fungi.computer/mule/testing";
import { almanacExtension } from "@fungi.computer/shiitake-extensions/almanac/host";
import { loopExtension } from "@fungi.computer/shiitake-extensions/loop/host";
import { createPrivateSqliteOwner } from "../../src/private-sqlite-owner.js";
import type { OpenLocalServiceRuntime } from "../../src/private-local-service-owner.js";
import {
  fixtureEffectiveModel,
  fixtureMailControls,
  fixtureModelControls,
} from "./effective-model.js";

/** Durable extension owners; accepted work stays queued for an explicit turn. */
export async function openScheduleAgent(databasePath: string) {
  const database = new DatabaseSync(databasePath);
  const faux = fauxModel([]);
  const roster = [almanacExtension, loopExtension];
  const agent = await Shiitake.make({
    store: createPrivateSqliteOwner(database),
    extensions: {
      roster,
      grants: roster.map(({ manifest }) => ({
        id: manifest.id,
        capabilities: manifest.requests,
      })),
    },
    runtime: {
      bind: () =>
        Promise.resolve({
          commit: (mutation) => mutation(),
          requestWake: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
    },
    instructions: {
      load: () => Promise.resolve({ revision: "schedules", text: "Fixture" }),
    },
    model: {
      acquire: () =>
        Promise.resolve({
          model: faux.model,
          stream: faux.stream,
          retryable: faux.retryable,
          release: () => Promise.resolve(),
        }),
    },
  });
  return {
    agent,
    // Match the Local runtime host's retained archive flag write.
    setArchived: (archived: boolean) => {
      database
        .prepare(
          "UPDATE private_local_identity SET archived = ? WHERE singleton = 1",
        )
        .run(archived ? 1 : 0);
    },
    close: async () => {
      await agent.close();
      database.close();
    },
  };
}

/** The ordinary Local runtime opener backed by those same durable owners. */
export const openScheduleRuntime: OpenLocalServiceRuntime = async (options) => {
  const databasePath = options.databasePath;
  if (databasePath === undefined) throw new Error("Expected retained store");
  const host = await openScheduleAgent(databasePath);
  return {
    databasePath,
    agentId: basename(dirname(databasePath)),
    name: "Retained Agent",
    getSession: host.agent.session,
    listSessions: host.agent.listSessions,
    createSession: host.agent.createSession,
    deleteSession: host.agent.deleteSession,
    extensions: host.agent.extensions,
    effectiveModel: fixtureEffectiveModel,
    ...fixtureModelControls,
    ...fixtureMailControls,
    setArchived: host.setArchived,
    bindSessionPath: () => true,
    close: host.close,
  };
};
