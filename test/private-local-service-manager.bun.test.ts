import { logEvent } from "../src/log-event.js";
import { localServiceIds } from "../src/private-local-service-ids.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it, spyOn } from "bun:test";
import { serve } from "bun";
import { z } from "zod";

import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import {
  acquireServiceLock,
  handshake,
  readServiceRecord,
  serviceDirectory,
} from "../src/private-local-service-discovery.js";

describe("private Local service manager", () => {
  it("resume can start a fresh service from a refused recorded service without logging errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-dead-service-resume-"));
    const directory = await serviceDirectory(join(root, "service"));
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
    await writeFile(join(directory, "service.json"), JSON.stringify(record));
    const manager = createPrivateLocalServiceManager({ directory });
    const errors = spyOn(console, "error");
    try {
      const ready = await manager.start();
      expect(ready.serviceId).not.toBe(record.serviceId);
      expect(await manager.status()).toMatchObject(ready);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      try {
        await manager.stop();
      } finally {
        errors.mockRestore();
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 20_000);
  it.each([false, true])(
    "stopping a refused recorded service respects a live owner (%s)",
    async (liveOwner) => {
      const root = await mkdtemp(join(tmpdir(), "fungi-dead-service-"));
      const directory = await serviceDirectory(join(root, "service"));
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
      await writeFile(join(directory, "service.json"), JSON.stringify(record));
      const release = liveOwner
        ? await acquireServiceLock(directory, "owner")
        : undefined;
      const errors = spyOn(console, "error");
      try {
        const manager = createPrivateLocalServiceManager({ directory });
        expect(await manager.status()).toBeUndefined();
        if (liveOwner) {
          await assert.rejects(manager.stop(), /not answering/u);
          expect(await readServiceRecord(directory)).toEqual(record);
        } else {
          expect(await manager.stop()).toEqual({
            kind: "not-running",
            recordCleaned: true,
          });
          expect(await readServiceRecord(directory)).toBeUndefined();
          expect(await manager.stop()).toEqual({
            kind: "not-running",
            recordCleaned: false,
          });
        }
        expect(errors).not.toHaveBeenCalled();
      } finally {
        errors.mockRestore();
        await release?.();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { client: "unbundled installation", buildId: undefined, accepted: false },
    { client: "different bundle", buildId: "b".repeat(64), accepted: false },
    { client: "matching bundle", buildId: "a".repeat(64), accepted: true },
  ])(
    "checks the running build for a $client without stopping it",
    async ({ buildId, accepted }) => {
      const root = await mkdtemp(join(tmpdir(), "fungi-service-build-"));
      const directory = await serviceDirectory(join(root, "service"));
      const serviceId = localServiceIds.service.generate();
      let stopRequests = 0;
      const server = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request): Response {
          if (new URL(request.url).pathname.endsWith("/stop"))
            stopRequests += 1;
          return Response.json({
            serviceId,
            baseUrl: server.url.origin,
            buildId: "a".repeat(64),
          });
        },
      });
      const previous = process.env.FUNGI_BUNDLED_BUILD_ID;
      if (buildId === undefined) delete process.env.FUNGI_BUNDLED_BUILD_ID;
      else process.env.FUNGI_BUNDLED_BUILD_ID = buildId;
      try {
        await writeFile(
          join(directory, "service.json"),
          JSON.stringify({ serviceId, baseUrl: server.url.origin }),
        );
        const manager = createPrivateLocalServiceManager({ directory });
        if (accepted)
          expect(await manager.start()).toMatchObject({ serviceId });
        else
          await assert.rejects(
            manager.start(),
            /different Fungi build.*fungi stop.*Saved Sessions/u,
          );
        expect(await manager.status()).toMatchObject({ serviceId });
        expect(stopRequests).toBe(0);
      } finally {
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_BUILD_ID;
        else process.env.FUNGI_BUNDLED_BUILD_ID = previous;
        await server.stop(true);
        await rm(root, { recursive: true, force: true });
      }
    },
  );
  it("does not spawn a replacement over an untracked older owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-legacy-start-"));
    const directory = await serviceDirectory(join(root, "service"));
    await mkdir(join(directory, "owner.lock"));
    try {
      const manager = createPrivateLocalServiceManager({ directory });
      await assert.rejects(manager.start(), /previous Fungi service/u);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("explains a store held by another service when resume selects it", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-store-in-use-"));
    const directory = await serviceDirectory(join(root, "service"));
    const serviceId = localServiceIds.service.generate();
    const baseUrl = "http://127.0.0.1:43123";
    await writeFile(
      join(directory, "service.json"),
      JSON.stringify({ serviceId, baseUrl }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: string | URL | Request) => {
        const path = new URL(z.string().parse(input)).pathname;
        if (path.endsWith("/status"))
          return Promise.resolve(Response.json({ serviceId, baseUrl }));
        return Promise.resolve(
          Response.json({ code: "store_in_use" }, { status: 409 }),
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const manager = createPrivateLocalServiceManager({ directory });
      await assert.rejects(
        manager.connect({ invocationRoot: root, sessionId: "saved" }),
        /another Fungi service.*older service process.*retry/iu,
      );
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
  describe("a live service that misses its handshake", () => {
    async function liveSlowService(answerAfter: number) {
      const root = await mkdtemp(join(tmpdir(), "fungi-service-busy-"));
      const directory = await serviceDirectory(join(root, "service"));
      const serviceId = localServiceIds.service.generate();
      const baseUrl = "http://127.0.0.1:43124";
      await writeFile(
        join(directory, "service.json"),
        JSON.stringify({ serviceId, baseUrl }),
      );
      // The live service's lifetime lease, held exactly as its listener does.
      const releaseOwner = await acquireServiceLock(directory, "owner");
      let statusRequests = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        (_input: string | URL | Request, init?: RequestInit) => {
          statusRequests += 1;
          if (statusRequests > answerAfter)
            return Promise.resolve(Response.json({ serviceId, baseUrl }));
          // An overloaded service accepts the connection but answers late.
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new Error("status timed out"));
            });
          });
        },
        { preconnect: originalFetch.preconnect },
      );
      return {
        directory,
        serviceId,
        statusRequests: () => statusRequests,
        async close() {
          globalThis.fetch = originalFetch;
          await releaseOwner();
          await rm(root, { recursive: true, force: true });
        },
      };
    }

    it("waits for it instead of spawning a second service", async () => {
      const service = await liveSlowService(1);
      try {
        const manager = createPrivateLocalServiceManager({
          directory: service.directory,
          // Spawning would fail loudly; the live lease must prevent it.
          executable: join(service.directory, "must-not-spawn"),
        });
        const started = await manager.start();
        expect(started.serviceId).toBe(service.serviceId);
        expect(service.statusRequests()).toBe(2);
      } finally {
        await service.close();
      }
    });

    it("names the overloaded service when it never answers", async () => {
      const service = await liveSlowService(Number.POSITIVE_INFINITY);
      try {
        const manager = createPrivateLocalServiceManager({
          directory: service.directory,
          executable: join(service.directory, "must-not-spawn"),
          busyServiceWaitMs: 300,
        });
        await assert.rejects(
          manager.start(),
          /service is running but has not answered.*overloaded/u,
        );
      } finally {
        await service.close();
      }
    });
  });
  it("closing a client leaves the discovered service alive", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-client-"));
    const directory = await serviceDirectory(join(root, "service"));
    const serviceId = localServiceIds.service.generate();
    const buildId = "a".repeat(64);
    const previousBuildId = process.env.FUNGI_BUNDLED_BUILD_ID;
    process.env.FUNGI_BUNDLED_BUILD_ID = buildId;
    let selectRequests = 0;
    let discoverRequests = 0;
    const selectedPaths: string[] = [];
    let stopRequests = 0;
    let oversizedInspection = false;
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === `/service/${serviceId}/status`)
          return Response.json({
            serviceId,
            baseUrl: server.url.origin,
            buildId,
          });
        if (path === `/service/${serviceId}/select`) {
          selectRequests += 1;
          const selection = z
            .object({ clientPath: z.string() })
            .parse(await request.json());
          selectedPaths.push(selection.clientPath);
          return Response.json({
            agentId: "local_store_fixture",
            databasePath: join(root, "agent.sqlite"),
            sessionId: "conversation",
            routePath: "/agents/0",
          });
        }
        if (path === `/service/${serviceId}/discover`) {
          discoverRequests += 1;
          return Response.json({
            root,
            agentCount: 1,
            sessions: [
              {
                databasePath: join(root, "agent.sqlite"),
                sessionId: "conversation",
                title: "Saved work",
                createdAt: 1,
                updatedAt: 2,
              },
            ],
            problems: [],
          });
        }
        if (path === `/service/${serviceId}/sessions`) {
          return Response.json({
            agentId: "local_store_fixture",
            databasePath: join(root, "agent.sqlite"),
            sessionId: "session_fresh",
            routePath: "/agents/0",
          });
        }
        if (path === `/service/${serviceId}/inspect`) {
          if (oversizedInspection)
            return new Response("x".repeat(2_097_153), {
              headers: { "Content-Length": "2097153" },
            });
          const body = z
            .strictObject({
              invocationRoot: z.string(),
              sessionId: z.string(),
              limit: z.literal(100),
            })
            .parse(await request.json());
          return Response.json({
            selected: {
              agentId: "local_store_fixture",
              databasePath: join(root, "agent.sqlite"),
              sessionId: body.sessionId,
              routePath: "/agents/0",
            },
            snapshot: {
              sessionId: body.sessionId,
              cursor: "cursor-1",
              hasMore: false,
              messages: [],
              terminals: [],
              pending: { total: 0, prompts: [], hasMore: false },
              activity: {
                queue: { state: "idle" },
                cancellationRequested: false,
                retry: null,
                activeTool: null,
                lastModelChoiceSequence: null,
                compaction: null,
              },
              progress: null,
              extensions: {},
              attention: [],
            },
          });
        }
        if (path === `/service/${serviceId}/models`)
          return Response.json([
            {
              providerId: "fixture-provider",
              providerName: "Fixture Provider",
              id: "fixture-model",
              name: "Fixture Model",
              reasoning: ["low", "medium"],
            },
          ]);
        if (path === `/service/${serviceId}/stop`) {
          stopRequests += 1;
          return new Response(null, { status: 202 });
        }
        return new Response(null, { status: 404 });
      },
    });
    const record = { serviceId, baseUrl: server.url.origin };
    await writeFile(join(directory, "service.json"), JSON.stringify(record), {
      mode: 0o600,
    });
    let testFailure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      const manager = createPrivateLocalServiceManager({
        directory,
        executionPath: "/toolchain/a:/usr/bin",
      });
      expect((await manager.status())?.buildId).toBe(buildId);
      const otherClient = createPrivateLocalServiceManager({
        directory,
        executionPath: "/toolchain/b:/usr/bin",
      });
      const aborted = new AbortController();
      aborted.abort();
      await assert.rejects(
        manager.connect(
          { invocationRoot: root, sessionId: "never-opened" },
          { signal: aborted.signal },
        ),
        { name: "AbortError" },
      );
      expect(selectRequests).toBe(0);
      expect(await manager.models()).toEqual([
        {
          providerId: "fixture-provider",
          providerName: "Fixture Provider",
          id: "fixture-model",
          name: "Fixture Model",
          reasoning: ["low", "medium"],
        },
      ]);
      const discovered = await manager.discover(root);
      expect(discoverRequests).toBe(1);
      expect(discovered.sessions.map(({ title }) => title)).toEqual([
        "Saved work",
      ]);
      const reopened = await discovered.sessions[0]?.resume();
      expect(reopened?.sessionId).toBe("conversation");
      await reopened?.close();
      expect(selectRequests).toBe(1);
      const connection = await manager.connect({
        invocationRoot: root,
        sessionId: "conversation",
      });
      expect(selectRequests).toBe(2);
      const other = await otherClient.connect({
        invocationRoot: root,
        sessionId: "other",
      });
      await other.close();
      expect(selectedPaths).toEqual([
        "/toolchain/a:/usr/bin",
        "/toolchain/a:/usr/bin",
        "/toolchain/b:/usr/bin",
      ]);
      expect(selectRequests).toBe(3);
      expect(connection.session.address).toBe(
        `${server.url.origin}/service/${serviceId}/agents/0/sessions/conversation`,
      );
      await connection.close();
      const inspected = await manager.inspect({
        invocationRoot: root,
        sessionId: "conversation",
      });
      expect(inspected.snapshot).toMatchObject({
        sessionId: "conversation",
        activity: { queue: { state: "idle" } },
      });
      await inspected.close();
      oversizedInspection = true;
      await assert.rejects(
        manager.inspect({ invocationRoot: root, sessionId: "conversation" }),
        /response is too large/u,
      );
      const fresh = await manager.createSession({
        invocationRoot: root,
        databasePath: connection.databasePath,
        requestId: "manager-session-create-1",
      });
      expect(fresh.databasePath).toBe(connection.databasePath);
      expect(fresh.sessionId).toBe("session_fresh");
      expect(fresh.session.address).toContain(
        "/agents/0/sessions/session_fresh",
      );
      await fresh.close();
      await manager.stop(localServiceIds.service.generate());
      expect(stopRequests).toBe(0);
      expect(await handshake(record)).toBe(true);
    } catch (cause) {
      logEvent("manager-proof.behaviour", cause);
      testFailure = cause;
    } finally {
      if (previousBuildId === undefined)
        delete process.env.FUNGI_BUNDLED_BUILD_ID;
      else process.env.FUNGI_BUNDLED_BUILD_ID = previousBuildId;
      try {
        await server.stop(true);
      } catch (cause) {
        logEvent("manager-proof.stop-server", cause);
        cleanupFailures.push(cause);
      }
      try {
        await rm(root, { recursive: true, force: true });
      } catch (cause) {
        logEvent("manager-proof.remove-fixture", cause);
        cleanupFailures.push(cause);
      }
    }
    if (testFailure !== undefined && cleanupFailures.length > 0)
      throw new AggregateError(
        [testFailure, ...cleanupFailures],
        "Manager proof and cleanup failed",
      );
    if (testFailure !== undefined)
      throw testFailure instanceof Error
        ? testFailure
        : new Error("Manager test failed", { cause: testFailure });
    if (cleanupFailures.length > 0)
      throw new AggregateError(cleanupFailures, "Manager test cleanup failed");
  });
});
