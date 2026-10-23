import { expect, test } from "bun:test";
import { mkdtemp, readdir, readlink, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPrivateWritableSqliteDatabase } from "../src/private-sqlite-owner.js";

test("Bun writable SQLite preserves timeout, foreign keys, transactions and changes", () => {
  const database = openPrivateWritableSqliteDatabase(":memory:", 125);
  try {
    expect(database.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(125);
    expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    database.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
    database.exec(
      "CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))",
    );
    expect(database.prepare("SELECT * FROM parent").get()).toBeUndefined();
    expect(() =>
      database.prepare("INSERT INTO child VALUES (?)").run(1),
    ).toThrow();
    expect(database.isTransaction).toBe(false);
    database.exec("BEGIN IMMEDIATE");
    expect(database.isTransaction).toBe(true);
    expect(
      database.prepare("INSERT INTO parent VALUES (?)").run(1).changes,
    ).toBe(1);
    database.exec("ROLLBACK");
    expect(database.isTransaction).toBe(false);
    expect(database.prepare("SELECT * FROM parent").get()).toBeUndefined();
  } finally {
    database.close();
  }
});

/** Count only this owned process's descriptors, without requesting collection. */
async function openFiles(paths: readonly string[]) {
  const counts = new Map(paths.map((path) => [path, 0]));
  for (const fd of await readdir("/proc/self/fd")) {
    let target: string;
    try {
      target = await readlink(`/proc/self/fd/${fd}`);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        continue;
      throw cause;
    }
    const count = counts.get(target);
    if (count !== undefined) counts.set(target, count + 1);
  }
  return Object.fromEntries(counts);
}

test("closing an Agent and its create receipt releases their files without GC", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "b1-agent-")));
  const home = process.env.HOME;
  process.env.HOME = root;
  try {
    const { openPrivateLocalRuntimeHost } =
      await import("../src/private-local-runtime-host.js");
    const host = await openPrivateLocalRuntimeHost({
      invocationRoot: root,
      createRequestId: "close-frees-files",
    });
    const paths = [
      host.databasePath,
      `${host.databasePath}.owner.sqlite`,
      join(root, ".fungi", "agents", "local-agent-create-receipts.sqlite"),
    ];
    try {
      await host.session.read();
      const before = await openFiles(paths);
      expect(before[host.databasePath]).toBeGreaterThan(0);
    } finally {
      await host.close();
    }
    expect(await openFiles(paths)).toEqual(
      Object.fromEntries(paths.map((path) => [path, 0])),
    );
  } finally {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
    await rm(root, { recursive: true, force: true });
  }
});

test("releasing a service lease releases its file without GC, independently of Agent close", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "b1-lease-")));
  try {
    const { acquireServiceOwnerLease, readServiceLeaseOwner } =
      await import("../src/private-local-service-lease.js");
    const path = join(directory, "owner.sqlite");
    const release = await acquireServiceOwnerLease(directory);
    try {
      expect((await readServiceLeaseOwner(directory))?.pid).toBe(process.pid);
      // The lease is a durable identity row, not a connection held until release.
      expect(await openFiles([path])).toEqual({ [path]: 0 });
    } finally {
      release();
    }
    expect(await openFiles([path])).toEqual({ [path]: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
