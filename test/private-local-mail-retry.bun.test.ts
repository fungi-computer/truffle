import { expect, it } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  watch,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  readServiceRecord,
  serviceDirectory,
} from "../src/private-local-service-discovery.js";
import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import { resolvePrivateLocalCreateStore } from "../src/private-local-runtime-host.js";

it.skipIf(process.platform !== "linux")(
  "a restart before a reply retry is due delivers it without any client wake",
  async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-mail-retry-")),
    );
    const directory = await serviceDirectory(join(home, ".fungi", "service"));
    const project = join(home, "project");
    await mkdir(project);
    const parent = await resolvePrivateLocalCreateStore(project, "parent");
    const child = await resolvePrivateLocalCreateStore(project, "child");
    for (const path of [parent.databasePath, child.databasePath]) {
      await mkdir(dirname(path), { recursive: true });
      new DatabaseSync(path).close();
    }
    const children: Subprocess[] = [];
    const persisted = Promise.withResolvers<undefined>();
    const delivered = Promise.withResolvers<undefined>();
    const start = async (phase: "withhold" | "deliver") => {
      await mkdir(directory, { recursive: true });
      const stop = new AbortController();
      const writes = watch(directory, { signal: stop.signal })[
        Symbol.asyncIterator
      ]();
      const service = spawn(
        [
          process.execPath,
          join(import.meta.dir, "fixtures", "mail-retry-service.ts"),
          directory,
          parent.databasePath,
          child.agentId,
          phase,
        ],
        {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home },
          stdout: "inherit",
          stderr: "inherit",
          ipc: (message) => {
            const event = z
              .enum(["retry-persisted", "reply-received"])
              .parse(message);
            if (event === "retry-persisted") persisted.resolve(undefined);
            else delivered.resolve(undefined);
          },
        },
      );
      children.push(service);
      try {
        while ((await readServiceRecord(directory))?.pid !== service.pid)
          await writes.next();
      } finally {
        stop.abort();
      }
      return service;
    };
    try {
      const first = await start("withhold");
      const connection = await createPrivateLocalServiceManager({
        directory,
      }).connect({
        invocationRoot: project,
        databasePath: parent.databasePath,
        sessionId: "main",
      });
      try {
        await connection.session.command({
          type: "prompt",
          delivery: "followUp",
          requestId: "delegate",
          text: "Delegate this",
        });
        await persisted.promise;
      } finally {
        await connection.close();
      }
      first.kill("SIGTERM");
      expect(await first.exited).toBe(0);
      const owners = z
        .array(z.object({ databasePath: z.string() }))
        .parse(
          JSON.parse(await readFile(join(directory, "owners.json"), "utf8")),
        );
      expect(owners.map(({ databasePath }) => databasePath)).toContain(
        child.databasePath,
      );
      const database = new DatabaseSync(child.databasePath);
      let dueAt: number;
      try {
        const row = z
          .object({ value: z.string() })
          .parse(
            database.prepare("SELECT value FROM local_birddog_outbox").get(),
          );
        dueAt = z
          .object({
            mail: z.object({ content: z.literal("Child result") }),
            attempts: z.literal(1),
            nextAttemptAt: z.number(),
          })
          .parse(JSON.parse(row.value)).nextAttemptAt;
      } finally {
        database.close();
      }
      const second = await start("deliver");
      expect(Date.now()).toBeLessThan(dueAt);
      // No sleeps, clock changes or client request to either Agent: recovery
      // must retain the real Carrier timer and autonomously deliver when due.
      await delivered.promise;
      expect(Date.now()).toBeGreaterThanOrEqual(dueAt);
      second.kill("SIGTERM");
      expect(await second.exited).toBe(0);
    } finally {
      for (const service of children)
        if (service.exitCode === null) {
          service.kill();
          await service.exited;
        }
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);
