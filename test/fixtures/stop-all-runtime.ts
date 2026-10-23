import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Shiitake, type RuntimeHost } from "@fungi.computer/shiitake";
import { fauxModel, type FauxModel } from "@fungi.computer/mule/testing";
import { rejectingSandbox } from "@fungi.computer/mycelium/testing";
import type { OpenLocalServiceRuntime } from "../../src/private-local-service-owner.js";
import { createPrivateSqliteOwner } from "../../src/private-sqlite-owner.js";
import {
  fixtureEffectiveModel,
  fixtureMailControls,
  fixtureModelControls,
} from "./effective-model.js";

/** Real persisted Sessions; default to queued work, or supply a live runtime/model. */
export function stopAllRuntime(
  onAbort: (agentId: string) => void,
  liveFor?: (agentId: string) =>
    | {
        model: FauxModel;
        runtime: RuntimeHost;
        close: () => Promise<void>;
      }
    | undefined,
): OpenLocalServiceRuntime {
  return async (options) => {
    if (options.databasePath === undefined) throw new Error("Expected store");
    const database = new DatabaseSync(options.databasePath);
    const agentId = basename(dirname(options.databasePath));
    const live = liveFor?.(agentId);
    const faux = live?.model ?? fauxModel([]);
    const agent = await Shiitake.make({
      model: {
        acquire: () =>
          Promise.resolve({
            model: faux.model,
            retryable: () => false,
            stream: faux.stream,
            release: () => Promise.resolve(),
          }),
      },
      store: createPrivateSqliteOwner(database),
      extensions: { roster: [], grants: [] },
      tools: {
        modules: [],
        sandbox: rejectingSandbox("Stop-all proof has no tools"),
      },
      runtime: live?.runtime ?? {
        bind: () =>
          Promise.resolve({
            commit: (mutation) => mutation(),
            requestWake: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
      },
      instructions: {
        load: () =>
          Promise.resolve({
            revision: "test",
            text: "Complete the stop-all proof without tools.",
          }),
      },
    });
    return {
      databasePath: options.databasePath,
      agentId,
      name: agentId,
      getSession: (id) => {
        const session = agent.session(id);
        return {
          ...session,
          abort: async () => {
            onAbort(agentId);
            return session.abort();
          },
        };
      },
      listSessions: agent.listSessions,
      createSession: agent.createSession,
      deleteSession: agent.deleteSession,
      extensions: agent.extensions,
      effectiveModel: fixtureEffectiveModel,
      ...fixtureModelControls,
      ...fixtureMailControls,
      bindSessionPath: () => true,
      close: async () => {
        await agent.close();
        await live?.close();
        database.close();
      },
    };
  };
}
