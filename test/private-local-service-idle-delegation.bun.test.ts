import { expect, it } from "bun:test";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { spawn, type Subprocess } from "bun";
import { DatabaseSync } from "node:sqlite";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
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
import {
  openPrivateLocalRuntimeHost,
  resolvePrivateLocalCreateStore,
} from "../src/private-local-runtime-host.js";
import { createLocalServiceOwners } from "../src/private-local-service-owner.js";

const fixture = join(import.meta.dir, "fixtures", "delegating-service.ts");

/** Read-only: how many of these files the service process holds open. */
async function openFiles(pid: number, paths: readonly string[]) {
  let count = 0;
  for (const fd of await readdir(`/proc/${String(pid)}/fd`)) {
    let target: string;
    try {
      target = await readlink(`/proc/${String(pid)}/fd/${fd}`);
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        continue;
      throw cause;
    }
    if (paths.includes(target)) count += 1;
  }
  return count;
}

it("orderly shutdown ends event observers before saving recovery", async () => {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-event-observer-stop-")),
  );
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  const directory = join(home, "service");
  const project = join(home, "project");
  await mkdir(directory);
  await mkdir(project);
  const models = createModels();
  const provider = fauxProvider({
    provider: "faux-idle",
    models: [{ id: "idle-model", name: "Idle" }],
  });
  models.setProvider(provider.provider);
  const owners = createLocalServiceOwners(
    (options) =>
      openPrivateLocalRuntimeHost(
        { ...options, providerId: "faux-idle", modelId: "idle-model" },
        models,
      ),
    directory,
    undefined,
    3_600_000,
  );
  let closeResponse: (() => Promise<void>) | undefined;
  try {
    const selected = await owners.select({
      invocationRoot: project,
      sessionId: "main",
    });
    const databasePath = selected.databasePath;
    selected.release();
    const response = await owners.serve(
      { invocationRoot: project, databasePath },
      new Request("http://127.0.0.1/sessions/main/events"),
    );
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    if (response.body === null) throw new Error("Missing Session event body");
    const reader = response.body.getReader();
    closeResponse = () => reader.cancel();
    expect((await reader.read()).done).toBe(false);
    // Keep the real response open: a client's local EventSource.close() does
    // not acknowledge server cancellation. No command or mail is pending.
    await owners.close();
    const saved = z
      .array(z.object({ databasePath: z.string() }))
      .parse(
        JSON.parse(await readFile(join(directory, "owners.json"), "utf8")),
      );
    expect(saved.map((value) => value.databasePath)).toEqual([]);
    // The service ended its observer without waiting for the client to cancel.
    while (!(await reader.read()).done) {
      // Consume any frames already buffered before orderly stop.
    }
  } finally {
    await closeResponse?.();
    await owners.close();
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await rm(home, { recursive: true, force: true });
  }
});

// The live service kept every Agent that had ever delegated: its idle check
// read each delegation's settlement by reopening the child, and at shutdown
// that reopen is refused, so the parent always looked busy and stayed listed.
it.skipIf(process.platform !== "linux")(
  "a real service releases and forgets a parent whose delegation settled, at shutdown and live",
  async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-idle-delegation-")),
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
    const stores = [parent.databasePath, child.databasePath];
    const children: Subprocess[] = [];
    const start = async (sweepMs: number) => {
      const service = spawn(
        [
          process.execPath,
          fixture,
          directory,
          String(sweepMs),
          parent.databasePath,
          child.agentId,
        ],
        {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home },
          stdout: "inherit",
          stderr: "inherit",
        },
      );
      children.push(service);
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const record = await readServiceRecord(directory);
        if (record?.pid === service.pid) return { service, record };
        await Bun.sleep(25);
      }
      throw new Error("The delegating service did not start");
    };
    const listed = async () =>
      z
        .array(z.object({ databasePath: z.string() }))
        .parse(
          JSON.parse(await readFile(join(directory, "owners.json"), "utf8")),
        )
        .map(({ databasePath }) => databasePath);
    try {
      const first = await start(3_600_000);
      const manager = createPrivateLocalServiceManager({ directory });
      const connection = await manager.connect({
        invocationRoot: project,
        databasePath: parent.databasePath,
        sessionId: "main",
      });
      try {
        const watched = await connection.session.watch();
        try {
          await connection.session.command({
            type: "prompt",
            delivery: "followUp",
            requestId: "delegate",
            text: "Delegate this",
          });
          // The child's reply mail wakes the parent for its last answer.
          for await (const frame of watched.changes)
            if (
              frame.kind === "update" &&
              JSON.stringify(frame.messages).includes("Reply received")
            )
              break;
        } finally {
          await watched.close();
        }
      } finally {
        await connection.close();
      }
      expect((await listed()).sort()).toEqual([...stores].sort());

      // A clean shutdown forgets both Agents: their work has all settled.
      first.service.kill("SIGTERM");
      expect(await first.service.exited).toBe(0);
      expect(await listed()).toEqual([]);

      // The restarted service reopens neither.
      const second = await start(20);
      expect(await openFiles(second.record.pid, stores)).toBe(0);

      // Live: once a client has used both, the service's own sweep releases
      // them; wake on each owners.json write instead of on time.
      const live = createPrivateLocalServiceManager({ directory });
      for (const databasePath of stores) {
        const opened = await live.connect({
          invocationRoot: project,
          databasePath,
          sessionId: "main",
        });
        await opened.session.read({ limit: 1 });
        await opened.close();
      }
      const stop = new AbortController();
      const writes = watch(directory, { signal: stop.signal })[
        Symbol.asyncIterator
      ]();
      try {
        while ((await listed()).length > 0) await writes.next();
      } finally {
        stop.abort();
      }
      expect(await listed()).toEqual([]);
      second.service.kill("SIGTERM");
      expect(await second.service.exited).toBe(0);
      expect(await listed()).toEqual([]);
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

it.skipIf(process.platform !== "linux")(
  "shutdown retains a child finishing into undelivered reply mail and restart delivers it",
  async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "fungi-shutdown-reply-")),
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
    const held = Promise.withResolvers<undefined>();
    let retryDueAt: number | undefined;
    const start = async (hold: boolean) => {
      await mkdir(directory, { recursive: true });
      const stop = new AbortController();
      const writes = watch(directory, { signal: stop.signal })[
        Symbol.asyncIterator
      ]();
      const service = spawn(
        [
          process.execPath,
          fixture,
          directory,
          "3600000",
          parent.databasePath,
          child.agentId,
          hold ? "hold-completion" : "resume-reply",
          ...(hold ? [] : [String(retryDueAt)]),
        ],
        {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home },
          stdout: "inherit",
          stderr: "inherit",
          ipc: (message) => {
            z.literal("child-held").parse(message);
            held.resolve(undefined);
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
      const first = await start(true);
      const manager = createPrivateLocalServiceManager({ directory });
      const connection = await manager.connect({
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
        await held.promise;
      } finally {
        await connection.close();
      }
      // No use/admission holds remain. The child is executing an accepted job.
      // SIGTERM makes its parent unreachable. The fixture releases completion
      // during the idle observation (old order) or during close (fixed order).
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
      // Inspect only the disposable child's outbox: its job completed, but
      // stop refused delivery. Restart at that row's due time using the
      // owned process's clock, rather than sleeping through retry backoff.
      const database = new DatabaseSync(child.databasePath);
      try {
        const row = z
          .object({ value: z.string() })
          .parse(
            database.prepare("SELECT value FROM local_birddog_outbox").get(),
          );
        const pending = z
          .object({
            mail: z.object({ content: z.literal("Child result") }),
            attempts: z.literal(1),
            nextAttemptAt: z.number().int().positive(),
          })
          .parse(JSON.parse(row.value));
        retryDueAt = pending.nextAttemptAt;
      } finally {
        database.close();
      }

      const second = await start(false);
      const resumed = createPrivateLocalServiceManager({ directory });
      const parentConnection = await resumed.connect({
        invocationRoot: project,
        databasePath: parent.databasePath,
        sessionId: "main",
      });
      try {
        const watched = await parentConnection.session.watch();
        try {
          // Restart recovery, not a new child request, drains the saved reply.
          if (
            !JSON.stringify(watched.snapshot.messages).includes(
              "Reply received",
            )
          ) {
            for await (const frame of watched.changes)
              if (
                frame.kind === "update" &&
                JSON.stringify(frame.messages).includes("Reply received")
              )
                break;
          }
          const answered = await parentConnection.session.read({ limit: 100 });
          expect(JSON.stringify(answered.messages)).toContain("Reply received");
        } finally {
          await watched.close();
        }
      } finally {
        await parentConnection.close();
      }
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
