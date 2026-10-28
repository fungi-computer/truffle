import {
  readStoredAttention,
  readStoredSessionStates,
} from "@fungi.computer/shiitake/effect";
import type {
  SessionAttention,
  SessionSummaryRow,
} from "@fungi.computer/shiitake/client";
import { existsSync } from "node:fs";
import { basename, dirname } from "node:path";
import * as Effect from "effect/Effect";
import { z } from "zod";
import { logEvent } from "./log-event.js";
import {
  listPrivateLocalAgentStores,
  LocalStoreSchemaError,
  readPrivateLocalAgentProfile,
  unreadableStoreReason,
} from "./private-local-session-discovery.js";
import {
  createPrivateSqliteOwner,
  openPrivateReadOnlySqliteDatabase,
} from "./private-sqlite-owner.js";

/**
 * One Agent as the Board reads it from its store, without starting its runtime:
 * its conversations' stored state and the open attention of those that matter.
 */
export type BoardAgent = Readonly<{
  /** Stable identity of the Agent. */
  agentId: string;
  /** Display name; the id when the Agent has none. */
  name: string;
  /** Set when the Agent's store cannot be read, and why. */
  unreadable?: string;
  /**
   * Whether a live runtime holds the store. A conversation stored as running
   * in a store nobody holds was left behind by a runtime that stopped.
   */
  owned: boolean;
  /** Page one of its conversations, waiting ones first, then running, then settled. */
  sessions: readonly SessionSummaryRow[];
  /** Open attention of the conversations `attentionWanted` names. */
  attention: ReadonlyMap<string, readonly SessionAttention[]>;
}>;

/** Waiting conversations whose attention is read per Agent. */
export const maximumWaitingPerAgent = 4;

/**
 * Which conversations' attention to load: the newest one, whose state is the
 * Agent's lane, and the ones waiting on a person.
 */
export function attentionWanted(
  sessions: readonly SessionSummaryRow[],
): readonly string[] {
  const first = sessions[0];
  return [
    ...new Set([
      ...(first === undefined ? [] : [first.sessionId]),
      ...sessions
        .filter((row) => row.state === "needs_you")
        .slice(0, maximumWaitingPerAgent)
        .map((row) => row.sessionId),
    ]),
  ];
}

/** SQLite's "database is locked" result code, from node:sqlite or bun:sqlite. */
const sqliteBusy = 5;

/**
 * Whether a live runtime holds this store. A runtime holds an exclusive
 * transaction on the store's `.owner.sqlite` sidecar for as long as its
 * process lives, so a reader that is refused at once has found a live owner,
 * and one that reads the sidecar has found none. Nothing is written.
 */
export function storeIsOwned(databasePath: string): boolean {
  const sidecar = `${databasePath}.owner.sqlite`;
  if (!existsSync(sidecar)) return false;
  let database: ReturnType<typeof openPrivateReadOnlySqliteDatabase>;
  try {
    database = openPrivateReadOnlySqliteDatabase(sidecar, 0);
  } catch (cause) {
    if (busy(cause)) return true;
    throw cause;
  }
  try {
    database.prepare("SELECT count(*) FROM sqlite_master").all();
    return false;
  } catch (cause) {
    if (busy(cause)) return true;
    throw cause;
  } finally {
    database.close();
  }
}

/** node:sqlite names the result code `errcode`, bun:sqlite `errno`. */
const sqliteFailure = z.looseObject({
  errcode: z.number().optional(),
  errno: z.number().optional(),
});

function busy(cause: unknown): boolean {
  const failure = sqliteFailure.safeParse(cause);
  return (
    failure.success &&
    (failure.data.errcode ?? failure.data.errno) === sqliteBusy
  );
}

/**
 * One Agent as the Board sees it, read from its store alone: no runtime starts,
 * so reading every Agent every few seconds costs file reads, not Agents.
 * The run state is as the Agent's runtime last wrote it. A store that cannot
 * be read is an unavailable Agent with the reason, never an idle one. An
 * archived Agent is not on the board.
 */
export async function readBoardAgent(
  agentId: string,
  databasePath: string,
): Promise<BoardAgent | undefined> {
  const none = new Map<string, readonly SessionAttention[]>();
  let name: string;
  let owned: boolean;
  try {
    const profile = readPrivateLocalAgentProfile(databasePath);
    if (profile.archived) return undefined;
    name = profile.name ?? agentId;
    owned = storeIsOwned(databasePath);
  } catch (cause) {
    if (cause instanceof LocalStoreSchemaError)
      return {
        agentId,
        name: agentId,
        sessions: [],
        attention: none,
        owned: false,
        unreadable: unreadableStoreReason(agentId),
      };
    logEvent("board-agent-profile", cause);
    return {
      agentId,
      name: agentId,
      sessions: [],
      attention: none,
      owned: false,
      unreadable: "its store could not be read",
    };
  }
  const database = openPrivateReadOnlySqliteDatabase(databasePath);
  try {
    const owner = createPrivateSqliteOwner(database);
    const sessions: readonly SessionSummaryRow[] = (
      await Effect.runPromise(readStoredSessionStates(owner))
    ).sessions;
    const attention = new Map<string, readonly SessionAttention[]>();
    for (const sessionId of attentionWanted(sessions))
      attention.set(
        sessionId,
        await Effect.runPromise(readStoredAttention(owner, sessionId)),
      );
    return { agentId, name, owned, sessions, attention };
  } catch (cause) {
    logEvent("board-agent-store", cause);
    return {
      agentId,
      name,
      owned,
      sessions: [],
      attention: none,
      unreadable: "its conversations could not be read",
    };
  } finally {
    database.close();
  }
}

/** Every Agent store under a project folder, as the Board reads them. */
export async function readBoardAgents(
  root: string,
): Promise<readonly BoardAgent[]> {
  const stores = await listPrivateLocalAgentStores(root, "all");
  const agents = await Promise.all(
    stores.map((path) => readBoardAgent(basename(dirname(path)), path)),
  );
  return agents.flatMap((agent) => (agent === undefined ? [] : [agent]));
}
