import { expect, spyOn, test } from "bun:test";
import { heapStats } from "bun:jsc";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  encodeServiceLogRecord,
  serviceLogRecordBytes,
} from "../src/private-local-service-log.js";

const fixtureRoot = fileURLToPath(
  new URL("../../../.botanical/service-log-fixtures/", import.meta.url),
);

async function ownedFixture(prefix: string) {
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  return mkdtemp(join(fixtureRoot, prefix));
}

test("real Bun count maps are preserved in full when the encoded sample fits", () => {
  const heap = heapStats();
  const record = {
    source: "local-service",
    timestamp: new Date().toISOString(),
    pid: process.pid,
    version: "source",
    event: "memory",
    rss: process.memoryUsage().rss,
    heap,
  } satisfies Parameters<typeof encodeServiceLogRecord>[0];
  const unboundedBytes = Buffer.byteLength(JSON.stringify(record) + "\n");
  const line = encodeServiceLogRecord(record);
  expect(Buffer.byteLength(line)).toBeLessThanOrEqual(serviceLogRecordBytes);
  if (unboundedBytes <= serviceLogRecordBytes)
    expect(JSON.parse(line)).toEqual(record);
  else {
    const summary = z
      .object({
        heap: z.object({
          objectTypeCounts: z.object({
            status: z.literal("omitted-byte-bound"),
            typeCount: z.number().int(),
          }),
        }),
      })
      .parse(JSON.parse(line));
    expect(summary.heap.objectTypeCounts.typeCount).toBe(
      Object.keys(heap.objectTypeCounts).length,
    );
  }
});

test("Local source process persists its real version and SIGTERM lifecycle in private files under umask 022", async () => {
  const entry = new URL(
    "../src/private-local-service-process.ts",
    import.meta.url,
  );
  const { readServiceRecord } =
    await import("../src/private-local-service-discovery.js");
  const root = await ownedFixture("lifecycle-");
  const home = join(root, "home");
  const directory = join(home, ".fungi", "service");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await mkdir(join(home, "tmp"), { recursive: true, mode: 0o700 });
  // spawn inherits the mask synchronously. Restore it before any await so
  // other fixtures do not inherit this test's process-global setting.
  const previousMask =
    process.platform === "win32" ? undefined : process.umask(0o022);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [fileURLToPath(entry), directory], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: join(home, "tmp"),
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_CACHE_HOME: join(home, "cache"),
      },
      stdio: "ignore",
    });
  } finally {
    if (previousMask !== undefined) process.umask(previousMask);
  }
  const exited = once(child, "exit");
  const pid = z.number().int().positive().parse(child.pid);
  try {
    let registration = await readServiceRecord(directory);
    for (
      let attempt = 0;
      registration === undefined && attempt < 100;
      attempt++
    ) {
      await delay(100);
      registration = await readServiceRecord(directory);
    }
    assert.ok(registration, "Owned fixture did not register");
    expect(registration.pid).toBe(pid);
    child.kill("SIGTERM");
    await exited;
    if (process.platform !== "win32")
      expect((await stat(join(directory, "service.jsonl"))).mode & 0o777).toBe(
        0o600,
      );
    const records = [];
    const lines = createInterface({
      input: createReadStream(join(directory, "service.jsonl")),
    });
    const lifecycleSchema = z.object({
      source: z.literal("local-service"),
      event: z.string(),
      pid: z.number().int(),
      version: z.string(),
      reason: z
        .enum(["SIGINT", "SIGTERM", "startup-failure", "runtime-failure"])
        .optional(),
    });
    try {
      for await (const line of lines)
        records.push(lifecycleSchema.parse(JSON.parse(line)));
    } finally {
      lines.close();
    }
    expect(records.map((record) => record.event)).toEqual([
      "starting",
      "ready",
      "stopping",
      "stopped",
    ]);
    expect(
      records.every(
        (record) =>
          record.pid === pid && record.version === registration.version,
      ),
    ).toBe(true);
    expect(records.at(-1)?.reason).toBe("SIGTERM");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);

test("listener disposes diagnostics before removing registration and releasing its owner", async () => {
  const { createPrivateLocalServiceShutdown } =
    await import("../src/private-local-service-listener.js");
  const order: string[] = [];
  const shutdown = createPrivateLocalServiceShutdown({
    closeOwners: () => {
      order.push("owners");
      return Promise.resolve();
    },
    closeServer: () => {
      order.push("listener");
      return Promise.resolve();
    },
    closeDiagnostics: () => {
      order.push("diagnostics");
    },
    removeRecord: () => {
      order.push("registration");
      return Promise.resolve();
    },
    releaseOwner: () => {
      order.push("lease");
      return Promise.resolve();
    },
  });
  await Promise.all([shutdown.finish(), shutdown.finish()]);
  expect(order).toEqual([
    "owners",
    "listener",
    "diagnostics",
    "registration",
    "lease",
  ]);
});

test("status is a read and does not create an absent service directory", async () => {
  const { createPrivateLocalServiceManager } =
    await import("../src/private-local-service.js");
  const root = await ownedFixture("read-only-status-");
  const directory = join(root, "absent-service");
  try {
    expect(
      await createPrivateLocalServiceManager({ directory }).status(),
    ).toBeUndefined();
    expect(fs.existsSync(directory)).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a diagnostics disposal failure cannot strand registration or lease", async () => {
  const { createPrivateLocalServiceShutdown } =
    await import("../src/private-local-service-listener.js");
  const failure = new Error("synthetic-diagnostics-close-failure");
  const order: string[] = [];
  const shutdown = createPrivateLocalServiceShutdown({
    closeOwners: () => {
      order.push("owners");
      return Promise.resolve();
    },
    closeServer: () => {
      order.push("listener");
      return Promise.resolve();
    },
    closeDiagnostics: () => {
      throw failure;
    },
    removeRecord: () => {
      order.push("registration");
      return Promise.resolve();
    },
    releaseOwner: () => {
      order.push("lease");
      return Promise.resolve();
    },
  });
  await shutdown.finish();
  expect(order).toEqual(["owners", "listener", "registration", "lease"]);
});

test("an owned service keeps status and real turns working after a reported native short write", async () => {
  // Application closure is intentionally loaded only for this later proof,
  // never by the separate primitive-only native-fs test file.
  const { runPrivateLocalService } =
    await import("../src/private-local-service-listener.js");
  const { createPrivateLocalServiceManager } =
    await import("../src/private-local-service.js");
  const { readServiceRecord, serviceDirectory, serviceOwnerIsLive } =
    await import("../src/private-local-service-discovery.js");
  const { Shiitake } = await import("@fungi.computer/shiitake");
  const { fauxModel } = await import("@fungi.computer/mule/testing");
  const { fauxAssistantMessage } =
    await import("@earendil-works/pi-ai/providers/faux");
  const { createPrivateSqliteOwner } =
    await import("../src/private-sqlite-owner.js");
  const { createPrivateLocalRuntimeHost } =
    await import("../src/private-local-runtime-host.js");
  const { DatabaseSync } = await import("node:sqlite");
  const { fixtureEffectiveModel, fixtureModelControls, fixtureMailControls } =
    await import("./fixtures/effective-model.js");
  const root = await ownedFixture("service-write-failure-");
  const directory = await serviceDirectory(join(root, "service"));
  const databasePath = join(root, "agent.sqlite");
  new DatabaseSync(databasePath).close();
  const faux = fauxModel([]);
  faux.setResponses([fauxAssistantMessage("real post-fault reply")]);
  const writes = spyOn(fs, "writeSync");
  const running = runPrivateLocalService(directory, async () => {
    const database = new DatabaseSync(databasePath);
    const agent = await Shiitake.make({
      store: createPrivateSqliteOwner(database),
      extensions: { roster: [], grants: [] },
      runtime: createPrivateLocalRuntimeHost(),
      instructions: {
        load: () =>
          Promise.resolve({ revision: "log-fixture", text: "Answer" }),
      },
      model: {
        acquire: () =>
          Promise.resolve({
            model: faux.model,
            retryable: () => false,
            stream: faux.stream,
            release: () => Promise.resolve(),
          }),
      },
    });
    return {
      databasePath,
      agentId: "logging-fixture",
      name: "fixture",
      getSession: agent.session,
      listSessions: agent.listSessions,
      createSession: agent.createSession,
      deleteSession: agent.deleteSession,
      extensions: agent.extensions,
      effectiveModel: fixtureEffectiveModel,
      ...fixtureModelControls,
      ...fixtureMailControls,
      bindSessionPath: () => true,
      close: async () => {
        await agent.close();
        database.close();
      },
    };
  });
  let started = false;
  try {
    const manager = createPrivateLocalServiceManager({ directory });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await manager.status()) {
        started = true;
        break;
      }
      await Bun.sleep(10);
    }
    expect(started).toBe(true);
    const before = await manager.status();
    if (before === undefined) throw new Error("Owned service did not start");
    expect(before.diagnostics).toEqual({ state: "active" });
    const record = await readServiceRecord(directory);
    expect(record).not.toHaveProperty("diagnostics");
    // Fault injection at the maintained SDK count boundary, not a mock of the
    // diagnostics owner. No OS-generated short-write claim is made.
    writes.mockReturnValueOnce(1);
    const prefix = `${before.baseUrl}/service/${before.serviceId}`;
    // A real request failure asks the safe reporter to write, falsifying that
    // diagnostics can escape the Hono boundary or poison later status/turns.
    expect(
      (
        await fetch(`${prefix}/select`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(400);
    const first = await manager.status();
    if (first === undefined) throw new Error("Live status missing");
    expect(first.diagnostics).toMatchObject({
      state: "failed",
      code: "sink-write-failed",
    });
    const failedSize = (await stat(join(directory, "service.jsonl"))).size;
    const connection = await manager.connect({
      invocationRoot: root,
      databasePath,
      sessionId: "main",
    });
    try {
      await connection.session.command({
        type: "prompt",
        delivery: "followUp",
        requestId: "post-log-fault",
        text: "Answer",
      });
      let replied = false;
      for (let attempt = 0; attempt < 200; attempt++) {
        const inspection = await manager.inspect({
          invocationRoot: root,
          databasePath,
          sessionId: "main",
        });
        try {
          expect(inspection.diagnostics).toEqual(first.diagnostics);
          replied = JSON.stringify(inspection.snapshot).includes(
            "real post-fault reply",
          );
        } finally {
          await inspection.close();
        }
        if (replied) break;
        await Bun.sleep(10);
      }
      expect(replied).toBe(true);
    } finally {
      await connection.close();
    }
    expect((await manager.status())?.diagnostics).toEqual(first.diagnostics);
    expect((await manager.status())?.serviceId).toBe(before.serviceId);
    expect(JSON.stringify(first)).not.toContain(root);
    expect((await stat(join(directory, "service.jsonl"))).size).toBe(
      failedSize,
    );
  } finally {
    try {
      if (started) process.emit("SIGTERM", "SIGTERM");
      await running;
      expect(await readServiceRecord(directory)).toBeUndefined();
      expect(await serviceOwnerIsLive(directory)).toBe(false);
    } finally {
      writes.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  }
}, 20_000);
