import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  readServiceRecord,
  selectedSchema,
  sessionDiscoverySchema,
} from "../src/private-local-service-discovery.js";
import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import { readPrivateLocalSessionDiscovery } from "../src/private-local-session-discovery.js";
import {
  createPrivateSqliteOwner,
  openPrivateReadOnlySqliteDatabase,
  privateSqliteFailureCode,
} from "../src/private-sqlite-owner.js";
import {
  ensureAgentDefaultModelTable,
  readAgentDefaultModel,
} from "../src/private-local-agent-default-model.js";
import * as Schema from "effect/Schema";
import type {
  OperatorCommand,
  SessionExtensionSlots,
  TitleCommand,
} from "@fungi.computer/shiitake";
import { subagentsContract } from "@fungi.computer/shiitake-extensions/subagents";
import type { PrivateLocalServiceSelection } from "../src/private-local-service-contract.js";

type FixtureRequest =
  | (PrivateLocalServiceSelection & Readonly<{ limit?: number }>)
  | Readonly<{ command: OperatorCommand | TitleCommand }>;

/** Count the actual child's native connections, not this test runner's handles. */
async function databaseFds(pid: number, paths: readonly string[]) {
  const counts = new Map(paths.map((path) => [path, 0]));
  for (const fd of await readdir(`/proc/${String(pid)}/fd`)) {
    let target: string;
    try {
      target = await readlink(`/proc/${String(pid)}/fd/${fd}`);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        continue;
      throw cause;
    }
    const count = counts.get(target);
    if (count !== undefined) counts.set(target, count + 1);
  }
  return [...counts.values()];
}

test.skipIf(process.platform !== "linux")(
  "real service discovery, inspect and listing release read connections after every concurrent batch",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "local-sqlite-lifetime-"));
    const home = join(root, "home");
    const directory = join(home, ".fungi", "service");
    await mkdir(directory, { recursive: true });
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(
          new URL("../src/private-local-service-process.ts", import.meta.url),
        ),
        directory,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_DATA_HOME: join(home, "data"),
          XDG_CACHE_HOME: join(home, "cache"),
        },
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    const exited = once(child, "exit");
    const pid = child.pid;
    expect(pid).toBeDefined();
    if (pid === undefined) throw new Error("Fixture service did not spawn");
    try {
      let record = await readServiceRecord(directory);
      for (let attempt = 0; record === undefined && attempt < 100; attempt++) {
        await delay(100);
        record = await readServiceRecord(directory);
      }
      if (record === undefined)
        throw new Error("Fixture service did not register");
      expect(record.pid).toBe(pid);
      const base = `${record.baseUrl}/service/${record.serviceId}`;
      async function call(path: string, payload?: FixtureRequest) {
        let options: RequestInit = { signal: AbortSignal.timeout(2_000) };
        if (payload !== undefined)
          options = {
            ...options,
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          };
        const response = await fetch(`${base}${path}`, options);
        expect(response.ok).toBe(true);
        return response.status === 204 ? undefined : response.json();
      }
      const selections: z.infer<typeof selectedSchema>[] = [];
      const projects: [string, string] = [
        join(root, "first"),
        join(root, "second"),
      ];
      for (const project of projects) {
        const path = join(
          project,
          ".fungi",
          "agents",
          "local_store_fixture",
          "agent.sqlite",
        );
        await mkdir(join(path, ".."), { recursive: true });
        new DatabaseSync(path).close();
        const selected = selectedSchema.parse(
          await call("/select", {
            invocationRoot: project,
            databasePath: path,
            clientPath: process.env.PATH,
          }),
        );
        await call(
          `${selected.routePath}/sessions/${selected.sessionId}/command`,
          {
            command: {
              type: "operator",
              author: "operator",
              text: "Retained fixture fact",
              requestId: "seed",
            },
          },
        );
        await call(
          `${selected.routePath}/sessions/${selected.sessionId}/command`,
          {
            command: { type: "title", title: "Retained fixture session" },
          },
        );
        selections.push(selected);
      }
      const expectedFacts: [string, string] = [
        "Retained fixture fact",
        "Retained fixture fact",
      ];
      async function readBatch() {
        await Promise.all(
          selections.map(async (selected, index) => {
            const invocationRoot = projects[index];
            const expectedFact = expectedFacts[index];
            assert.ok(invocationRoot);
            assert.ok(expectedFact);
            const [discovery, inspected, listing] = await Promise.all([
              call("/discover", { invocationRoot }),
              call("/inspect", {
                invocationRoot,
                databasePath: selected.databasePath,
                sessionId: selected.sessionId,
                limit: 1,
              }),
              call(`${selected.routePath}/sessions`),
            ]);
            const discovered = sessionDiscoverySchema.parse(discovery);
            expect(discovered.problems).toEqual([]);
            expect(
              discovered.agents.map((agent) => agent.databasePath),
            ).toEqual([selected.databasePath]);
            expect(
              discovered.sessions.map((session) => session.sessionId),
            ).toEqual([selected.sessionId]);
            expect(JSON.stringify(inspected)).toContain(expectedFact);
            expect(JSON.stringify(listing)).toContain(selected.sessionId);
          }),
        );
      }
      const paths = selections.map((selected) => selected.databasePath);
      const sidecars = paths.map((path) => `${path}.owner.sqlite`);
      const manager = createPrivateLocalServiceManager({ directory });
      // A Session's first projection read starts the sub-agents roster's
      // background refresh, whose Agent listing opens each store read-only.
      // Its connection closes before the refresh publishes the roster, so wait
      // for that publication; later reads within the roster's one-second
      // freshness reuse it without another read.
      for (const [index, selected] of selections.entries()) {
        const connection = await manager.connect(
          {
            invocationRoot: projects[index] ?? root,
            databasePath: selected.databasePath,
            sessionId: selected.sessionId,
          },
          { signal: AbortSignal.timeout(2_000) },
        );
        try {
          const watch = await connection.session.watch();
          try {
            const published = (slots: SessionExtensionSlots) => {
              const slot = slots[subagentsContract.id];
              return slot?.status === "running" && slot.value !== null;
            };
            if (!published(watch.snapshot.extensions))
              for await (const frame of watch.changes)
                if (frame.kind === "update" && published(frame.extensions))
                  break;
          } finally {
            await watch.close();
          }
        } finally {
          await connection.close();
        }
      }
      await readBatch();
      expect(await databaseFds(pid, paths)).toEqual([1, 1]);
      expect(await databaseFds(pid, sidecars)).toEqual([1, 1]);
      for (let batch = 0; batch < 12; batch++) {
        await readBatch();
        expect(await databaseFds(pid, paths)).toEqual([1, 1]);
        expect(await databaseFds(pid, sidecars)).toEqual([1, 1]);
      }
      const connection = await manager.connect(
        {
          invocationRoot: projects[0],
          databasePath: paths[0],
          sessionId: selections[0]?.sessionId,
        },
        { signal: AbortSignal.timeout(2_000) },
      );
      try {
        const watch = await Promise.race([
          connection.session.watch(),
          delay(2_000, undefined, { ref: false }).then(() => {
            throw new Error("Fixture watch did not start");
          }),
        ]);
        try {
          expect(JSON.stringify(watch.snapshot)).toContain(
            "Retained fixture fact",
          );
          const changes = watch.changes[Symbol.asyncIterator]();
          const next = changes.next();
          await connection.session.command({
            type: "operator",
            author: "operator",
            text: "Watched fixture fact",
            requestId: "watched",
          });
          expectedFacts[0] = "Watched fixture fact";
          const change = await Promise.race([
            next,
            delay(2_000, undefined, { ref: false }).then(() => {
              throw new Error("Fixture watch did not publish its change");
            }),
          ]);
          expect(change.done).toBe(false);
        } finally {
          await watch.close();
        }
      } finally {
        await connection.close();
      }
      expect(await databaseFds(pid, paths)).toEqual([1, 1]);

      // A real exclusive SQLite lock exercises error decoding and finally release.
      const lockedPath = paths[1];
      if (lockedPath === undefined)
        throw new Error("Missing second fixture store");
      const blocker = new DatabaseSync(lockedPath);
      try {
        blocker.exec("BEGIN EXCLUSIVE");
        const locked = sessionDiscoverySchema.parse(
          await call("/discover", { invocationRoot: projects[1] }),
        );
        expect(locked.problems).toEqual([{ kind: "in_use" }]);
        expect(await databaseFds(pid, paths)).toEqual([1, 1]);
      } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
      }
      const corruptPath = join(
        projects[0],
        ".fungi",
        "agents",
        "broken",
        "agent.sqlite",
      );
      await mkdir(join(corruptPath, ".."), { recursive: true });
      await writeFile(corruptPath, "damaged SQLite fixture");
      const corrupt = sessionDiscoverySchema.parse(
        await call("/discover", { invocationRoot: projects[0] }),
      );
      expect(corrupt.problems).toEqual([{ kind: "corrupt" }]);
      expect(await databaseFds(pid, [...paths, corruptPath])).toEqual([
        1, 1, 0,
      ]);
      await rm(join(corruptPath, ".."), { recursive: true });

      const controller = new AbortController();
      controller.abort(new Error("Fixture cancelled discovery"));
      await assert.rejects(
        readPrivateLocalSessionDiscovery(projects[0], {
          signal: controller.signal,
        }),
        /Fixture cancelled discovery/u,
      );
      const cancelled = fetch(`${base}/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invocationRoot: projects[0] }),
        signal: controller.signal,
      });
      await assert.rejects(cancelled, /Fixture cancelled discovery/u);
      await readBatch();
      expect(await databaseFds(pid, paths)).toEqual([1, 1]);
    } finally {
      // This child was created here; the current service's ordinary stop is SIGTERM.
      child.kill("SIGTERM");
      const stopped = await Promise.race([
        exited.then(() => true),
        delay(5_000, false, { ref: false }),
      ]);
      if (!stopped) {
        child.kill("SIGKILL");
        const killed = await Promise.race([
          exited.then(() => true),
          delay(5_000, false, { ref: false }),
        ]);
        expect(killed).toBe(true);
      }
      expect(child.exitCode).toBe(0);
      await assert.rejects(readdir(`/proc/${String(pid)}/fd`), {
        code: "ENOENT",
      });
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(process.platform !== "linux")(
  "native read-only failures finalize SQL and decoded statements, rollback and preserve SQLite classifications",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "local-sqlite-failures-"));
    const path = join(root, "agent.sqlite");
    const writer = new DatabaseSync(path);
    writer.exec("CREATE TABLE facts (text TEXT)");
    ensureAgentDefaultModelTable(writer);
    writer.exec(
      "INSERT INTO private_local_model_settings VALUES (1, 'not-json')",
    );
    writer.close();
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        const database = openPrivateReadOnlySqliteDatabase(path);
        try {
          const owner = createPrivateSqliteOwner(database);
          const decode = Schema.decodeUnknownSync(
            Schema.Struct({ count: Schema.Number }),
          );
          expect(() =>
            owner.transactionSync(() =>
              decode(owner.sql.exec("SELECT 'invalid' AS count").one()),
            ),
          ).toThrow();
          // BEGIN would fail here if the decode-failure transaction had not rolled back.
          expect(
            owner.transactionSync(() =>
              owner.sql.exec("SELECT 42 AS count").one(),
            ),
          ).toEqual({ count: 42 });
          expect(() => readAgentDefaultModel(database)).toThrow();
          let observed: ReturnType<typeof privateSqliteFailureCode>;
          const observing = createPrivateSqliteOwner(database, (code) => {
            observed = code;
          });
          expect(() => observing.sql.exec("SELECT * FROM missing")).toThrow();
          expect(observed).toBe("other");
        } finally {
          database.close();
        }
        expect(await databaseFds(process.pid, [path])).toEqual([0]);
      }
      const blocker = new DatabaseSync(path);
      try {
        blocker.exec("BEGIN EXCLUSIVE");
        const database = openPrivateReadOnlySqliteDatabase(path);
        try {
          assert.throws(
            () => database.prepare("SELECT * FROM facts").all(),
            (cause: unknown) => privateSqliteFailureCode(cause) === "busy",
          );
        } finally {
          database.close();
        }
      } finally {
        blocker.exec("ROLLBACK");
        blocker.close();
      }
      // SQLite's Unix VFS may defer closing a descriptor while another
      // connection in this process owns the file lock. Release that owner too.
      expect(await databaseFds(process.pid, [path])).toEqual([0]);
      const notDatabase = join(root, "not-database.sqlite");
      await writeFile(notDatabase, "not a SQLite database");
      // Preserve a real SQLite header but truncate its pages: SQLITE_CORRUPT, not NOTADB.
      await truncate(path, 100);
      for (const [damaged, expected] of [
        [path, "corrupt"],
        [notDatabase, "not_a_database"],
      ]) {
        if (damaged === undefined) throw new Error("Missing damage fixture");
        assert.throws(
          () => {
            const database = openPrivateReadOnlySqliteDatabase(damaged);
            try {
              database.prepare("SELECT * FROM facts").all();
            } finally {
              database.close();
            }
          },
          (cause: unknown) => privateSqliteFailureCode(cause) === expected,
        );
        expect(await databaseFds(process.pid, [damaged])).toEqual([0]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
