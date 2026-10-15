import { readdir, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Effect from "effect/Effect";
import {
  readSessionSummaries,
  type StoredSessionSummary,
} from "@fungi.computer/shiitake/effect";

import type {
  PrivateLocalServiceManager,
  PrivateLocalServiceRequestOptions,
  PrivateLocalSessionChoice,
  PrivateLocalSessionDiscovery,
  PrivateLocalSessionProblem,
} from "./private-local-service-contract.js";
import {
  createPrivateSqliteOwner,
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

export async function listPrivateLocalAgentStores(
  root: string,
): Promise<readonly string[]> {
  const candidates = await immediateStoreCandidates(root, ".fungi/agents");
  const paths = new Set<string>();
  for (const candidate of candidates) {
    try {
      paths.add(await realpath(candidate.path));
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        continue;
      throw cause;
    }
  }
  return [...paths];
}

export async function readPrivateLocalSessionSummaries(
  path: string,
): Promise<readonly LocalSummary[]> {
  const database = new DatabaseSync(path, { readOnly: true, timeout: 0 });
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

/** Discover existing folder sessions without opening or reconciling a host. */
export async function readPrivateLocalSessionDiscovery(
  invocationRoot: string,
  request: PrivateLocalServiceRequestOptions = {},
) {
  request.signal?.throwIfAborted();
  const root = await realpath(resolve(invocationRoot));
  const paths = await listPrivateLocalAgentStores(root);
  const discovered: LocalSummary[] = [];
  const problems: PrivateLocalSessionProblem[] = [];
  for (const path of paths) {
    request.signal?.throwIfAborted();
    try {
      discovered.push(...(await readPrivateLocalSessionSummaries(path)));
    } catch (cause) {
      problems.push({ kind: problemKind(cause) });
    }
  }
  discovered.sort(compareSummaries);
  return { root, agentCount: paths.length, sessions: discovered, problems };
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
            },
            resumeRequest,
          ),
      }),
  );
  return Object.freeze({
    agentCount: discovered.agentCount,
    sessions: Object.freeze(sessions),
    problems: Object.freeze(discovered.problems),
  });
}
