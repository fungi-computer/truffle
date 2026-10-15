import { localServiceIds } from "../src/private-local-service-ids.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, spyOn } from "bun:test";
import { serve } from "bun";

import {
  acquireServiceLock,
  handshake,
  readLiveServiceStatus,
  readServiceRecord,
  removeOwnedServiceRecord,
  serviceDirectory,
} from "../src/private-local-service-discovery.js";

describe("private Local service discovery", () => {
  it("classifies a refused recorded service without logging raw errors", async () => {
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (): Response => new Response(),
    });
    const record = {
      serviceId: localServiceIds.service.generate(),
      baseUrl: server.url.origin,
    };
    await server.stop(true);
    const errors = spyOn(console, "error");
    try {
      expect(await readLiveServiceStatus(record)).toEqual({
        kind: "not-running",
      });
      expect(await handshake(record)).toBe(false);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("releases a live owner after the lock heartbeat interval", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-owner-lifetime-"));
    const lock = join(root, "owner.lock");
    const release = await acquireServiceLock(root, "owner");
    try {
      await delay(6_500);
      expect(await stat(lock)).toBeDefined();
      await assert.rejects(acquireServiceLock(root, "owner"));
      await release();
      await assert.rejects(stat(lock), { code: "ENOENT" });
      const restarted = await acquireServiceLock(root, "owner");
      await restarted();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  it("does not surrender a live owner when a heartbeat timestamp becomes stale", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-owner-lease-"));
    const first = await acquireServiceLock(root, "owner");
    let second: (() => Promise<void>) | undefined;
    try {
      await utimes(join(root, "owner.lock"), new Date(0), new Date(0));
      await assert.rejects(async () => {
        second = await acquireServiceLock(root, "owner");
      }, /database is locked/u);
      expect(second).toBeUndefined();
    } finally {
      await second?.();
      await first();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses to take a stale owner lock left by an older service", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-legacy-owner-"));
    const lock = join(root, "owner.lock");
    await mkdir(lock);
    await utimes(lock, new Date(0), new Date(0));
    try {
      await assert.rejects(
        acquireServiceLock(root, "owner"),
        /previous Fungi service/u,
      );
      expect(await stat(lock)).toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("recovers a marked owner lock after its process-held lease is gone", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-dead-owner-"));
    const lock = join(root, "owner.lock");
    await mkdir(lock);
    await writeFile(join(lock, "sqlite-owner"), "");
    try {
      const release = await acquireServiceLock(root, "owner");
      await release();
      await assert.rejects(stat(lock), { code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("does not remove a newer service record when an orphan exits", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-record-handoff-"));
    const oldServiceId = localServiceIds.service.generate();
    const next = {
      serviceId: localServiceIds.service.generate(),
      baseUrl: "http://127.0.0.1:43210",
    };
    await writeFile(join(root, "service.json"), JSON.stringify(next));
    try {
      await removeOwnedServiceRecord(root, oldServiceId);
      expect(await readServiceRecord(root)).toEqual(next);
      await removeOwnedServiceRecord(root, next.serviceId);
      expect(await readServiceRecord(root)).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("decodes a private record but trusts only the matching live handshake", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-discovery-"));
    const directory = await serviceDirectory(join(root, "service"));
    const serviceId = localServiceIds.service.generate();
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (): Response =>
        Response.json({ serviceId, baseUrl: server.url.origin }),
    });
    await writeFile(
      join(directory, "service.json"),
      JSON.stringify({ serviceId, baseUrl: server.url.origin }),
      { mode: 0o600 },
    );
    try {
      const record = await readServiceRecord(directory);
      if (record === undefined) throw new Error("Expected a service record");
      expect(await handshake(record)).toBe(true);
      expect(
        await handshake({
          ...record,
          serviceId: localServiceIds.service.generate(),
        }),
      ).toBe(false);
    } finally {
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a record outside the loopback HTTP boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-record-"));
    await mkdir(root, { recursive: true });
    await writeFile(
      join(root, "service.json"),
      JSON.stringify({
        serviceId: localServiceIds.service.generate(),
        baseUrl: "https://example.com",
      }),
    );
    try {
      await assert.rejects(readServiceRecord(root));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
