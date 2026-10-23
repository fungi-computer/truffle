import { readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import { parseModelPreferenceJson } from "@fungi.computer/shiitake/model-preference";
import { z } from "zod";
import { readAgentDefaultModelJson } from "./private-local-agent-default-model.js";
import {
  localAgentFolderSchema,
  resolveAgentFolder,
} from "./private-local-sandbox-policy.js";
import { logEvent } from "./log-event.js";
import {
  readSessionSummaries,
  type StoredSessionSummary,
} from "@fungi.computer/shiitake/effect";

import type {
  PrivateLocalAgentChoice,
  PrivateLocalServiceManager,
  PrivateLocalDiscoveryOptions,
  PrivateLocalSessionChoice,
  PrivateLocalSessionDiscovery,
  PrivateLocalSessionProblem,
} from "./private-local-service-contract.js";
import {
  createPrivateSqliteOwner,
  openPrivateReadOnlySqliteDatabase,
  privateSqliteFailureCode,
  type PrivateSqliteFailureCode,
} from "./private-sqlite-owner.js";

export type LocalSummary = StoredSessionSummary &
  Readonly<{ databasePath: string; sessionId: string }>;

type Candidate = Readonly<{ path: string }>;

function compareSummaries(left: LocalSummary, right: LocalSummary): number {
  return (
    right.updatedAt - left.updatedAt ||
    right.createdAt - left.createdAt ||
    left.title.localeCompare(right.title) ||
    left.databasePath.localeCompare(right.databasePath) ||
    left.sessionId.localeCompare(right.sessionId)
  );
}

class LocalSessionDiscoveryError extends Error {
  constructor(
    readonly kind: PrivateLocalSessionProblem["kind"],
    options?: ErrorOptions,
  ) {
    super("Local session store could not be read", options);
  }
}

function sqliteProblemKind(
  code: PrivateSqliteFailureCode | undefined,
): PrivateLocalSessionProblem["kind"] {
  if (code === "busy" || code === "locked") return "in_use";
  if (code === "corrupt" || code === "not_a_database") return "corrupt";
  return "unreadable";
}

function problemKind(cause: unknown): PrivateLocalSessionProblem["kind"] {
  return cause instanceof LocalSessionDiscoveryError
    ? cause.kind
    : sqliteProblemKind(privateSqliteFailureCode(cause));
}

async function immediateStoreCandidates(root: string, relative: string) {
  const directory = resolve(root, relative);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return [];
    throw cause;
  }
  return Promise.all(
    entries
      .filter(
        (entry) =>
          (entry.isDirectory() || entry.isSymbolicLink()) &&
          entry.name.length > 0,
      )
      .map(async (entry): Promise<Candidate | undefined> => {
        const path = join(directory, entry.name, "agent.sqlite");
        try {
          const metadata = await stat(path);
          if (!metadata.isFile()) return undefined;
          return { path };
        } catch (cause) {
          if (
            cause instanceof Error &&
            "code" in cause &&
            cause.code === "ENOENT"
          )
            return undefined;
          throw cause;
        }
      }),
  ).then((values) =>
    values.filter((value): value is Candidate => value !== undefined),
  );
}

/**
 * Which Agent stores a listing returns: the ones in use, only the archived
 * ones (to restore them), or both (to find one by id).
 */
export type LocalStoreVisibility = "active" | "archived" | "all";

/** The one plain phrase for a store written before the current schema, with how to reset it. */
export function unreadableStoreReason(agentId: string): string {
  return `predates the current schema; move .fungi/agents/${agentId} aside to reset it`;
}

/**
 * Whether a store's Agent is archived. A store this cannot read counts as
 * not archived, so discovery still reports it as a problem.
 */
export function isArchivedStore(path: string): boolean {
  try {
    return readPrivateLocalAgentProfile(path).archived;
  } catch (cause) {
    if (!(cause instanceof LocalStoreSchemaError))
      logEvent("store-archived", cause);
    return false;
  }
}

export async function listPrivateLocalAgentStores(
  root: string,
  visibility: LocalStoreVisibility = "active",
): Promise<readonly string[]> {
  const candidates = await immediateStoreCandidates(root, ".fungi/agents");
  const paths = new Set<string>();
  for (const candidate of candidates) {
    try {
      const path = await realpath(candidate.path);
      if (
        visibility === "all" ||
        isArchivedStore(path) === (visibility === "archived")
      )
        paths.add(path);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        continue;
      throw cause;
    }
  }
  return [...paths];
}

const storedProfileSchema = z.strictObject({
  name: z.string().nullable(),
  createdBy: z.string().nullable(),
  archived: z.union([z.literal(0), z.literal(1)]),
  requireSandbox: z.union([z.literal(0), z.literal(1)]),
  folder: localAgentFolderSchema,
  model: z.string(),
});

/** A Local or Woodstock store outside the current schema; Local never migrates it. */
export class LocalStoreSchemaError extends Error {
  override readonly name = "LocalStoreSchemaError";
  constructor(
    readonly databasePath: string,
    options?: ErrorOptions,
  ) {
    super(
      `Agent store ${databasePath} is incompatible with this version of Fungi. To reset, stop the owning Fungi service, then move this database, its .owner.sqlite sidecar and any associated SQLite journal files aside together. Create a fresh Agent; existing Sessions are not migrated. Keep the moved files if you need their data.`,
      options,
    );
  }
}

/**
 * One Agent store's chosen display name, default model, whether it is
 * archived and the Agent that created it (absent when a human made it), read
 * without opening a host.
 */
export function readPrivateLocalAgentProfile(path: string) {
  const database = openPrivateReadOnlySqliteDatabase(path);
  try {
    const columns = database
      .prepare("PRAGMA table_info(private_local_identity)")
      .all();
    if (
      !["name", "created_by", "archived", "require_sandbox", "folder"].every(
        (required) => columns.some((column) => column.name === required),
      )
    )
      throw new LocalStoreSchemaError(path);
    const identity = database
      .prepare(
        "SELECT name, created_by, archived, require_sandbox, folder FROM private_local_identity WHERE singleton = 1",
      )
      .get();
    const stored = storedProfileSchema.parse({
      name: identity?.name,
      createdBy: identity?.created_by,
      archived: identity?.archived,
      requireSandbox: identity?.require_sandbox,
      folder: identity?.folder,
      model: readAgentDefaultModelJson(database),
    });
    return {
      name: stored.name ?? undefined,
      createdBy: stored.createdBy,
      archived: stored.archived === 1,
      requireSandbox: stored.requireSandbox === 1,
      folder: stored.folder,
      model: parseModelPreferenceJson(stored.model),
    };
  } finally {
    database.close();
  }
}

export async function readPrivateLocalSessionSummaries(
  path: string,
): Promise<readonly LocalSummary[]> {
  const database = openPrivateReadOnlySqliteDatabase(path);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    let sqliteFailure: PrivateSqliteFailureCode | undefined;
    const owner = createPrivateSqliteOwner(database, (code) => {
      sqliteFailure = code;
    });
    const summaries: LocalSummary[] = [];
    let after: string | undefined;
    try {
      do {
        const page = await Effect.runPromise(
          readSessionSummaries(owner, after),
        );
        for (const row of page.sessions) {
          // One unreadable Session marks this store corrupt, as before.
          if (row.kind === "unavailable")
            throw new LocalSessionDiscoveryError("corrupt");
          summaries.push({
            sessionId: row.sessionId,
            title: row.title,
            createdAt: row.createdAt,
            updatedAt: row.updatedAt,
            databasePath: path,
          });
        }
        after = page.next;
      } while (after !== undefined);
    } catch (cause) {
      if (cause instanceof LocalSessionDiscoveryError) throw cause;
      throw new LocalSessionDiscoveryError(sqliteProblemKind(sqliteFailure), {
        cause,
      });
    }
    return summaries.sort(compareSummaries);
  } finally {
    database.close();
  }
}

/**
 * Discover existing folder sessions without opening or reconciling a host.
 * Archived Agents and their Sessions are left out, so no picker or "newest
 * Session" choice can land on one; `archived` lists only those instead.
 */
export async function readPrivateLocalSessionDiscovery(
  invocationRoot: string,
  request: PrivateLocalDiscoveryOptions = {},
) {
  request.signal?.throwIfAborted();
  const root = await realpath(resolve(invocationRoot));
  const paths = await listPrivateLocalAgentStores(
    root,
    request.archived === true ? "archived" : "active",
  );
  const discovered: LocalSummary[] = [];
  const agents: PrivateLocalAgentChoice[] = [];
  const profiles = new Map<
    string,
    ReturnType<typeof readPrivateLocalAgentProfile>
  >();
  const problems: PrivateLocalSessionProblem[] = [];
  for (const path of paths) {
    request.signal?.throwIfAborted();
    const agentId = basename(dirname(path));
    try {
      const summaries = await readPrivateLocalSessionSummaries(path);
      discovered.push(...summaries);
      let profile: ReturnType<typeof readPrivateLocalAgentProfile> | undefined;
      let unreadable: string | undefined;
      try {
        profile = readPrivateLocalAgentProfile(path);
        resolveAgentFolder(root, profile.folder);
        profiles.set(agentId, profile);
      } catch (cause) {
        // Shown on the row so the user knows to reset the store; opening it
        // refuses with the same error.
        if (!(cause instanceof LocalStoreSchemaError)) throw cause;
        unreadable = unreadableStoreReason(agentId);
      }
      agents.push({
        agentId,
        name: profile?.name,
        unreadable,
        databasePath: path,
        sessionCount: summaries.length,
        updatedAt: summaries[0]?.updatedAt,
      });
    } catch (cause) {
      problems.push({ kind: problemKind(cause) });
      agents.push({ agentId, databasePath: path, sessionCount: 0 });
    }
  }
  discovered.sort(compareSummaries);
  // The wire carries identity; clients derive the “made by” label from names.
  const labelled = agents.map((agent) => {
    const createdBy = profiles.get(agent.agentId)?.createdBy;
    if (createdBy === undefined) return agent;
    return {
      ...agent,
      createdBy,
    };
  });
  return { root, agents: labelled, sessions: discovered, problems };
}

/** Project the service-owned discovery into choices that resume through it. */
export function projectPrivateLocalSessionDiscovery(
  discovered: Awaited<ReturnType<typeof readPrivateLocalSessionDiscovery>>,
  connect: PrivateLocalServiceManager["connect"],
): PrivateLocalSessionDiscovery {
  const sessions: PrivateLocalSessionChoice[] = discovered.sessions.map(
    ({ databasePath, sessionId, ...display }) =>
      Object.freeze({
        ...display,
        databasePath,
        sessionId,
        resume: (resumeRequest) =>
          connect(
            {
              invocationRoot: discovered.root,
              databasePath,
              sessionId,
              fungiMcp: resumeRequest?.fungiMcp,
              requireSandbox: resumeRequest?.requireSandbox,
            },
            resumeRequest,
          ),
      }),
  );
  return Object.freeze({
    agents: Object.freeze(discovered.agents),
    sessions: Object.freeze(sessions),
    problems: Object.freeze(discovered.problems),
  });
}
