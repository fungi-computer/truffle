import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, expect, it } from "vitest";
import { sessionIds } from "../../../packages/shiitake/src/internal/woodstock/identities.js";
import { prepareSessionAttention } from "../../../packages/shiitake/src/internal/woodstock/session-attention.js";
import {
  prepareSessionDelegators,
  recordSessionDelegator,
} from "../../../packages/shiitake/src/internal/woodstock/session-delegator.js";
import {
  prepareWorkSenders,
  recordWorkSender,
} from "../../../packages/shiitake/src/internal/woodstock/work-senders.js";
import {
  appendSessionEntry,
  prepareSessionStore,
} from "../../../packages/shiitake/src/internal/woodstock/session-store.js";
import type { StoredSessionEntry } from "../../../packages/shiitake/src/internal/woodstock/session-entry.js";
import { acquireNodeStoreLease } from "@fungi.computer/shiitake/node";
import { readBoardAgent, storeIsOwned } from "../src/local-board-agents.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";
import { initFreshStore } from "./fixtures/fresh-store.js";

const root = await mkdtemp(join(tmpdir(), "board-agents-"));
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** One store with a saved conversation, waiting on a person when asked. */
async function store(
  agentId: string,
  options: Readonly<{
    waiting?: boolean;
    archived?: boolean;
    parent?: boolean;
  }> = {},
) {
  const directory = join(root, agentId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, "agent.sqlite");
  const database = new DatabaseSync(path);
  initFreshStore(database, agentId, "Scout", null, options.archived === true);
  const owner = createPrivateSqliteOwner(database);
  prepareSessionStore(owner);
  prepareSessionAttention(owner);
  prepareSessionDelegators(owner);
  prepareWorkSenders(owner);
  const entry: Extract<StoredSessionEntry, { kind: "command" }> = {
    kind: "command",
    workId: sessionIds.work.generate(),
    requestId: "request",
    receiptId: sessionIds.receipt.generate(),
    message: { role: "user", content: "Which branch?", timestamp: 1 },
    contract: { core: "a".repeat(64), extensions: [] },
  };
  appendSessionEntry(owner, {
    sessionId: "main",
    id: sessionIds.fact.generate(),
    entry,
  });
  if (options.parent === true) {
    const sender = { agentId: "shiitake", sessionId: "lead", name: "Shiitake" };
    const from = {
      kind: "agent" as const,
      agentId: sender.agentId,
      sessionId: sender.sessionId,
    };
    recordSessionDelegator(owner, "main", {
      key: "delegated",
      from,
      replyTo: [from],
      to: { kind: "agent", agentId, sessionId: "main" },
      content: "Build",
      createdAt: 1,
    });
    recordWorkSender(owner, "main", entry.workId, sender);
  }
  if (options.waiting === true) {
    database.exec(
      "CREATE TABLE IF NOT EXISTS shiitake_extension_status (extension_id TEXT PRIMARY KEY, status TEXT NOT NULL, reason TEXT, stopped_at INTEGER, revision TEXT NOT NULL)",
    );
    database.exec(
      "INSERT INTO shiitake_extension_status VALUES ('asker', 'running', NULL, NULL, 'r1')",
    );
    database.exec("INSERT INTO session_attention_grants VALUES ('asker')");
    database
      .prepare(
        "INSERT INTO session_attention (session_id, extension_id, id, value_json) VALUES ('main', 'asker', 'ask-1', ?)",
      )
      .run(
        JSON.stringify({
          id: "ask-1",
          kind: "question",
          summary: "Which branch?",
          since: 1_000,
        }),
      );
    database.exec(
      "UPDATE session_inbox SET state = 'needs_you', tier = 0 WHERE session_id = 'main'",
    );
  }
  database.close();
  return path;
}

it("reads an Agent's conversations and what waits on a person from its store alone", async () => {
  const agent = await readBoardAgent(
    "local_store_scout",
    await store("local_store_scout", { waiting: true }),
  );
  expect(agent).toMatchObject({
    agentId: "local_store_scout",
    name: "Scout",
    sessions: [{ sessionId: "main", state: "needs_you" }],
  });
  expect(agent?.unreadable).toBeUndefined();
  expect([...(agent?.attention ?? [])]).toMatchObject([
    [
      "main",
      [{ extensionId: "asker", kind: "question", summary: "Which branch?" }],
    ],
  ]);
});

it("a quiet Agent reads as a conversation with no attention", async () => {
  const agent = await readBoardAgent(
    "local_store_quiet",
    await store("local_store_quiet"),
  );
  expect(agent?.sessions).toMatchObject([{ sessionId: "main", state: "done" }]);
  expect([...(agent?.attention ?? [])]).toMatchObject([["main", []]]);
  expect(agent?.parents.get("main")).toBeNull();
});

it("cold board reads retain the exact first-delegator parent", async () => {
  const agent = await readBoardAgent(
    "local_store_delegated",
    await store("local_store_delegated", { parent: true }),
  );
  expect(agent?.parents.get("main")).toEqual({
    agentId: "shiitake",
    sessionId: "lead",
    name: "Shiitake",
  });
});

it("counts needs-you Sessions past the four whose attention is read", async () => {
  const path = await store("local_store_many", { waiting: true });
  const database = new DatabaseSync(path);
  try {
    const owner = createPrivateSqliteOwner(database);
    for (let index = 0; index < 5; index += 1) {
      const sessionId = `waiting-${String(index)}`;
      appendSessionEntry(owner, {
        sessionId,
        id: sessionIds.fact.generate(),
        entry: {
          kind: "command",
          workId: sessionIds.work.generate(),
          requestId: sessionId,
          receiptId: sessionIds.receipt.generate(),
          message: { role: "user", content: "Work", timestamp: 1 },
          contract: { core: "a".repeat(64), extensions: [] },
        },
      });
      database
        .prepare(
          "INSERT INTO session_attention (session_id, extension_id, id, value_json) SELECT ?, extension_id, id, value_json FROM session_attention WHERE session_id = 'main'",
        )
        .run(sessionId);
    }
    // Match the runtime's materialized inbox state as the existing fixture does.
    database.exec("UPDATE session_inbox SET state = 'needs_you', tier = 0");
  } finally {
    database.close();
  }
  const agent = await readBoardAgent("local_store_many", path);
  expect(agent?.waitingNotRead).toBe(2);
  expect(agent?.attention.size).toBe(4);
  expect(agent?.parents.size).toBe(4);
});

it("an archived Agent is not on the board, and a store from an older schema is unavailable with the way to reset it", async () => {
  expect(
    await readBoardAgent(
      "local_store_old_archive",
      await store("local_store_old_archive", { archived: true }),
    ),
  ).toBeUndefined();
  const directory = join(root, "local_store_old");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "agent.sqlite");
  await writeFile(path, "");
  const agent = await readBoardAgent("local_store_old", path);
  expect(agent).toMatchObject({
    agentId: "local_store_old",
    sessions: [],
    unreadable:
      "predates the current schema; move .fungi/agents/local_store_old aside to reset it",
  });
});

it("a store is owned only while a live runtime holds its sidecar lease", async () => {
  const path = await store("local_store_leased");
  expect(storeIsOwned(path)).toBe(false);
  const lease = acquireNodeStoreLease(`${path}.owner.sqlite`);
  try {
    expect(storeIsOwned(path)).toBe(true);
    expect((await readBoardAgent("local_store_leased", path))?.owned).toBe(
      true,
    );
  } finally {
    lease.release();
  }
  expect(storeIsOwned(path)).toBe(false);
  expect((await readBoardAgent("local_store_leased", path))?.owned).toBe(false);
});
