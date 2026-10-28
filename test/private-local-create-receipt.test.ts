import { closeSync, fstatSync, openSync, type Stats } from "node:fs";
import fsPromises, {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

import { resolvePrivateLocalCreateStore } from "../src/private-local-runtime-host.js";

const originalLstat = fsPromises.lstat;
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryProject() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-local-create-receipt-")),
  );
  roots.push(root);
  return root;
}

it("resolves two concurrent creates when the journal stat observes its unlink", async () => {
  const root = await temporaryProject();
  const journalPath = join(
    root,
    ".fungi",
    "agents",
    "local-agent-create-receipts.sqlite-journal",
  );
  const atJournal = Promise.withResolvers<undefined>();
  const journalMetadata = Promise.withResolvers<Stats>();
  let held = false;
  vi.spyOn(fsPromises, "lstat").mockImplementation(async (path, options) => {
    if (path === journalPath && !held) {
      held = true;
      atJournal.resolve(undefined);
      return journalMetadata.promise;
    }
    return originalLstat(path, options);
  });
  syncBuiltinESMExports();

  let observedUnlink = false;
  function observeCommit() {
    const spy = vi.spyOn(DatabaseSync.prototype, "exec");
    spy.mockImplementation(function (this: DatabaseSync, sql: string) {
      // Forward through the restored method with its real SQLite receiver.
      spy.mockRestore();
      if (sql !== "COMMIT") {
        this.exec(sql);
        observeCommit();
        return;
      }
      // Hold an inode reference while the other real SQLite create commits.
      // Replaying its real, zero-link stat at the paused lstat boundary makes
      // the kernel's lookup/unlink/getattr ordering deterministic; no fake Stats.
      const descriptor = openSync(journalPath, "r");
      try {
        this.exec(sql);
        const metadata = fstatSync(descriptor);
        expect(metadata.isFile()).toBe(true);
        expect(metadata.nlink).toBe(0);
        observedUnlink = true;
        journalMetadata.resolve(metadata);
      } finally {
        closeSync(descriptor);
      }
    });
  }
  observeCommit();

  const first = resolvePrivateLocalCreateStore(root, "paused-create");
  await atJournal.promise;
  const stores = await Promise.all([
    first,
    resolvePrivateLocalCreateStore(root, "committing-create"),
  ]);
  expect(observedUnlink).toBe(true);
  expect(new Set(stores.map(({ agentId }) => agentId)).size).toBe(2);
  await expect(
    resolvePrivateLocalCreateStore(root, "paused-create"),
  ).resolves.toEqual(stores[0]);
  await expect(
    resolvePrivateLocalCreateStore(root, "committing-create"),
  ).resolves.toEqual(stores[1]);
});

it("does not replay one Local create receipt into a sibling Session", async () => {
  const root = await temporaryProject();
  const parent = {
    agentId: "local_store_parent",
    sessionId: "parent-session",
  };
  const sibling = { ...parent, sessionId: "sibling-session" };
  type ResolveForCreator = (
    root: string,
    requestId: string,
    creator: Readonly<{ agentId: string; sessionId: string }>,
  ) => ReturnType<typeof resolvePrivateLocalCreateStore>;
  // SAFETY: The deliberate widening lets this regression test run against the
  // pre-fix helper, whose two-argument type omitted creator identity. Runtime
  // arguments stay ordinary strings, and the test asserts the refusal contract.
  const resolveForCreator = resolvePrivateLocalCreateStore as ResolveForCreator;
  const first = await resolveForCreator(root, "bound-create", parent);

  await expect(
    resolveForCreator(root, "bound-create", sibling),
  ).rejects.toMatchObject({ reason: "request_conflict" });
  await expect(
    resolveForCreator(root, "bound-create", parent),
  ).resolves.toEqual(first);
});

it("refuses an unbound legacy create receipt without adopting its Agent", async () => {
  const root = await temporaryProject();
  const original = await resolvePrivateLocalCreateStore(root, "legacy-create");
  const receiptPath = join(
    root,
    ".fungi",
    "agents",
    "local-agent-create-receipts.sqlite",
  );
  const database = new DatabaseSync(receiptPath);
  try {
    database.exec(`
      DROP TABLE local_agent_create_receipts;
      CREATE TABLE local_agent_create_receipts (
        request_id TEXT PRIMARY KEY NOT NULL,
        agent_id TEXT NOT NULL UNIQUE,
        name TEXT
      ) WITHOUT ROWID;
    `);
    database
      .prepare(
        "INSERT INTO local_agent_create_receipts (request_id, agent_id, name) VALUES (?, ?, ?)",
      )
      .run("legacy-create", original.agentId, null);
  } finally {
    database.close();
  }

  await expect(
    resolvePrivateLocalCreateStore(root, "legacy-create", {
      agentId: "local_store_creator",
      sessionId: "creator-session",
    }),
  ).rejects.toMatchObject({
    name: "AgentCreateRefused",
    reason: "request_conflict",
    message: "the Local Agent create receipt is unbound; use a fresh requestId",
  });

  const reopened = new DatabaseSync(receiptPath);
  try {
    expect(
      reopened
        .prepare(
          "SELECT request_id, agent_id, name FROM local_agent_create_receipts WHERE request_id = ?",
        )
        .get("legacy-create"),
    ).toEqual({
      request_id: "legacy-create",
      agent_id: original.agentId,
      name: null,
    });
  } finally {
    reopened.close();
  }

  const fresh = await resolvePrivateLocalCreateStore(root, "fresh-create", {
    agentId: "local_store_creator",
    sessionId: "creator-session",
  });
  expect(fresh.agentId).not.toBe(original.agentId);
});

it.each(["receipt", "journal"])(
  "still refuses a planted hard link, symlink or directory at the %s path",
  async (kind) => {
    const root = await temporaryProject();
    const outside = await temporaryProject();
    const original = join(outside, "untouched");
    await writeFile(original, "not a Local receipt");
    const agents = join(root, ".fungi", "agents");
    await mkdir(agents, { recursive: true });
    const path = join(
      agents,
      `local-agent-create-receipts.sqlite${kind === "journal" ? "-journal" : ""}`,
    );
    for (const plant of [
      () => link(original, path),
      () => symlink(original, path),
      () => mkdir(path),
    ]) {
      await plant();
      await expect(
        resolvePrivateLocalCreateStore(root, `refused-${kind}`),
      ).rejects.toThrow(
        "Local Agent create receipt is not a unique project file",
      );
      expect(await readFile(original, "utf8")).toBe("not a Local receipt");
      await rm(path, { recursive: true });
    }
  },
);

// Await the receipts as the completion signal; 640 SQLite commits can outlast
// Vitest's default five seconds when other gate builds share the host.
it("resolves concurrent creates while each commit removes the SQLite journal", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-local-create-receipt-")),
  );
  roots.push(root);
  const agentIds = new Set<string>();
  // Every commit deletes the rollback journal that a concurrent create may have
  // just observed. Many parallel creates widen that window without timing hooks.
  for (let round = 0; round < 40; round += 1) {
    const stores = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        resolvePrivateLocalCreateStore(
          root,
          `request-${String(round)}-${String(index)}`,
        ),
      ),
    );
    for (const { agentId } of stores) agentIds.add(agentId);
  }
  expect(agentIds.size).toBe(40 * 16);
}, 60_000);
