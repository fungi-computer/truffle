import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { sessionIds } from "../../../packages/shiitake/src/internal/woodstock/identities.js";
import {
  appendSessionEntry,
  prepareSessionStore,
} from "../../../packages/shiitake/src/internal/woodstock/session-store.js";
import type { StoredSessionEntry } from "../../../packages/shiitake/src/internal/woodstock/session-entry.js";

import { createLocalServiceOwners } from "../src/private-local-service-owner.js";
import type { ShiitakeSession } from "@fungi.computer/shiitake";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";
import {
  projectPrivateLocalSessionDiscovery,
  readPrivateLocalSessionDiscovery,
} from "../src/private-local-session-discovery.js";
import { unusedExtensions } from "./fixtures/unused-extensions.js";
import {
  fixtureEffectiveModel,
  fixtureMailControls,
  fixtureModelControls,
} from "./fixtures/effective-model.js";
import type {
  PrivateLocalServiceConnection,
  PrivateLocalServiceManager,
} from "../src/private-local-service-contract.js";

const roots: string[] = [];
const digest = "a".repeat(64);
const contract = {
  core: digest,
  extensions: [],
} as const;

async function root() {
  const value = await mkdtemp(join(tmpdir(), "fungi-session-discovery-"));
  roots.push(value);
  return value;
}

function createDatabase(
  path: string,
  title: string,
  updatedAt: number,
  sessionId = "main",
) {
  const database = new DatabaseSync(path);
  const owner = createPrivateSqliteOwner(database);
  prepareSessionStore(owner);
  const entry: Extract<StoredSessionEntry, { kind: "command" }> = {
    kind: "command",
    workId: sessionIds.work.generate(),
    requestId: `request-${title}`,
    receiptId: sessionIds.receipt.generate(),
    message: { role: "user", content: title, timestamp: updatedAt },
    contract,
  };
  appendSessionEntry(owner, {
    sessionId,
    id: sessionIds.fact.generate(),
    entry,
  });
  database
    .prepare("UPDATE sessions SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(updatedAt, updatedAt, sessionId);
  database.close();
}

// SAFETY: Discovery only inspects identity and closes this connection; no Session operation is exercised.
const connectTestService: PrivateLocalServiceManager["connect"] = (selection) =>
  Promise.resolve({
    databasePath: selection.databasePath,
    sessionId: selection.sessionId,
    close: () => Promise.resolve(),
  } as PrivateLocalServiceConnection);

async function discoverPrivateLocalSessions(
  invocationRoot: string,
  connect: PrivateLocalServiceManager["connect"],
) {
  return projectPrivateLocalSessionDiscovery(
    await readPrivateLocalSessionDiscovery(invocationRoot),
    connect,
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((value) => rm(value, { recursive: true, force: true })),
  );
});

describe("private local session discovery", () => {
  it("reads current stores read-only, newest first, without a host", async () => {
    const folder = await root();
    const current = join(folder, ".fungi", "agents", "current", "agent.sqlite");
    const older = join(folder, ".fungi", "agents", "older", "agent.sqlite");
    await mkdir(join(folder, ".fungi", "agents", "current"), {
      recursive: true,
    });
    await mkdir(join(folder, ".fungi", "agents", "older"), {
      recursive: true,
    });
    createDatabase(current, "current prompt", 20);
    createDatabase(older, "older prompt", 10);

    const discovered = await discoverPrivateLocalSessions(
      folder,
      connectTestService,
    );
    expect(discovered.problems).toEqual([]);
    expect(discovered.sessions.map(({ title }) => title)).toEqual([
      "current prompt",
      "older prompt",
    ]);
    await expect(readFile(current)).resolves.toBeInstanceOf(Buffer);
  });

  it("lists every Session in one store and resumes its exact identity", async () => {
    const folder = await root();
    const databasePath = join(
      folder,
      ".fungi",
      "agents",
      "current",
      "agent.sqlite",
    );
    await mkdir(join(folder, ".fungi", "agents", "current"), {
      recursive: true,
    });
    createDatabase(databasePath, "older main", 10);
    createDatabase(databasePath, "new conversation", 20, "session_fresh");
    const selections: Parameters<PrivateLocalServiceManager["connect"]>[0][] =
      [];
    const discovered = await discoverPrivateLocalSessions(
      folder,
      async (selection) => {
        selections.push(selection);
        return connectTestService(selection);
      },
    );

    expect(
      discovered.sessions.map(({ sessionId, title }) => ({ sessionId, title })),
    ).toEqual([
      { sessionId: "session_fresh", title: "new conversation" },
      { sessionId: "main", title: "older main" },
    ]);
    const fungiMcp = {
      endpoint: "https://hub.test/api/teams/selected/mcp",
    };
    await discovered.sessions[0]?.resume({ fungiMcp });
    await discovered.sessions[1]?.resume();
    expect(selections[0]?.fungiMcp).toEqual(fungiMcp);
    expect(selections[1]?.fungiMcp).toBeUndefined();
    expect(selections.map(({ sessionId }) => sessionId)).toEqual([
      "session_fresh",
      "main",
    ]);
  });

  it("distinguishes absent stores from corrupt candidates", async () => {
    const folder = await root();
    await mkdir(join(folder, ".fungi", "agents", "broken"), {
      recursive: true,
    });
    await writeFile(
      join(folder, ".fungi", "agents", "broken", "agent.sqlite"),
      "not sqlite",
    );
    const discovered = await discoverPrivateLocalSessions(
      folder,
      connectTestService,
    );
    expect(discovered.sessions).toEqual([]);
    expect(discovered.problems).toEqual([{ kind: "corrupt" }]);
  });

  it("reports a held SQLite store from its result code", async () => {
    const folder = await root();
    const directory = join(folder, ".fungi", "agents", "busy");
    const databasePath = join(directory, "agent.sqlite");
    await mkdir(directory, { recursive: true });
    createDatabase(databasePath, "held session", 10);
    const blocker = new DatabaseSync(databasePath, { timeout: 0 });
    blocker.exec("BEGIN EXCLUSIVE");
    try {
      const discovered = await discoverPrivateLocalSessions(
        folder,
        connectTestService,
      );
      expect(discovered.problems).toEqual([{ kind: "in_use" }]);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  it("excludes an empty main session and deduplicates canonical aliases", async () => {
    const folder = await root();
    const currentDirectory = join(folder, ".fungi", "agents", "current");
    const aliasDirectory = join(folder, ".fungi", "agents", "alias");
    await mkdir(currentDirectory, { recursive: true });
    createDatabase(
      join(currentDirectory, "agent.sqlite"),
      "one saved prompt",
      1,
    );
    await symlink(currentDirectory, aliasDirectory, "dir");
    const discovered = await discoverPrivateLocalSessions(
      folder,
      connectTestService,
    );
    expect(discovered.sessions).toHaveLength(1);

    const emptyFolder = join(folder, ".fungi", "agents", "empty");
    await mkdir(emptyFolder, { recursive: true });
    const empty = new DatabaseSync(join(emptyFolder, "agent.sqlite"));
    prepareSessionStore(createPrivateSqliteOwner(empty));
    empty.close();
    expect(
      (await discoverPrivateLocalSessions(folder, connectTestService)).sessions,
    ).toHaveLength(1);
  });

  it("orders equal summaries by canonical path before hiding it", async () => {
    const folder = await root();
    const first = join(folder, ".fungi", "agents", "zulu", "agent.sqlite");
    const second = join(folder, ".fungi", "agents", "alpha", "agent.sqlite");
    await mkdir(join(folder, ".fungi", "agents", "zulu"), {
      recursive: true,
    });
    await mkdir(join(folder, ".fungi", "agents", "alpha"), {
      recursive: true,
    });
    createDatabase(first, "same title", 30);
    createDatabase(second, "same title", 30);

    let resumedSelection:
      Parameters<PrivateLocalServiceManager["connect"]>[0] | undefined;
    const discovered = await discoverPrivateLocalSessions(
      folder,
      async (selection) => {
        resumedSelection = selection;
        return connectTestService(selection);
      },
    );
    const choice = discovered.sessions[0];
    if (choice === undefined) throw new Error("Expected a discovered session");
    const selected = await choice.resume();
    expect(selected.databasePath).toBe(await realpath(second));
    expect(resumedSelection).toEqual({
      invocationRoot: folder,
      databasePath: await realpath(second),
      fungiMcp: undefined,
      sessionId: "main",
    });
    await selected.close();
  });

  it("reopens a discovered store through the persistent connection projection", async () => {
    const folder = await root();
    const databasePath = join(
      folder,
      ".fungi",
      "agents",
      "saved",
      "agent.sqlite",
    );
    await mkdir(join(folder, ".fungi", "agents", "saved"), {
      recursive: true,
    });
    createDatabase(databasePath, "saved prompt", 40);

    const selections: Parameters<PrivateLocalServiceManager["connect"]>[0][] =
      [];
    const discovered = await discoverPrivateLocalSessions(
      folder,
      async (selection) => {
        selections.push(selection);
        return connectTestService(selection);
      },
    );
    const choice = discovered.sessions[0];
    if (choice === undefined) throw new Error("Expected a discovered session");
    const reopened = await choice.resume();
    expect(reopened.databasePath).toBe(await realpath(databasePath));
    const peer = await choice.resume();
    expect(peer.databasePath).toBe(reopened.databasePath);
    expect(selections).toHaveLength(2);
    await peer.close();
    await reopened.close();
  });
});

describe("Local startup selection", () => {
  it("reuses the sole Agent store and selects its latest updated Session without privileging main or touching order", async () => {
    const folder = await root();
    const directory = join(folder, ".fungi", "agents", "saved");
    await mkdir(directory, { recursive: true });
    const databasePath = join(directory, "agent.sqlite");
    createDatabase(databasePath, "older main", 10, "main");
    createDatabase(databasePath, "newer conversation", 30, "recent");
    const before = await readFile(databasePath);
    const opens: (string | undefined)[] = [];
    const owners = createLocalServiceOwners((options) => {
      opens.push(options.databasePath);
      return Promise.resolve({
        databasePath,
        agentId: "fixture-agent",
        listSessions: () => Promise.resolve({ sessions: [], next: undefined }),
        createSession: () => Promise.resolve("fresh-session"),
        deleteSession: () => Promise.resolve(false),
        extensions: unusedExtensions,
        bindSessionPath: () => true,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        // SAFETY: This selection test observes only the address; no Session methods are called.
        getSession: (id: string) =>
          ({ address: `session:${id}` }) as ShiitakeSession,
        close: () => Promise.resolve(),
      });
    });
    try {
      expect((await owners.select({ invocationRoot: folder })).sessionId).toBe(
        "recent",
      );
      expect(
        (await owners.select({ invocationRoot: folder, sessionId: "main" }))
          .sessionId,
      ).toBe("main");
      expect((await owners.select({ invocationRoot: folder })).sessionId).toBe(
        "recent",
      );
      expect(opens).toEqual([databasePath]);
      expect(await readFile(databasePath)).toEqual(before);
    } finally {
      await owners.close();
    }
  });

  it("does not silently choose an Agent when a folder contains multiple stores", async () => {
    const folder = await root();
    for (const name of ["first", "second"]) {
      const directory = join(folder, ".fungi", "agents", name);
      await mkdir(directory, { recursive: true });
      createDatabase(join(directory, "agent.sqlite"), name, 10);
    }
    const owners = createLocalServiceOwners(() => {
      throw new Error("must not open an arbitrary Agent");
    });
    try {
      await expect(owners.select({ invocationRoot: folder })).rejects.toThrow(
        "Multiple Agent stores",
      );
      const discovery = await discoverPrivateLocalSessions(
        folder,
        connectTestService,
      );
      expect(discovery.agentCount).toBe(2);
    } finally {
      await owners.close();
    }
  });
});
