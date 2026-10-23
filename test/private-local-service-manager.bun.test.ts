import { logEvent } from "../src/log-event.js";
import { localServiceIds } from "../src/private-local-service-ids.js";
import { readOwnProcessStart } from "../src/private-local-process-identity.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { describe, expect, it, spyOn } from "bun:test";
import { serve } from "bun";
import { z } from "zod";

import {
  createPrivateLocalServiceManager,
  LocalAgentSelectionAmbiguous,
  LocalServiceUnreadableResponse,
} from "../src/private-local-service.js";
import {
  acquireServiceLock,
  handshake,
  privateLocalServiceProtocol,
  readServiceRecord,
  serviceDirectory,
  type ServiceRecord,
} from "../src/private-local-service-discovery.js";

// The test process stands in for the recorded service process.
const testProcessStart = await readOwnProcessStart();

describe("private Local service manager", () => {
  it("resume can start a fresh service from a refused recorded service without logging errors", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-dead-service-resume-"));
    const directory = await serviceDirectory(join(root, "service"));
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (): Response => new Response(),
    });
    const record: ServiceRecord = {
      serviceId: localServiceIds.service.generate(),
      protocol: privateLocalServiceProtocol,
      version: "source",
      pid: process.pid,
      startedAt: testProcessStart,
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
      const record: ServiceRecord = {
        serviceId: localServiceIds.service.generate(),
        protocol: privateLocalServiceProtocol,
        version: "source",
        pid: process.pid,
        startedAt: testProcessStart,
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
          // The lease, not HTTP readiness, authorizes termination. This
          // fixture owns it inside the test process, so the self guard wins.
          await assert.rejects(manager.stop(), /runs inside this process/u);
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
  it("names an older service whose service.json has no PID, and its own stop route, instead of a schema error", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-without-pid-"));
    const directory = await serviceDirectory(join(root, "service"));
    // The record an older service wrote before the PID was recorded.
    const serviceId = localServiceIds.service.generate();
    const baseUrl = "http://127.0.0.1:43127";
    await writeFile(
      join(directory, "service.json"),
      JSON.stringify({ serviceId, baseUrl }),
    );
    try {
      const manager = createPrivateLocalServiceManager({
        directory,
        executable: join(directory, "must-not-spawn"),
      });
      const named = (error: Error) =>
        error.name !== "ZodError" &&
        error.message.includes(`${serviceId} on port 43127`) &&
        error.message.includes(
          `curl -X POST ${baseUrl}/service/${serviceId}/stop`,
        ) &&
        error.message.includes(`--internal-service ${directory}`) &&
        error.message.includes(`delete ${join(directory, "service.json")}`);
      await assert.rejects(manager.start(), named);
      await assert.rejects(manager.stop(), named);
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
      JSON.stringify({
        serviceId,
        protocol: privateLocalServiceProtocol,
        version: "source",
        pid: process.pid,
        startedAt: testProcessStart,
        baseUrl,
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: string | URL | Request) => {
        const path = new URL(z.string().parse(input)).pathname;
        if (path.endsWith("/status"))
          return Promise.resolve(
            Response.json({
              diagnostics: { state: "active" },
              serviceId,
              protocol: privateLocalServiceProtocol,
              version: "source",
              pid: process.pid,
              startedAt: testProcessStart,
              baseUrl,
            }),
          );
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
  it("names the saved Agents and the flags that choose one when select finds several", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-ambiguous-"));
    const directory = await serviceDirectory(join(root, "service"));
    const serviceId = localServiceIds.service.generate();
    const baseUrl = "http://127.0.0.1:43125";
    await writeFile(
      join(directory, "service.json"),
      JSON.stringify({
        serviceId,
        protocol: privateLocalServiceProtocol,
        version: "source",
        pid: process.pid,
        startedAt: testProcessStart,
        baseUrl,
      }),
    );
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      (input: string | URL | Request) => {
        const path = new URL(z.string().parse(input)).pathname;
        if (path.endsWith("/status"))
          return Promise.resolve(
            Response.json({
              diagnostics: { state: "active" },
              serviceId,
              protocol: privateLocalServiceProtocol,
              version: "source",
              pid: process.pid,
              startedAt: testProcessStart,
              baseUrl,
            }),
          );
        return Promise.resolve(
          Response.json(
            {
              code: "agent_selection_ambiguous",
              agentIds: ["local_store_first", "local_store_second"],
            },
            { status: 409 },
          ),
        );
      },
      { preconnect: originalFetch.preconnect },
    );
    try {
      const manager = createPrivateLocalServiceManager({ directory });
      await assert.rejects(
        manager.connect({ invocationRoot: root }),
        (error) =>
          error instanceof LocalAgentSelectionAmbiguous &&
          /local_store_first, local_store_second.*--agent.*--db/su.test(
            error.message,
          ),
      );
    } finally {
      globalThis.fetch = originalFetch;
      await rm(root, { recursive: true, force: true });
    }
  });
  describe("a select the service refuses", () => {
    async function connectAnsweredBy(answer: Response) {
      const root = await mkdtemp(join(tmpdir(), "fungi-service-refused-"));
      const directory = await serviceDirectory(join(root, "service"));
      const serviceId = localServiceIds.service.generate();
      const baseUrl = "http://127.0.0.1:43126";
      await writeFile(
        join(directory, "service.json"),
        JSON.stringify({
          serviceId,
          protocol: privateLocalServiceProtocol,
          version: "source",
          pid: process.pid,
          startedAt: testProcessStart,
          baseUrl,
        }),
      );
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        (input: string | URL | Request) => {
          const path = new URL(z.string().parse(input)).pathname;
          if (path.endsWith("/status"))
            return Promise.resolve(
              Response.json({
                diagnostics: { state: "active" },
                serviceId,
                protocol: privateLocalServiceProtocol,
                version: "source",
                pid: process.pid,
                startedAt: testProcessStart,
                baseUrl,
              }),
            );
          return Promise.resolve(answer);
        },
        { preconnect: originalFetch.preconnect },
      );
      try {
        const manager = createPrivateLocalServiceManager({ directory });
        return await manager.connect({ invocationRoot: root }).then(
          () => undefined,
          (error: unknown) => error,
        );
      } finally {
        globalThis.fetch = originalFetch;
        await rm(root, { recursive: true, force: true });
      }
    }
    it("shows the service's own message for an unexpected failure", async () => {
      const error = await connectAnsweredBy(
        Response.json(
          { code: "internal_error", error: "store could not be opened" },
          { status: 500 },
        ),
      );
      expect(error).toEqual(
        new Error(
          "Local service selection failed (500): store could not be opened",
        ),
      );
    });
    it("raises a typed error when a failure carries no readable body", async () => {
      const error = await connectAnsweredBy(
        new Response("Internal Server Error", { status: 500 }),
      );
      expect(error).toBeInstanceOf(LocalServiceUnreadableResponse);
      expect(error).toMatchObject({ status: 500 });
    });
    it("raises the same typed error when the body is JSON of the wrong shape", async () => {
      const error = await connectAnsweredBy(
        Response.json({ message: "boom" }, { status: 500 }),
      );
      expect(error).toBeInstanceOf(LocalServiceUnreadableResponse);
    });
    it("does not read an Agent-selection answer without its Agents as an MCP conflict", async () => {
      const error = await connectAnsweredBy(
        Response.json({ code: "agent_selection_ambiguous" }, { status: 409 }),
      );
      expect(error).toEqual(
        new Error("Local service sent an unreadable Agent selection"),
      );
    });
  });
  describe("a live service that misses its handshake", () => {
    async function liveSlowService(answerAfter: number) {
      const root = await mkdtemp(join(tmpdir(), "fungi-service-busy-"));
      const directory = await serviceDirectory(join(root, "service"));
      const serviceId = localServiceIds.service.generate();
      const baseUrl = "http://127.0.0.1:43124";
      await writeFile(
        join(directory, "service.json"),
        JSON.stringify({
          serviceId,
          protocol: privateLocalServiceProtocol,
          version: "source",
          pid: process.pid,
          startedAt: testProcessStart,
          baseUrl,
        }),
      );
      // The live service's lifetime lease, held exactly as its listener does.
      const releaseOwner = await acquireServiceLock(directory, "owner");
      let statusRequests = 0;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = Object.assign(
        (_input: string | URL | Request, init?: RequestInit) => {
          statusRequests += 1;
          if (statusRequests > answerAfter)
            return Promise.resolve(
              Response.json({
                diagnostics: { state: "active" },
                serviceId,
                protocol: privateLocalServiceProtocol,
                version: "source",
                pid: process.pid,
                startedAt: testProcessStart,
                baseUrl,
              }),
            );
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
    let oversizedInspection = false;
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === `/service/${serviceId}/status`)
          return Response.json({
            diagnostics: { state: "active" },
            serviceId,
            protocol: privateLocalServiceProtocol,
            version: buildId,
            pid: process.pid,
            startedAt: testProcessStart,
            baseUrl: server.url.origin,
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
            routePath: "/agents/00000000-0000-4000-8000-000000000001",
          });
        }
        if (path === `/service/${serviceId}/discover`) {
          discoverRequests += 1;
          return Response.json({
            root,
            agents: [
              {
                agentId: "root",
                databasePath: join(root, "agent.sqlite"),
                sessionCount: 1,
                updatedAt: 2,
              },
            ],
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
            routePath: "/agents/00000000-0000-4000-8000-000000000001",
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
            diagnostics: { state: "active" },
            selected: {
              agentId: "local_store_fixture",
              databasePath: join(root, "agent.sqlite"),
              sessionId: body.sessionId,
              routePath: "/agents/00000000-0000-4000-8000-000000000001",
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
              toolOutput: [],
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
        return new Response(null, { status: 404 });
      },
    });
    const record: ServiceRecord = {
      serviceId,
      protocol: privateLocalServiceProtocol,
      version: buildId,
      pid: process.pid,
      startedAt: testProcessStart,
      baseUrl: server.url.origin,
    };
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
      expect((await manager.status())?.version).toBe(buildId);
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
        `${server.url.origin}/service/${serviceId}/agents/00000000-0000-4000-8000-000000000001/sessions/conversation`,
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
        "/agents/00000000-0000-4000-8000-000000000001/sessions/session_fresh",
      );
      await fresh.close();
      // Another client's expected identity never stops this service.
      expect(await manager.stop(localServiceIds.service.generate())).toEqual({
        kind: "replaced",
      });
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

  it("archives through the service, lists archived Agents, and surfaces a typed refusal", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-archive-"));
    const directory = await serviceDirectory(join(root, "service"));
    const serviceId = localServiceIds.service.generate();
    const archives: unknown[] = [];
    const discoveries: unknown[] = [];
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request: Request): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === "/service/" + serviceId + "/status")
          return Response.json({
            diagnostics: { state: "active" },
            serviceId,
            protocol: privateLocalServiceProtocol,
            version: "source",
            pid: process.pid,
            startedAt: testProcessStart,
            baseUrl: server.url.origin,
          });
        if (path === "/service/" + serviceId + "/discover") {
          discoveries.push(await request.json());
          return Response.json({
            root,
            agents: [
              {
                agentId: "local_store_fixer",
                name: "fixer",
                createdBy: "Shiitake",
                databasePath: join(root, "agent.sqlite"),
                sessionCount: 1,
              },
            ],
            sessions: [],
            problems: [],
          });
        }
        if (path === "/service/" + serviceId + "/archive") {
          const body = z
            .looseObject({ agentId: z.string() })
            .parse(await request.json());
          archives.push(body);
          if (body.agentId === "local_store_busy")
            return Response.json(
              {
                code: "agent_archive_refused",
                reason: "running",
                error: "command command_9 is running; cancel it first",
              },
              { status: 409 },
            );
          return new Response(null, { status: 204 });
        }
        return new Response(null, { status: 404 });
      },
    });
    await writeFile(
      join(directory, "service.json"),
      JSON.stringify({
        serviceId,
        protocol: privateLocalServiceProtocol,
        version: "source",
        pid: process.pid,
        startedAt: testProcessStart,
        baseUrl: server.url.origin,
      }),
      { mode: 0o600 },
    );
    try {
      const manager = createPrivateLocalServiceManager({ directory });
      const listed = await manager.discover(root, { archived: true });
      expect(listed.agents[0]).toMatchObject({
        name: "fixer",
        createdBy: "Shiitake",
      });
      await manager.discover(root);
      expect(discoveries).toEqual([
        { invocationRoot: root, archived: true },
        { invocationRoot: root, archived: false },
      ]);
      await manager.archive({
        invocationRoot: root,
        agentId: "local_store_fixer",
        archived: true,
      });
      await assert.rejects(
        manager.archive({
          invocationRoot: root,
          agentId: "local_store_busy",
          archived: true,
        }),
        {
          name: "AgentArchiveRefused",
          reason: "running",
          message: "command command_9 is running; cancel it first",
        },
      );
      expect(archives).toEqual([
        { invocationRoot: root, agentId: "local_store_fixer", archived: true },
        { invocationRoot: root, agentId: "local_store_busy", archived: true },
      ]);
    } finally {
      await server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });
});
