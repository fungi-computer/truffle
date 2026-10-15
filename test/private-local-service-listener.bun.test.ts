import { logEvent } from "../src/log-event.js";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { sleep } from "bun";
import type { ShiitakeSession } from "@fungi.computer/shiitake";
import type { SessionSnapshot } from "@fungi.computer/shiitake";

import {
  handshake,
  selectedSchema,
  readServiceRecord,
  serviceDirectory,
} from "../src/private-local-service-discovery.js";
import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import { runPrivateLocalService } from "../src/private-local-service-listener.js";
import { createPrivateLocalServiceShutdown } from "../src/private-local-service-listener.js";
import { unusedExtensions } from "./fixtures/unused-extensions.js";
import {
  fixtureEffectiveModel,
  fixtureMailControls,
  fixtureModelControls,
} from "./fixtures/effective-model.js";
import { DatabaseSync } from "node:sqlite";
import { Shiitake } from "@fungi.computer/shiitake";
import { fauxModel } from "@fungi.computer/mule/testing";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";
import { createPrivateLocalRuntimeHost } from "../src/private-local-runtime-host.js";

it("restores queued work after service restart without a client selecting the Agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-service-restart-"));
  const directory = await serviceDirectory(join(root, "service"));
  const databasePath = join(root, "agent.sqlite");
  new DatabaseSync(databasePath).close();
  const faux = fauxModel([]);
  faux.setResponses([
    fauxAssistantMessage("background reply"),
    fauxAssistantMessage("second background reply"),
  ]);
  let restarted = false;
  const openRuntime: NonNullable<
    Parameters<typeof runPrivateLocalService>[1]
  > = async () => {
    const database = new DatabaseSync(databasePath);
    const agent = await Shiitake.make({
      store: createPrivateSqliteOwner(database),
      extensions: { roster: [], grants: [] },
      // The first process loses its scheduled callback before it can run.
      runtime: restarted
        ? createPrivateLocalRuntimeHost()
        : {
            bind: () =>
              Promise.resolve({
                commit: (mutation) => mutation(),
                requestWake: () => Promise.resolve(),
                close: () => Promise.resolve(),
              }),
          },
      instructions: {
        load: () => Promise.resolve({ revision: "restart", text: "Answer" }),
      },
      model: {
        acquire: () =>
          Promise.resolve({
            model: faux.model,
            stream: faux.stream,
            release: () => Promise.resolve(),
          }),
      },
    });
    return {
      databasePath,
      agentId: "restart-agent",
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
  };
  async function ready() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const record = await readServiceRecord(directory);
      if (record !== undefined)
        return `${record.baseUrl}/service/${record.serviceId}`;
      await sleep(10);
    }
    throw new Error("Local service did not start");
  }
  let running: Promise<void> | undefined;
  let prefix: string | undefined;
  try {
    running = runPrivateLocalService(directory, openRuntime);
    prefix = await ready();
    const selection = await fetch(`${prefix}/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        invocationRoot: root,
        databasePath,
        sessionId: "main",
        clientPath: "/usr/bin",
      }),
    });
    const selected = selectedSchema.parse(await selection.json());
    for (const requestId of ["before-crash-1", "before-crash-2"]) {
      const accepted = await fetch(
        `${prefix}${selected.routePath}/sessions/main/command`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: {
              type: "prompt",
              delivery: "followUp",
              requestId,
              text: "Run without a watching client",
            },
          }),
        },
      );
      expect(accepted.status).toBe(200);
    }
    await fetch(`${prefix}/stop`, { method: "POST" });
    await running;
    prefix = undefined;
    restarted = true;
    running = runPrivateLocalService(directory, openRuntime);
    prefix = await ready();
    // No /select, Session read or watch is sent to the replacement server.
    for (let attempt = 0; attempt < 100 && faux.state.callCount < 2; attempt++)
      await sleep(10);
    expect(faux.state.callCount).toBe(2);
  } finally {
    if (prefix !== undefined) await fetch(`${prefix}/stop`, { method: "POST" });
    await running;
    await rm(root, { recursive: true, force: true });
  }
});

describe("private Local service listener", () => {
  it("preserves listener discovery and ownership when owner drain rejects", async () => {
    const calls: string[] = [];
    const failure = new Error("owner close failed");
    const shutdown = createPrivateLocalServiceShutdown({
      closeOwners: () => Promise.reject(failure),
      closeServer: () => {
        calls.push("server");
        return Promise.resolve();
      },
      removeRecord: () => {
        calls.push("record");
        return Promise.resolve();
      },
      releaseOwner: () => {
        calls.push("owner-lock");
        return Promise.resolve();
      },
    });

    await assert.rejects(shutdown.finish(), (error) => error === failure);
    expect(shutdown.isDraining()).toBe(true);
    expect(calls).toEqual([]);
    await assert.rejects(shutdown.finish(), (error) => error === failure);
    expect(calls).toEqual([]);
  });

  it("keeps status alive and stop pending until runtime owners finish closing", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-service-stop-"));
    const directory = await serviceDirectory(join(root, "service"));
    await writeFile(join(root, "agent.sqlite"), "fixture");
    const fungiMcp = {
      endpoint: "https://hub.test/api/teams/selected/mcp",
    };
    const closing = Promise.withResolvers<undefined>();
    const sessionPaths = new Map<string, string>();
    const fixtureSnapshot: SessionSnapshot = {
      sessionId: "main",
      cursor: null,
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
    };
    // SAFETY: This fixture invokes only read; the test does not exercise the
    // remaining Shiitake Session methods.
    const fixtureSession = {
      address: "session:main",
      read: () => Promise.resolve(fixtureSnapshot),
    } as ShiitakeSession;
    let modelLists = 0;
    const models = [
      {
        providerId: "fixture-provider",
        providerName: "Fixture Provider",
        id: "fixture-model",
        name: "Fixture Model",
        reasoning: ["low", "medium"] as const,
      },
    ];
    const running = runPrivateLocalService(
      directory,
      (options) => {
        expect(options.fungiMcp?.endpoint.href).toBe(fungiMcp.endpoint);
        expect(options.fungiMcp?.authProvider).toBeDefined();
        return Promise.resolve({
          databasePath: join(root, "agent.sqlite"),
          agentId: "listener-agent",
          listSessions: () =>
            Promise.resolve({ sessions: [], next: undefined }),
          createSession: () => Promise.resolve("fresh-session"),
          deleteSession: () => Promise.resolve(false),
          extensions: unusedExtensions,
          effectiveModel: fixtureEffectiveModel,
          ...fixtureModelControls,
          ...fixtureMailControls,
          getSession: (sessionId) => {
            if (sessionId === "main") return fixtureSession;
            if (sessionId === "inspection-only") {
              // SAFETY: Inspection exercises only this fixture's read method.
              return {
                address: "session:inspection-only",
                read: () =>
                  Promise.resolve({
                    ...fixtureSnapshot,
                    sessionId,
                  }),
              } as ShiitakeSession;
            }
            // SAFETY: Other fixture sessions are used only for identity.
            return { address: `session:${sessionId}` } as ShiitakeSession;
          },
          bindSessionPath: (sessionId, path) => {
            const previous = sessionPaths.get(sessionId);
            if (previous !== undefined && previous !== path) return false;
            sessionPaths.set(sessionId, path);
            return true;
          },
          close: () => closing.promise,
        });
      },
      () => {
        modelLists += 1;
        return Promise.resolve(models);
      },
    );
    let record;
    let testFailure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        record = await readServiceRecord(directory);
        if (record !== undefined) break;
        await sleep(10);
      }
      if (record === undefined) throw new Error("Expected a service record");
      const prefix = `${record.baseUrl}/service/${record.serviceId}`;
      const invalidPath = await fetch(`${prefix}/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invocationRoot: root,
          sessionId: "invalid-path",
          clientPath: "relative:/usr/bin",
        }),
      });
      expect(invalidPath.status).toBe(400);
      expect(await invalidPath.text()).toContain("clientPath");
      const catalogue = await fetch(`${prefix}/models`);
      expect(catalogue.status).toBe(200);
      expect(await catalogue.json()).toEqual(models);
      expect(modelLists).toBe(1);
      const discovery = await fetch(`${prefix}/discover`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invocationRoot: root }),
      });
      expect(discovery.status).toBe(200);
      expect(await discovery.json()).toMatchObject({
        root,
        agentCount: 0,
        sessions: [],
        problems: [],
      });
      const created = await fetch(`${prefix}/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invocationRoot: root,
          clientPath: "/usr/bin:/bin",
          databasePath: join(root, "agent.sqlite"),
          requestId: "listener-session-create-1",
          fungiMcp,
        }),
      });
      expect(created.status).toBe(200);
      const createdSelection = selectedSchema.parse(await created.json());
      expect(createdSelection.databasePath).toBe(join(root, "agent.sqlite"));
      expect(createdSelection.sessionId).toBe("fresh-session");
      const selected = await fetch(`${prefix}/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invocationRoot: root,
          sessionId: "main",
          clientPath: "/usr/bin:/bin",
        }),
      });
      expect(selected.status).toBe(200);
      const manager = createPrivateLocalServiceManager({
        directory,
        executionPath: "/usr/bin:/bin",
      });
      await assert.rejects(
        manager.connect({
          invocationRoot: root,
          sessionId: "main",
          fungiMcp: { ...fungiMcp, endpoint: "https://other.test/mcp" },
        }),
        /different Fungi MCP connection/u,
      );
      const same = await manager.connect({
        invocationRoot: root,
        sessionId: "main",
        fungiMcp,
      });
      expect(await same.effectiveModel()).toEqual(
        await fixtureEffectiveModel("main", new AbortController().signal),
      );
      await same.close();
      const firstClient = createPrivateLocalServiceManager({
        directory,
        executionPath: "/toolchain/a:/usr/bin",
      });
      const secondClient = createPrivateLocalServiceManager({
        directory,
        executionPath: "/toolchain/b:/usr/bin",
      });
      const readOnly = await firstClient.inspect({
        invocationRoot: root,
        sessionId: "inspection-only",
      });
      expect(readOnly.snapshot.sessionId).toBe("inspection-only");
      await readOnly.close();
      expect(sessionPaths.has("inspection-only")).toBe(false);
      await (
        await secondClient.connect({
          invocationRoot: root,
          sessionId: "inspection-only",
        })
      ).close();
      expect(sessionPaths.get("inspection-only")).toBe("/toolchain/b:/usr/bin");
      const crossToolchainRead = await firstClient.inspect({
        invocationRoot: root,
        sessionId: "inspection-only",
      });
      expect(crossToolchainRead.snapshot.sessionId).toBe("inspection-only");
      await crossToolchainRead.close();
      expect(sessionPaths.get("inspection-only")).toBe("/toolchain/b:/usr/bin");
      await (
        await firstClient.connect({
          invocationRoot: root,
          sessionId: "client-a",
        })
      ).close();
      await (
        await secondClient.connect({
          invocationRoot: root,
          sessionId: "client-b",
        })
      ).close();
      expect(sessionPaths.get("client-a")).toBe("/toolchain/a:/usr/bin");
      expect(sessionPaths.get("client-b")).toBe("/toolchain/b:/usr/bin");
      await assert.rejects(
        secondClient.connect({ invocationRoot: root, sessionId: "client-a" }),
        /PATH differs for this live session/u,
      );
      const inspected = await manager.inspect({
        invocationRoot: root,
        sessionId: "main",
      });
      expect(inspected.snapshot.sessionId).toBe("main");
      await inspected.close();

      let stopSettled = false;
      const stopping = manager.stop().then(() => {
        stopSettled = true;
      });
      await sleep(20);
      expect(stopSettled).toBe(false);
      expect(await handshake(record)).toBe(true);
      expect(
        await fetch(`${prefix}/select`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            invocationRoot: root,
            sessionId: "other",
            clientPath: "/usr/bin:/bin",
          }),
        }),
      ).toMatchObject({ status: 503 });

      closing.resolve(undefined);
      await stopping;
      await running;
      expect(await handshake(record)).toBe(false);
      expect(await readServiceRecord(directory)).toBeUndefined();
    } catch (cause) {
      logEvent("listener-proof.behaviour", cause);
      testFailure = cause;
    } finally {
      closing.resolve(undefined);
      try {
        if (record !== undefined && (await handshake(record))) {
          await fetch(`${record.baseUrl}/service/${record.serviceId}/stop`, {
            method: "POST",
          });
        }
      } catch (cause) {
        logEvent("listener-proof.stop-service", cause);
        cleanupFailures.push(cause);
      }
      try {
        await running;
      } catch (cause) {
        logEvent("listener-proof.join-service", cause);
        cleanupFailures.push(cause);
      }
      try {
        await rm(root, { recursive: true, force: true });
      } catch (cause) {
        logEvent("listener-proof.remove-fixture", cause);
        cleanupFailures.push(cause);
      }
    }
    if (testFailure !== undefined && cleanupFailures.length > 0)
      throw new AggregateError(
        [testFailure, ...cleanupFailures],
        "Listener proof and cleanup failed",
      );
    if (testFailure !== undefined)
      throw testFailure instanceof Error
        ? testFailure
        : new Error("Listener test failed", { cause: testFailure });
    if (cleanupFailures.length > 0)
      throw new AggregateError(cleanupFailures, "Listener test cleanup failed");
  });
});

it("keeps the native quiet observation and pending command connected until owner release", async () => {
  const { openPrivateLocalBunServer } =
    await import("../src/private-bun-shiitake-host.js");
  const { createShiitakeClient } =
    await import("@fungi.computer/shiitake/client");
  const release = Promise.withResolvers<undefined>();
  const commandStarted = Promise.withResolvers<undefined>();
  let commands = 0;
  let streamCancelled = false;
  const server = openPrivateLocalBunServer(async (request) => {
    if (request.method === "POST") {
      commands++;
      commandStarted.resolve(undefined);
      await release.promise;
      return Response.json({
        status: "accepted",
        commandId: "first-after-error",
      });
    }
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: retrying\n\n"));
          void release.promise.then(() => {
            if (!streamCancelled) {
              controller.enqueue(
                new TextEncoder().encode("data: cancelling\n\n"),
              );
              controller.close();
            }
          });
        },
        cancel() {
          streamCancelled = true;
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );
  });
  const client = createShiitakeClient({ baseUrl: server.baseUrl });
  try {
    const observation = await fetch(`${server.baseUrl}/events`);
    assert.ok(observation.body);
    const reader = observation.body.getReader();
    const first = await reader.read();
    assert.ok(first.value instanceof Uint8Array);
    expect(new TextDecoder().decode(first.value)).toContain("retrying");
    const next = reader.read();
    const command = client.session("main").command({
      type: "prompt",
      delivery: "followUp",
      requestId: "first-after-error",
      text: "Continue after the error.",
    });
    // The controlled-clock dispatch test covers the ten-second idle boundary.
    // This smoke proves the actual native listener and Shiitake wire contract.
    const settled = Promise.allSettled([next, command]);
    await commandStarted.promise;
    release.resolve(undefined);
    const [frame, receipt] = await settled;
    expect(frame.status).toBe("fulfilled");
    if (frame.status === "fulfilled") {
      assert.ok(frame.value.value instanceof Uint8Array);
      expect(new TextDecoder().decode(frame.value.value)).toContain(
        "cancelling",
      );
    }
    expect(receipt).toEqual({
      status: "fulfilled",
      value: { status: "accepted", commandId: "first-after-error" },
    });
    expect(commands).toBe(1);
  } finally {
    release.resolve(undefined);
    await client.close();
    await server.close();
  }
}, 20_000);
