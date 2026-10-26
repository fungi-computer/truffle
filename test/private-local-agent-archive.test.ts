import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type {
  SessionSnapshot,
  ShiitakeSession,
} from "@fungi.computer/shiitake";
import { AgentArchiveRefused } from "@fungi.computer/shiitake/agent-control";

import { sessionIds } from "../../../packages/shiitake/src/internal/woodstock/identities.js";
import {
  appendSessionEntry,
  prepareSessionStore,
} from "../../../packages/shiitake/src/internal/woodstock/session-store.js";
import type { StoredSessionEntry } from "../../../packages/shiitake/src/internal/woodstock/session-entry.js";
import { createPrivateLocalDelegation } from "../src/private-local-delegation.js";
import {
  createLocalServiceOwners,
  type OpenLocalServiceRuntime,
} from "../src/private-local-service-owner.js";
import {
  listPrivateLocalAgentStores,
  readPrivateLocalAgentProfile,
  readPrivateLocalSessionDiscovery,
} from "../src/private-local-session-discovery.js";
import type {
  LocalAgentControlDirectory,
  LocalArchiver,
} from "../src/private-local-agent-control.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";
import {
  fixtureEffectiveModel,
  fixtureMailControls,
  fixtureModelControls,
} from "./fixtures/effective-model.js";
import { initFreshStore } from "./fixtures/fresh-store.js";
import { unusedExtensions } from "./fixtures/unused-extensions.js";

const maker = "local_store_maker";
const child = "local_store_child";
const other = "local_store_other";
const asMaker: LocalArchiver = { kind: "agent", agentId: maker };
const human: LocalArchiver = { kind: "human" };
const signal = () => new AbortController().signal;
const contract = { core: "a".repeat(64), extensions: [] } as const;

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

/** One Agent store with a saved conversation, at the current schema. */
async function createStore(
  folder: string,
  agentId: string,
  name: string,
  createdBy: string | null,
  title: string,
  updatedAt: number,
) {
  const directory = join(folder, ".fungi", "agents", agentId);
  const path = join(directory, "agent.sqlite");
  await mkdir(directory, { recursive: true });
  const database = new DatabaseSync(path);
  initFreshStore(database, agentId, name, createdBy);
  const owner = createPrivateSqliteOwner(database);
  prepareSessionStore(owner);
  const entry: Extract<StoredSessionEntry, { kind: "command" }> = {
    kind: "command",
    workId: sessionIds.work.generate(),
    requestId: "request-" + title,
    receiptId: sessionIds.receipt.generate(),
    message: { role: "user", content: title, timestamp: updatedAt },
    contract,
  };
  appendSessionEntry(owner, {
    sessionId: "main",
    id: sessionIds.fact.generate(),
    entry,
  });
  database
    .prepare("UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(updatedAt, updatedAt, "main");
  database.close();
  return path;
}

function snapshot(commandId: string | undefined): SessionSnapshot {
  return {
    sessionId: "main",
    cursor: null,
    hasMore: false,
    messages: [],
    terminals: [],
    pending: { total: 0, prompts: [], hasMore: false },
    activity: {
      queue:
        commandId === undefined
          ? { state: "idle" }
          : { state: "running", commandId },
      cancellationRequested: false,
      retry: null,
      activeTool: null,
      lastModelChoiceSequence: null,
      compaction: null,
    },
    toolOutput: [],
    progress: null,
    extensions: {},
    attention: [],
  };
}

function session(commandId: string | undefined): ShiitakeSession {
  const unused = (): Promise<never> =>
    Promise.reject(new Error("unused in the archive proofs"));
  return {
    address: "session:main",
    readSettlement: unused,
    latestPending: unused,
    withdraw: unused,
    read: () => Promise.resolve(snapshot(commandId)),
    command: unused,
    send: unused,
    cancel: unused,
    extension: () => ({ call: unused }),
    modelPreference: {
      read: () => Promise.resolve(null),
      set: () => Promise.resolve(),
    },
    subscribe: () => {
      throw new Error("unused in the archive proofs");
    },
    watch: unused,
    abort: () => Promise.resolve(),
  };
}

/**
 * A project of three stores: Maker (made by a person), Child (made by Maker)
 * and Other (made by a person). The runtime fake writes the real archived
 * flag; "running" names the Agents with a command in flight.
 */
async function project() {
  const folder = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-agent-archive-")),
  );
  roots.push(folder);
  const makerPath = await createStore(
    folder,
    maker,
    "Maker",
    null,
    "maker talk",
    30,
  );
  await createStore(folder, child, "fixer", maker, "child talk", 20);
  await createStore(folder, other, "other", null, "other talk", 10);
  const running = new Map<string, string>();
  const waiting = new Map<string, string>();
  const unreadable = new Map<string, string>();
  const sent: string[] = [];
  // How long an admitted send takes to be accepted, to widen a race with an archive.
  const acceptance = { delayMs: 0 };
  let directory: LocalAgentControlDirectory | undefined;
  const open: OpenLocalServiceRuntime = (options) => {
    if (options.agentControl !== undefined) directory ??= options.agentControl;
    const databasePath = options.databasePath;
    if (databasePath === undefined)
      return Promise.reject(new Error("archive proofs open stores by path"));
    const agentId = basename(dirname(databasePath));
    // Read live: the service keeps one owner per store across calls.
    const commandId = () => running.get(agentId);
    return Promise.resolve({
      databasePath,
      agentId,
      name: agentId,
      listSessions: () =>
        Promise.resolve({
          sessions: [
            {
              sessionId: "main",
              createdAt: 1,
              lastActivityAt: 1,
              title: "talk",
              state: commandId() === undefined ? "done" : "running",
            },
          ],
          next: undefined,
        }),
      createSession: () => Promise.resolve("unused"),
      deleteSession: () => Promise.resolve(false),
      extensions: unusedExtensions,
      bindSessionPath: () => true,
      effectiveModel: fixtureEffectiveModel,
      ...fixtureModelControls,
      setArchived: (archived) => {
        const database = new DatabaseSync(databasePath);
        try {
          database
            .prepare(
              "UPDATE private_local_identity SET archived = ? WHERE singleton = 1",
            )
            .run(archived ? 1 : 0);
        } finally {
          database.close();
        }
      },
      ...fixtureMailControls,
      pendingDelegation: () => {
        const commandId = waiting.get(agentId);
        const why = unreadable.get(agentId);
        if (commandId === undefined) return Promise.resolve(undefined);
        const target = { agentId: child, sessionId: "main", commandId };
        return Promise.resolve(
          why === undefined ? target : { ...target, unreadable: why },
        );
      },
      getSession: () => ({
        ...session(commandId()),
        // Accepting a command starts it; the fake rejects only to end the call.
        command: async () => {
          await new Promise((resolve) =>
            setTimeout(resolve, acceptance.delayMs),
          );
          sent.push(agentId);
          running.set(agentId, "command_sent");
          throw new Error("accepted");
        },
        send: async () => {
          await new Promise((resolve) =>
            setTimeout(resolve, acceptance.delayMs),
          );
          sent.push(agentId);
          running.set(agentId, "command_sent");
          return { status: "accepted", commandId: "command_sent" };
        },
      }),
      close: () => Promise.resolve(),
    });
  };
  const owners = createLocalServiceOwners(open, undefined, {
    assertHeldByAgent: () => Promise.resolve(),
    enableAgent: () =>
      Promise.resolve({ revision: "r1", capabilities: [], skills: false }),
  });
  await owners.select({
    invocationRoot: folder,
    databasePath: makerPath,
    sessionId: "main",
  });
  if (directory === undefined) throw new Error("Local directory missing");
  const ids = async (archived: boolean) =>
    (await directory?.list(signal(), { archived }))
      ?.map(({ agentId }) => agentId)
      .sort();
  return {
    folder,
    running,
    waiting,
    unreadable,
    sent,
    acceptance,
    directory,
    owners,
    ids,
  };
}

describe("archiving an Agent", () => {
  it("An agent itself needs to be able to tidy: an agent archives an agent it created, and it leaves the list and the picker but not the disk", async () => {
    const local = await project();
    try {
      await local.directory.archive({ agentId: child, by: asMaker }, signal());
      expect(await local.ids(false)).toEqual([maker, other]);
      expect(await local.ids(true)).toEqual([child]);
      const discovery = await readPrivateLocalSessionDiscovery(local.folder);
      expect(discovery.agents.map(({ agentId }) => agentId).sort()).toEqual([
        maker,
        other,
      ]);
      expect(discovery.sessions.map(({ title }) => title)).toEqual([
        "maker talk",
        "other talk",
      ]);
      // Nothing is deleted: the store and its conversation are still there.
      const childStore = join(local.folder, ".fungi", "agents", child);
      expect(await readdir(childStore)).toContain("agent.sqlite");
      const archivedView = await readPrivateLocalSessionDiscovery(
        local.folder,
        { archived: true },
      );
      expect(archivedView.sessions.map(({ title }) => title)).toEqual([
        "child talk",
      ]);
      expect(
        readPrivateLocalAgentProfile(join(childStore, "agent.sqlite")),
      ).toMatchObject({ archived: true, createdBy: maker });
    } finally {
      await local.owners.close();
    }
  });

  it("An agent cannot archive an agent it did not create, or itself", async () => {
    const local = await project();
    try {
      await expect(
        local.directory.archive({ agentId: other, by: asMaker }, signal()),
      ).rejects.toMatchObject({
        name: "AgentArchiveRefused",
        reason: "not_creator",
      });
      await expect(
        local.directory.archive({ agentId: maker, by: asMaker }, signal()),
      ).rejects.toMatchObject({ reason: "self" });
      // The made Agent cannot archive the Agent that made it either.
      await expect(
        local.directory.archive(
          { agentId: maker, by: { kind: "agent", agentId: child } },
          signal(),
        ),
      ).rejects.toMatchObject({ reason: "not_creator" });
      expect(await local.ids(false)).toEqual([child, maker, other]);
    } finally {
      await local.owners.close();
    }
  });

  it("The user should have a way to: a person archives any Agent, finds it archived, and unarchive restores it everywhere", async () => {
    const local = await project();
    try {
      await local.directory.archive({ agentId: other, by: human }, signal());
      expect(await local.ids(false)).toEqual([child, maker]);
      expect(await local.ids(true)).toEqual([other]);
      await local.directory.unarchive({ agentId: other, by: human }, signal());
      expect(await local.ids(false)).toEqual([child, maker, other]);
      expect(await local.ids(true)).toEqual([]);
      const discovery = await readPrivateLocalSessionDiscovery(local.folder);
      expect(discovery.agents.map(({ agentId }) => agentId).sort()).toEqual([
        child,
        maker,
        other,
      ]);
      // Through the owners, as the CLI and the landing picker reach it.
      await local.owners.archive(
        { invocationRoot: local.folder, agentId: maker, archived: true },
        signal(),
      );
      expect(await local.ids(true)).toEqual([maker]);
    } finally {
      await local.owners.close();
    }
  });

  it("Delegation to an archived Agent is refused, and discovery and newest-Session resolution skip it", async () => {
    const local = await project();
    try {
      await local.directory.archive({ agentId: child, by: asMaker }, signal());
      await expect(
        local.directory.open(child, signal()),
      ).rejects.toBeInstanceOf(AgentArchiveRefused);
      await expect(
        local.directory.checkModel?.(
          { agentId: child, sessionId: "main" },
          signal(),
        ),
      ).rejects.toMatchObject({ reason: "archived" });
      const delegation = createPrivateLocalDelegation({
        agentId: maker,
        storage: createPrivateSqliteOwner(new DatabaseSync(":memory:")),
        directory: local.directory,
        routing: {
          deliver: () => Promise.reject(new Error("unused")),
          readSettlement: () => Promise.reject(new Error("unused")),
        },
        accept: () => Promise.reject(new Error("unused")),
      });
      await expect(
        delegation.send(
          {
            agentId: child,
            sessionId: "main",
            requestId: "archived-child",
            text: "hello",
            delivery: "followUp",
          },
          "main",
          signal(),
          { toolCallId: "call", sendIndex: 0 },
        ),
      ).rejects.toMatchObject({ reason: "archived" });
      // The child's conversation is the newest only when it is not archived.
      await local.directory.unarchive(
        { agentId: child, by: asMaker },
        signal(),
      );
      await local.directory.archive({ agentId: maker, by: human }, signal());
      const newest = await readPrivateLocalSessionDiscovery(local.folder);
      expect(newest.sessions[0]?.title).toBe("child talk");
      expect(
        (await listPrivateLocalAgentStores(local.folder, "all")).length,
      ).toBe(3);
      expect(
        (await listPrivateLocalAgentStores(local.folder)).map((path) =>
          basename(dirname(path)),
        ),
      ).toEqual([child, other].sort());
    } finally {
      await local.owners.close();
    }
  });

  it("Archiving an Agent with a running command is refused, naming the command, and changes nothing", async () => {
    const local = await project();
    try {
      local.running.set(child, "command_busy");
      const refusal = await local.directory
        .archive({ agentId: child, by: asMaker }, signal())
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );
      expect(refusal).toMatchObject({ reason: "running" });
      expect(refusal instanceof Error ? refusal.message : "").toContain(
        "command_busy",
      );
      expect(await local.ids(false)).toEqual([child, maker, other]);
      // The agent cancels first; then the archive goes through.
      local.running.delete(child);
      await local.directory.archive({ agentId: child, by: asMaker }, signal());
      expect(await local.ids(true)).toEqual([child]);
    } finally {
      await local.owners.close();
    }
  });

  it("Archiving an Agent that still waits for delegated work is refused, naming that work", async () => {
    const local = await project();
    try {
      local.waiting.set(maker, "command_delegated");
      const refusal = await local.directory
        .archive({ agentId: maker, by: human }, signal())
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );
      expect(refusal).toMatchObject({ reason: "pending" });
      expect(refusal instanceof Error ? refusal.message : "").toContain(
        "command_delegated",
      );
      expect(await local.ids(false)).toEqual([child, maker, other]);
      local.waiting.delete(maker);
      await local.directory.archive({ agentId: maker, by: human }, signal());
      expect(await local.ids(true)).toEqual([maker]);
    } finally {
      await local.owners.close();
    }
  });

  it("A send racing an archive either runs first (the archive is refused, naming it) or is refused as archived; it never runs on an archived Agent", async () => {
    for (const [sendFirst, delayMs] of [
      [true, 0],
      [true, 15],
      [false, 0],
      [false, 15],
    ] as const) {
      const local = await project();
      try {
        local.acceptance.delayMs = delayMs;
        const send = async () => {
          const opened = await local.directory.open(child, signal());
          try {
            return await opened.agent.session("main").send("work");
          } finally {
            await opened.release();
          }
        };
        const archive = () =>
          local.directory.archive({ agentId: child, by: asMaker }, signal());
        const [sending, archiving] = await Promise.allSettled(
          sendFirst ? [send(), archive()] : [archive(), send()].reverse(),
        );
        const archivedNow = (await local.ids(true))?.includes(child) === true;
        if (local.sent.length > 0) {
          // The send ran, so the archive had to see its command and refuse.
          expect(sending?.status).toBe("fulfilled");
          expect(archiving).toMatchObject({
            status: "rejected",
            reason: { reason: "running" },
          });
          expect(archivedNow).toBe(false);
        } else {
          expect(sending).toMatchObject({
            status: "rejected",
            reason: { reason: "archived" },
          });
          expect(archiving?.status).toBe("fulfilled");
          expect(archivedNow).toBe(true);
        }
      } finally {
        await local.owners.close();
      }
    }
  });

  it("archiving a store that predates the archived flag gives the typed refusal and a reset phrase, not a SQLite error", async () => {
    const local = await project();
    try {
      const oldStore = join(
        local.folder,
        ".fungi",
        "agents",
        "local_store_old",
      );
      await mkdir(oldStore, { recursive: true });
      const oldPath = join(oldStore, "agent.sqlite");
      const old = new DatabaseSync(oldPath);
      old.exec(
        "CREATE TABLE private_local_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), agent_id TEXT NOT NULL UNIQUE, name TEXT, created_by TEXT)",
      );
      old
        .prepare("INSERT INTO private_local_identity VALUES (1, ?, 'old', ?)")
        .run("local_store_old", maker);
      old.close();
      for (const by of [human, asMaker]) {
        const refusal = await local.directory
          .archive({ agentId: "local_store_old", by }, signal())
          .then(
            () => undefined,
            (cause: unknown) => cause,
          );
        expect(refusal).toBeInstanceOf(AgentArchiveRefused);
        expect(refusal).toMatchObject({ reason: "unreadable" });
        expect(refusal instanceof Error ? refusal.message : "").toContain(
          "move .fungi/agents/local_store_old aside",
        );
      }
      await access(oldPath);
    } finally {
      await local.owners.close();
    }
  });

  it("A command through an open selection is refused once its Agent is archived, and an archive racing one in flight is refused naming it", async () => {
    const prompt = {
      type: "prompt",
      delivery: "steer",
      requestId: "typed",
      text: "work",
    } as const;
    const local = await project();
    try {
      const childPath = join(
        local.folder,
        ".fungi",
        "agents",
        child,
        "agent.sqlite",
      );
      const selection = await local.owners.select({
        invocationRoot: local.folder,
        databasePath: childPath,
        sessionId: "main",
      });
      await local.directory.archive({ agentId: child, by: asMaker }, signal());
      await expect(selection.session.command(prompt)).rejects.toMatchObject({
        reason: "archived",
      });
      expect(local.sent).toEqual([]);
      await local.directory.unarchive(
        { agentId: child, by: asMaker },
        signal(),
      );
      // In flight: the command is being accepted when the archive arrives.
      local.acceptance.delayMs = 15;
      const [command, archive] = await Promise.allSettled([
        selection.session.command(prompt),
        local.directory.archive({ agentId: child, by: asMaker }, signal()),
      ]);
      expect(local.sent).toEqual([child]);
      expect(
        command.status === "rejected" ? command.reason : undefined,
      ).toMatchObject({ message: "accepted" });
      expect(archive).toMatchObject({
        status: "rejected",
        reason: { reason: "running" },
      });
    } finally {
      await local.owners.close();
    }
  });

  it("Archiving while the delegated work's state cannot be read is refused as pending, naming the target and why", async () => {
    const local = await project();
    try {
      local.waiting.set(maker, "command_delegated");
      local.unreadable.set(maker, "Agent is outside this Local project");
      const refusal = await local.directory
        .archive({ agentId: maker, by: human }, signal())
        .then(
          () => undefined,
          (cause: unknown) => cause,
        );
      expect(refusal).toMatchObject({ reason: "pending" });
      const message = refusal instanceof Error ? refusal.message : "";
      expect(message).toContain("command_delegated");
      expect(message).toContain(child);
      expect(message).toContain("Agent is outside this Local project");
      expect(await local.ids(false)).toEqual([child, maker, other]);
    } finally {
      await local.owners.close();
    }
  });
});
