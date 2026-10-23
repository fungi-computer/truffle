import { logEvent } from "../src/log-event.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { sleep, spawn } from "bun";
import type { ShiitakeSession } from "@fungi.computer/shiitake";
import type { SessionSnapshot } from "@fungi.computer/shiitake";

import {
  handshake,
  selectedSchema,
  readServiceRecord,
  serviceDirectory,
  serviceOwnerIsLive,
  liveServiceStatusSchema,
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
import { openPrivateLocalRuntimeHost } from "../src/private-local-runtime-host.js";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { Readable } from "node:stream";
import { activateSubscriptionCredential } from "../src/subscription-activation.js";
import { createPrivateModels } from "../src/local-models.js";
import { LocalStoreSchemaError } from "../src/private-local-session-discovery.js";

/** A synthetic project. Its .git marker stops ancestor skill discovery here,
 * so a checkout-local TMPDIR never contributes the repository's own skills. */
async function syntheticProject(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, ".git"));
  return root;
}

async function assertIncompatibleStoreRefusal(schema: "local" | "woodstock") {
  const root = await syntheticProject("fungi-old-local-schema-");
  const home = join(root, "home");
  const databasePath = join(root, "agent.sqlite");
  const manager = createPrivateLocalServiceManager({ home });
  const selection = { invocationRoot: root, databasePath, sessionId: "main" };
  try {
    await mkdir(home);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec(`
        CREATE TABLE private_local_identity (
          singleton INTEGER PRIMARY KEY, agent_id TEXT NOT NULL,
          name TEXT, created_by TEXT, archived INTEGER NOT NULL DEFAULT 0
          ${schema === "woodstock" ? ", folder TEXT NOT NULL DEFAULT '.', require_sandbox INTEGER NOT NULL DEFAULT 0" : ""}
        )
      `);
      if (schema === "woodstock")
        database.exec(`
          CREATE TABLE woodstock_schema (version INTEGER NOT NULL, protocol TEXT NOT NULL);
          INSERT INTO woodstock_schema VALUES (2, 'shiitake.extension/v0');
        `);
    } finally {
      database.close();
    }
    const ready = await manager.start();
    const response = await fetch(
      `${ready.baseUrl}/service/${ready.serviceId}/inspect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...selection, limit: 1 }),
      },
    );
    assert.equal(response.status, 409, await response.clone().text());
    const refusal = z
      .object({
        code: z.literal("store_schema_incompatible"),
        databasePath: z.literal(databasePath),
        error: z.string(),
      })
      .parse(await response.json());
    assert.match(refusal.error, /stop.*Fungi/isu);
    assert.match(refusal.error, /move.*aside/isu);
    const isTypedReset = (cause: unknown) => {
      assert.ok(cause instanceof LocalStoreSchemaError);
      assert.equal(cause.databasePath, databasePath);
      assert.match(cause.message, /stop.*Fungi/isu);
      assert.match(cause.message, /move.*aside/isu);
      assert.match(cause.message, /not migrated/iu);
      return true;
    };
    await assert.rejects(manager.inspect(selection), isTypedReset);
    await assert.rejects(manager.connect(selection), isTypedReset);
    await assert.rejects(
      manager.createSession({
        invocationRoot: root,
        databasePath,
        requestId: "schema-refusal",
      }),
      isTypedReset,
    );
    const refused = new DatabaseSync(databasePath, { readOnly: true });
    try {
      if (schema === "local")
        expect(
          refused
            .prepare("PRAGMA table_info(private_local_identity)")
            .all()
            .map((column) => column.name),
        ).toEqual(["singleton", "agent_id", "name", "created_by", "archived"]);
      else
        expect(
          refused
            .prepare("SELECT version, protocol FROM woodstock_schema")
            .get(),
        ).toEqual({ version: 2, protocol: "shiitake.extension/v0" });
    } finally {
      refused.close();
    }
  } finally {
    try {
      await manager.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

it(
  "an old Local identity is a typed refusal with reset guidance over HTTP and the Session clients",
  () => assertIncompatibleStoreRefusal("local"),
  20_000,
);

it(
  "Woodstock v2 is a typed refusal with reset guidance over HTTP and the Session clients",
  () => assertIncompatibleStoreRefusal("woodstock"),
  20_000,
);

it("a running service uses an atomically activated subscription on the next turn without restart", async () => {
  const root = await syntheticProject("fungi-service-credential-cas-");
  const directory = await serviceDirectory(join(root, "service"));
  const credentialPath = join(root, ".config/fungi/credentials.json");
  const databasePath = join(root, "agent.sqlite");
  new DatabaseSync(databasePath).close();
  const first = {
    type: "oauth",
    access: "fake-service-first",
    refresh: "fake-service-refresh",
    expires: Date.now() + 3_600_000,
  } satisfies OAuthCredential;
  const next = { ...first, access: "fake-service-next" };
  const models = createPrivateModels(credentialPath);
  const faux = fauxProvider({
    provider: "anthropic",
    models: [{ id: "cas-fixture", name: "CAS fixture" }],
  });
  const seen: boolean[] = [];
  faux.setResponses([
    (_context, options) => {
      seen.push(options?.apiKey === first.access);
      return fauxAssistantMessage("First turn");
    },
    (_context, options) => {
      seen.push(options?.apiKey === next.access);
      return fauxAssistantMessage("Next turn");
    },
  ]);
  models.setProvider({
    ...faux.provider,
    auth: {
      oauth: {
        name: "Fake Fungi subscription login",
        login: () => Promise.resolve(first),
        refresh: () => {
          throw new Error("unexpired fixture must not refresh");
        },
        toAuth: (credential) => Promise.resolve({ apiKey: credential.access }),
      },
    },
  });
  await models.login("anthropic", "oauth", {
    signal: new AbortController().signal,
    notify() {
      throw new Error("fake login emits no notifications");
    },
    prompt() {
      throw new Error("fake login needs no prompt");
    },
  });
  const running = runPrivateLocalService(directory, (options) =>
    openPrivateLocalRuntimeHost(
      {
        ...options,
        providerId: "anthropic",
        modelId: "cas-fixture",
      },
      models,
    ),
  );
  const manager = createPrivateLocalServiceManager({ directory });
  try {
    let prefix: string | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      const record = await readServiceRecord(directory);
      if (record !== undefined) {
        prefix = `${record.baseUrl}/service/${record.serviceId}`;
        break;
      }
      await sleep(10);
    }
    assert.ok(prefix, "disposable service did not start");
    const baseUrl = prefix;
    const selected = selectedSchema.parse(
      await (
        await fetch(`${prefix}/select`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            invocationRoot: root,
            databasePath,
            sessionId: "main",
            clientPath: "/usr/bin",
          }),
        })
      ).json(),
    );
    async function turn(requestId: string, count: number) {
      const response = await fetch(
        `${baseUrl}${selected.routePath}/sessions/main/command`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: {
              type: "prompt",
              delivery: "followUp",
              requestId,
              text: "Answer briefly",
            },
          }),
        },
      );
      assert.equal(response.status, 200);
      for (let attempt = 0; attempt < 200 && seen.length < count; attempt++)
        await sleep(10);
      assert.equal(seen.length, count);
    }
    await turn("before-activation", 1);
    const before = await manager.status();
    await activateSubscriptionCredential(
      "anthropic",
      Readable.from([
        Buffer.from(JSON.stringify({ expected: first, credential: next })),
      ]),
      { credentialPath },
    );
    await turn("after-activation", 2);
    assert.deepEqual(seen, [true, true]);
    assert.deepEqual(await manager.status(), before);
  } finally {
    stopInProcessService();
    await running;
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * `fungi stop` SIGTERMs the service process. These listeners run inside the
 * test process, so deliver the signal to its handler instead of the process.
 */
function stopInProcessService() {
  process.emit("SIGTERM", "SIGTERM");
}

it.each(["held", "eio", "invalid-json", "non-array"])(
  "preserves the recovery manifest across %s initialization and a new selection",
  async (mode) => {
    const root = await syntheticProject("fungi-service-held-read-");
    const directory = await serviceDirectory(join(root, "service"));
    const home = join(root, "home");
    await mkdir(home);
    const saved = ["A", "B", "C"].map((name) => ({
      invocationRoot: root,
      databasePath: join(root, `${name}.sqlite`),
    }));
    for (const reference of saved)
      new DatabaseSync(reference.databasePath).close();
    const client = saved[2];
    assert.ok(client);
    const manifest = join(directory, "owners.json");
    const original =
      mode === "invalid-json"
        ? "{invalid"
        : mode === "non-array"
          ? "{}"
          : JSON.stringify(saved.slice(0, 2));
    await writeFile(manifest, original);
    const readHeld = Promise.withResolvers<undefined>();
    const clientOpened = Promise.withResolvers<undefined>();
    const child = spawn(
      [
        process.execPath,
        join(import.meta.dir, "fixtures", "held-recovery-read-service.ts"),
        directory,
        client.databasePath,
        mode,
      ],
      {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          TMPDIR: root,
          XDG_CONFIG_HOME: join(home, "config"),
          XDG_DATA_HOME: join(home, "data"),
          XDG_CACHE_HOME: join(home, "cache"),
        },
        stdout: "inherit",
        stderr: "ignore",
        ipc: (message) => {
          const event = z.enum(["read-held", "client-opened"]).parse(message);
          if (event === "read-held") readHeld.resolve(undefined);
          else clientOpened.resolve(undefined);
        },
      },
    );
    const abort = new AbortController();
    try {
      await readHeld.promise;
      const record = await readServiceRecord(directory);
      assert.ok(record);
      expect(await handshake(record)).toBe(true);
      const selecting = fetch(
        `${record.baseUrl}/service/${record.serviceId}/select`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...client,
            sessionId: "main",
            clientPath: "/usr/bin",
          }),
          signal: abort.signal,
        },
      );
      await clientOpened.promise;
      child.send("release-read");
      expect((await selecting).status).toBe(200);
      const status = liveServiceStatusSchema.parse(
        await (
          await fetch(`${record.baseUrl}/service/${record.serviceId}/status`)
        ).json(),
      );
      const afterSelection = await readFile(manifest, "utf8");
      child.kill(mode === "held" ? "SIGKILL" : "SIGTERM");
      await child.exited;
      if (mode === "held")
        expect(
          z
            .array(z.object({ databasePath: z.string() }))
            .parse(JSON.parse(await readFile(manifest, "utf8")))
            .map((reference) => reference.databasePath)
            .sort(),
        ).toEqual(saved.map((reference) => reference.databasePath).sort());
      else {
        expect(child.exitCode).toBe(0);
        expect(afterSelection).toBe(original);
        expect(await readFile(manifest, "utf8")).toBe(original);
        const logRecordSchema = z.looseObject({
          source: z.literal("local-service"),
          event: z.string(),
          pid: z.number().int(),
          version: z.string(),
          timestamp: z.iso.datetime(),
          code: z.enum(["read-failed", "decode-failed"]).optional(),
        });
        const records: z.infer<typeof logRecordSchema>[] = [];
        const lines = createInterface({
          input: createReadStream(join(directory, "service.jsonl")),
        });
        try {
          for await (const line of lines)
            records.push(logRecordSchema.parse(JSON.parse(line)));
        } finally {
          lines.close();
        }
        const code = mode === "eio" ? "read-failed" : "decode-failed";
        const disabledRecords = records.filter(
          (entry) => entry.event === "recovery-persistence-disabled",
        );
        expect(disabledRecords).toHaveLength(1);
        const disabledRecord = disabledRecords[0];
        assert.ok(disabledRecord);
        expect(Object.keys(disabledRecord).sort()).toEqual(
          ["source", "event", "code", "timestamp", "pid", "version"].sort(),
        );
        expect({
          // The canonical wire decoder already requires an ISO `since` for
          // non-active diagnostics; don't substitute a string-shaped matcher.
          diagnostics: {
            state: status.diagnostics.state,
            code:
              status.diagnostics.state === "active"
                ? undefined
                : status.diagnostics.code,
          },
          records: disabledRecords,
        }).toMatchObject({
          diagnostics: {
            state: "recovery-disabled",
            code,
          },
          records: [
            {
              source: "local-service",
              event: "recovery-persistence-disabled",
              code,
              pid: child.pid,
              version: record.version,
            },
          ],
        });
      }
    } finally {
      abort.abort();
      if (child.exitCode === null) {
        child.kill("SIGKILL");
        await child.exited;
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);

it.each([
  { agentCount: 1, action: "resume" },
  { agentCount: 32, action: "resume" },
  { agentCount: 32, action: "select" },
  { agentCount: 32, action: "shutdown" },
])(
  "answers the handshake before reopening $agentCount saved Agents ($action)",
  async ({ agentCount, action }) => {
    const root = await syntheticProject("fungi-service-restart-");
    const directory = await serviceDirectory(join(root, "service"));
    const databasePath = join(root, "agent.sqlite");
    new DatabaseSync(databasePath).close();
    const faux = fauxModel([]);
    faux.setResponses([
      fauxAssistantMessage("background reply"),
      fauxAssistantMessage("second background reply"),
    ]);
    let restarted = false;
    const reopening = Promise.withResolvers<undefined>();
    const releaseReopen = Promise.withResolvers<undefined>();
    let opens = 0;
    const reopenedStores: string[] = [];
    const closedStores: string[] = [];
    const openRuntime: NonNullable<
      Parameters<typeof runPrivateLocalService>[1]
    > = async (options) => {
      const selectedDatabasePath = options.databasePath ?? databasePath;
      if (restarted) {
        opens++;
        reopenedStores.push(selectedDatabasePath);
        reopening.resolve(undefined);
        await releaseReopen.promise;
      }
      const database = new DatabaseSync(selectedDatabasePath);
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
              retryable: faux.retryable,
              stream: faux.stream,
              release: () => Promise.resolve(),
            }),
        },
      });
      return {
        databasePath: selectedDatabasePath,
        agentId: "restart-agent",
        getSession: agent.session,
        listSessions: agent.listSessions,
        createSession: agent.createSession,
        deleteSession: agent.deleteSession,
        extensions: agent.extensions,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        // Its queued prompts are work the next service must resume.
        idle: () => Promise.resolve(false),
        name: "fake-agent",
        bindSessionPath: () => true,
        close: async () => {
          await agent.close();
          database.close();
          if (restarted) closedStores.push(selectedDatabasePath);
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
    let recoveryStopRequested = false;
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
      stopInProcessService();
      await running;
      prefix = undefined;
      const saved = [{ invocationRoot: root, databasePath }];
      for (let index = 1; index < agentCount; index++) {
        const path = join(root, `agent-${String(index)}.sqlite`);
        new DatabaseSync(path).close();
        saved.push({ invocationRoot: root, databasePath: path });
      }
      await writeFile(join(directory, "owners.json"), JSON.stringify(saved));
      restarted = true;
      running = runPrivateLocalService(directory, openRuntime);
      try {
        await reopening.promise;
        prefix = await ready();
        const record = await readServiceRecord(directory);
        assert.ok(record);
        expect(await handshake(record)).toBe(true);
        expect(opens).toBe(1);
        expect(faux.state.callCount).toBe(0);
        const request = {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            invocationRoot: root,
            databasePath: saved[agentCount - 1]?.databasePath,
            sessionId: "main",
            clientPath: "/usr/bin",
          }),
        };
        if (action === "select") {
          // Two callers of a not-yet-reopened Agent share the ordinary opener.
          const requests = [
            fetch(`${prefix}/select`, request),
            fetch(`${prefix}/select`, request),
          ];
          expect(
            await Promise.race([
              Promise.all(requests).then(() => "selected"),
              sleep(25).then(() => "waiting"),
            ]),
          ).toBe("waiting");
          expect(opens).toBe(1);
          releaseReopen.resolve(undefined);
          const responses = await Promise.all(requests);
          for (const response of responses) expect(response.status).toBe(200);
          const selections = await Promise.all(
            responses.map(async (response) =>
              selectedSchema.parse(await response.json()),
            ),
          );
          const [first, second] = selections;
          assert.ok(first);
          assert.ok(second);
          const { routePath: firstRoute, ...firstSelection } = first;
          const { routePath: secondRoute, ...secondSelection } = second;
          expect(firstSelection).toEqual(secondSelection);
          expect(firstRoute).not.toBe(secondRoute);
          expect(
            reopenedStores.filter(
              (path) => path === saved[agentCount - 1]?.databasePath,
            ),
          ).toHaveLength(1);
        }
        if (action === "shutdown") {
          let finished = false;
          const finishedService = running.then(() => {
            finished = true;
          });
          recoveryStopRequested = true;
          stopInProcessService();
          expect((await fetch(`${prefix}/select`, request)).status).toBe(503);
          expect(await handshake(record)).toBe(true);
          expect(await serviceOwnerIsLive(directory)).toBe(true);
          expect(finished).toBe(false);
          expect(closedStores).toEqual([]);
          releaseReopen.resolve(undefined);
          await finishedService;
          expect(opens).toBe(1);
          expect(closedStores).toEqual(reopenedStores);
          expect(await readServiceRecord(directory)).toBeUndefined();
          expect(await handshake(record)).toBe(false);
          expect(await serviceOwnerIsLive(directory)).toBe(false);
          // Neither the stopped opener nor the unstarted Agents lose their hint.
          expect(
            JSON.parse(await readFile(join(directory, "owners.json"), "utf8")),
          ).toEqual(saved);
        }
      } finally {
        // Even a red must release the owned opener and stop its service.
        releaseReopen.resolve(undefined);
        if (!recoveryStopRequested) prefix ??= await ready();
      }
      // The resume cases send no /select, Session read or watch to restart.
      for (
        let attempt = 0;
        attempt < 100 && faux.state.callCount < 2;
        attempt++
      )
        await sleep(10);
      expect(faux.state.callCount).toBe(2);
    } finally {
      releaseReopen.resolve(undefined);
      if (prefix !== undefined && !recoveryStopRequested)
        stopInProcessService();
      await running;
      await rm(root, { recursive: true, force: true });
    }
  },
);

describe("private Local service listener", () => {
  it("answers a select over several saved Agent stores with the Agents to choose from, not a bare 500", async () => {
    // The shape of a long-used project: several stores plus a moved-aside
    // pre-v0 database and a rollback journal left by a killed run.
    const root = await syntheticProject("fungi-service-ambiguous-");
    const directory = await serviceDirectory(join(root, "service"));
    const agents = join(root, ".fungi", "agents");
    for (const id of ["local_store_first", "local_store_second"]) {
      await mkdir(join(agents, id), { recursive: true });
      new DatabaseSync(join(agents, id, "agent.sqlite")).close();
      await writeFile(join(agents, id, "agent.sqlite.owner.sqlite"), "");
      await writeFile(
        join(agents, id, "agent.sqlite.owner.sqlite-journal"),
        Buffer.alloc(512),
      );
    }
    new DatabaseSync(
      join(agents, "local_store_first", "agent.pre-v0.sqlite"),
    ).close();
    let running: Promise<void> | undefined;
    let prefix: string | undefined;
    try {
      running = runPrivateLocalService(directory, () => {
        throw new Error("must not open an arbitrary Agent");
      });
      for (let attempt = 0; attempt < 100 && prefix === undefined; attempt++) {
        const record = await readServiceRecord(directory);
        if (record !== undefined)
          prefix = `${record.baseUrl}/service/${record.serviceId}`;
        else await sleep(10);
      }
      assert(prefix !== undefined, "Local service did not start");
      const response = await fetch(`${prefix}/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invocationRoot: root, clientPath: "/usr/bin" }),
      });
      expect(response.status).toBe(409);
      const body = z
        .object({ code: z.string(), agentIds: z.array(z.string()) })
        .parse(await response.json());
      expect(body.code).toBe("agent_selection_ambiguous");
      expect(body.agentIds.toSorted()).toEqual([
        "local_store_first",
        "local_store_second",
      ]);
    } finally {
      if (prefix !== undefined) stopInProcessService();
      await running;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("answers an unexpected select failure with its message, not a bare 500", async () => {
    const root = await syntheticProject("fungi-service-unexpected-");
    const directory = await serviceDirectory(join(root, "service"));
    let running: Promise<void> | undefined;
    let prefix: string | undefined;
    try {
      running = runPrivateLocalService(directory, () =>
        Promise.reject(new Error("store could not be opened")),
      );
      for (let attempt = 0; attempt < 100 && prefix === undefined; attempt++) {
        const record = await readServiceRecord(directory);
        if (record !== undefined)
          prefix = `${record.baseUrl}/service/${record.serviceId}`;
        else await sleep(10);
      }
      assert(prefix !== undefined, "Local service did not start");
      const response = await fetch(`${prefix}/select`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invocationRoot: root, clientPath: "/usr/bin" }),
      });
      expect(response.status).toBe(500);
      expect(
        z
          .object({ code: z.string(), error: z.string() })
          .parse(await response.json()),
      ).toEqual({ code: "internal_error", error: "store could not be opened" });
    } finally {
      if (prefix !== undefined) stopInProcessService();
      await running;
      await rm(root, { recursive: true, force: true });
    }
  });

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
    const root = await syntheticProject("fungi-service-stop-");
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
      toolOutput: [],
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
          name: "fake-agent",
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
        agents: [],
        sessions: [],
        problems: [],
      });
      const badArchive = await fetch(`${prefix}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invocationRoot: root }),
      });
      expect(badArchive.status).toBe(400);
      const unknownArchive = await fetch(`${prefix}/archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          invocationRoot: root,
          agentId: "nobody",
          archived: true,
        }),
      });
      expect(unknownArchive.status).toBe(500);
      expect(await unknownArchive.json()).toMatchObject({
        error: "Agent is outside this Local project",
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
      const stopping = running.then(() => {
        stopSettled = true;
      });
      stopInProcessService();
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
      expect(await handshake(record)).toBe(false);
      expect(await readServiceRecord(directory)).toBeUndefined();
    } catch (cause) {
      logEvent("listener-proof.behaviour", cause);
      testFailure = cause;
    } finally {
      closing.resolve(undefined);
      try {
        if (record !== undefined && (await handshake(record)))
          stopInProcessService();
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
