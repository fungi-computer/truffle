import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, spyOn } from "bun:test";
import { sleep, spawn } from "bun";

import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import { serviceLogRecordBytes } from "../src/private-local-service-log.js";
import { z } from "zod";
import { terminatePrivateLocalService } from "../src/private-local-service-termination.js";
import { readOwnProcessStart } from "../src/private-local-process-identity.js";
import {
  readLiveServiceStatus,
  readServiceRecord,
  serviceDirectory,
  type ServiceRecord,
} from "../src/private-local-service-discovery.js";

const fixture = join(import.meta.dir, "fixtures", "owned-session-service.ts");
const drainTimeoutRecord = z.object({
  source: z.literal("local-service"),
  event: z.literal("drain-timeout"),
  deadlineMs: z.literal(4_000),
  phase: z.string(),
  unfinishedOwners: z.array(z.string()),
  unfinishedOwnerCount: z.number().int(),
});

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
}

/** A real listener process owning an open Session, under a throwaway HOME. */
async function serviceOwningASession(mode: "hang" | "drain") {
  const home = await mkdtemp(join(tmpdir(), "fungi-stop-home-"));
  const directory = await serviceDirectory(join(home, ".fungi", "service"));
  const root = join(home, "project");
  await mkdir(root);
  const databasePath = join(root, "agent.sqlite");
  new DatabaseSync(databasePath).close();
  const child = spawn(
    [process.execPath, fixture, directory, databasePath, mode],
    {
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const exitedAt = child.exited.then(() => Date.now());
  const diagnostics = new Response(child.stderr).text();
  /** Milliseconds from the fixture receiving SIGTERM until its process ended. */
  const sinceSigterm = async () => {
    const ended = await exitedAt;
    const reported = /^sigterm (\d+)$/mu.exec(
      await new Response(child.stdout).text(),
    );
    if (reported?.[1] === undefined)
      throw new Error("The fixture never received SIGTERM");
    return ended - Number(reported[1]);
  };
  const close = async () => {
    child.kill("SIGKILL");
    await child.exited;
    await rm(home, { recursive: true, force: true });
  };
  try {
    let record: ServiceRecord | undefined;
    for (let attempt = 0; attempt < 200 && record === undefined; attempt += 1) {
      record = await readServiceRecord(directory);
      if (record === undefined) await sleep(25);
    }
    if (record === undefined) throw new Error("Fixture service did not start");
    const manager = createPrivateLocalServiceManager({ directory });
    // Stop after active Session ownership: the service now owns this store.
    const connection = await manager.connect({
      invocationRoot: root,
      databasePath,
      sessionId: "main",
    });
    await connection.close();
    return {
      directory,
      record,
      manager,
      child,
      sinceSigterm,
      diagnostics,
      close,
    };
  } catch (cause) {
    await close();
    throw cause;
  }
}

async function expectCleared(directory: string, record: ServiceRecord) {
  expect(await readServiceRecord(directory)).toBeUndefined();
  expect(await exists(join(directory, "owner.lock"))).toBe(false);
  expect(await readLiveServiceStatus(record)).toEqual({ kind: "not-running" });
}

describe("fungi stop", () => {
  it("a listener with a stuck Agent exits on its own drain deadline and names that owner", async () => {
    const service = await serviceOwningASession("hang");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      service.child.kill("SIGTERM");
      const exited = await Promise.race([
        service.child.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => {
            resolve(false);
          }, 5_000);
        }),
      ]);
      expect(exited).toBe(true);
      expect(service.child.signalCode).toBeNull();
      expect(service.child.exitCode).not.toBe(0);
      expect(await service.sinceSigterm()).toBeLessThan(5_000);
      // The real background service has no stderr; the record must land in
      // its private service log, within the per-record byte bound.
      const lines = (
        await readFile(join(service.directory, "service.jsonl"), "utf8")
      )
        .split("\n")
        .filter((line) => line.length > 0);
      for (const line of lines)
        expect(Buffer.byteLength(line) + 1).toBeLessThanOrEqual(
          serviceLogRecordBytes,
        );
      const drains = lines
        .map((line) => drainTimeoutRecord.safeParse(JSON.parse(line)))
        .filter((record) => record.success)
        .map((record) => record.data);
      expect(drains).toHaveLength(1);
      expect(drains[0]?.phase).toBe("owners");
      expect(drains[0]?.unfinishedOwners).toContain("stop-agent");
      expect(await service.diagnostics).not.toContain("drain-timeout");
    } finally {
      clearTimeout(timeout);
      await service.close();
    }
  }, 15_000);

  it("stops a well-behaved service on SIGTERM without SIGKILL and clears service.json, its owner lock and its port", async () => {
    const service = await serviceOwningASession("drain");
    try {
      expect(await service.manager.stop()).toEqual({ kind: "stopped" });
      // Well inside the 5 s grace, counted from SIGTERM itself.
      expect(await service.sinceSigterm()).toBeLessThan(4_000);
      expect(service.child.signalCode).toBeNull();
      await expectCleared(service.directory, service.record);
    } finally {
      await service.close();
    }
  }, 30_000);

  it("kills a stopped process that cannot dispatch SIGTERM after about five seconds and clears its record, owner lock and port", async () => {
    const service = await serviceOwningASession("hang");
    try {
      // Freeze this owned process so neither its signal handler nor its own
      // drain deadline can run. The external SIGKILL fallback still matters.
      service.child.kill("SIGSTOP");
      const started = Date.now();
      expect(await service.manager.stop()).toEqual({ kind: "killed" });
      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(4_900);
      expect(elapsed).toBeLessThan(7_000);
      expect(service.child.signalCode).toBe("SIGKILL");
      await expectCleared(service.directory, service.record);
      // The next client starts a fresh service without manual intervention.
      const next = await service.manager.start();
      expect(next.serviceId).not.toBe(service.record.serviceId);
      expect(await service.manager.stop()).toEqual({ kind: "stopped" });
    } finally {
      await service.close();
    }
  }, 30_000);

  it("refuses to signal its own process, where an in-process listener runs", async () => {
    await assert.rejects(
      terminatePrivateLocalService(".", {
        pid: process.pid,
        startedAt: await readOwnProcessStart(),
      }),
      /runs inside this process/u,
    );
  });

  it("names another user's service process and how to stop it instead of a raw EPERM", async () => {
    const service = await serviceOwningASession("drain");
    const kill = process.kill.bind(process);
    const signals = spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === service.child.pid && signal === "SIGTERM")
        throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      return kill(pid, signal);
    });
    try {
      await assert.rejects(service.manager.stop(), {
        message: `The Fungi service process ${String(service.child.pid)} belongs to another user, so fungi stop may not signal it. Stop it as that user (for example \`sudo kill ${String(service.child.pid)}\`), then retry.`,
      });
      expect(await service.manager.status()).toMatchObject({
        pid: service.child.pid,
      });
    } finally {
      signals.mockRestore();
      await service.close();
    }
  }, 30_000);
});
