import { expect, it } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EventSource } from "eventsource";
import { appendFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduler } from "node:timers/promises";
import {
  fauxProvider,
  fauxAssistantMessage,
} from "@earendil-works/pi-ai/providers/faux";
import {
  ApprovalLedger,
  type ApprovalAnswerer,
  type ApprovalApplyHost,
} from "@fungi.computer/approvals";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import type { ShiitakeSession } from "@fungi.computer/shiitake";
import { createPrivateModels } from "../dist/local-models.js";
import { createPrivateLocalServiceManager } from "../dist/private-local-service.js";
import { runPrivateLocalService } from "../dist/private-local-service-listener.js";
import { mcpFormApprovalContract } from "../dist/private-mcp-form-contract.js";
import {
  openPrivateLocalRuntimeHost,
  type PrivateLocalRuntimeHost,
} from "../dist/private-local-runtime-host.js";
import { serviceDirectory } from "../dist/private-local-service-discovery.js";
import { createPrivateLocalAcpAgent } from "../dist/private-local-acp-stdio.js";

async function withFormService(
  run: (service: {
    root: string;
    manager: ReturnType<typeof createPrivateLocalServiceManager>;
    submit: (sessionId: string) => Promise<string>;
    ledger: ApprovalLedger;
    eventUrls: string[];
  }) => Promise<void>,
) {
  const root = await mkdtemp(join(tmpdir(), "ledger-form-service-"));
  await mkdir(join(root, ".git"));
  const config = {
    home: root,
    credentialPath: join(root, "credentials.json"),
    serviceDirectory: await serviceDirectory(join(root, "service")),
  };
  const database = new DatabaseSync(":memory:");
  const ledger = new ApprovalLedger({
    owner: fromNodeSqlite(database),
    home: { kind: "local", id: "fixture-local" },
    now: () => 10,
  });
  const actor: ApprovalAnswerer = {
    kind: "human",
    memberId: "fixture-owner",
    role: "owner",
    actingForAgent: false,
    mayUseOperation: true,
  };
  ledger.setAutoApprove(
    {
      scope: { agentId: null },
      family: { module: null, access: "write" },
      enabled: false,
    },
    actor,
  );
  const effect: ApprovalApplyHost = {
    recheck: (record) =>
      Promise.resolve({
        kind: "authorized",
        authorityFence: record.authorityFence,
      }),
    dispatch: async () => {
      await appendFile(join(root, "effects.txt"), "saved\n");
      return { kind: "completed", output: "saved" };
    },
  };
  const capability = ledger.capability({
    actor: () => Promise.resolve(actor),
    decision: async (recordId) => {
      await ledger.apply(recordId, effect);
    },
  });
  const models = createPrivateModels(config.credentialPath);
  const faux = fauxProvider({
    provider: "anthropic",
    models: [{ id: "form-fixture", name: "Form fixture" }],
  });
  faux.setResponses([
    fauxAssistantMessage("complete"),
    fauxAssistantMessage("complete again"),
  ]);
  models.setProvider(faux.provider);
  let runtime: PrivateLocalRuntimeHost | undefined;
  const running = runPrivateLocalService(
    config.serviceDirectory,
    async (options) => {
      runtime = await openPrivateLocalRuntimeHost(
        {
          ...options,
          providerId: "anthropic",
          modelId: "form-fixture",
        },
        models,
      );
      return runtime;
    },
    undefined,
    undefined,
    undefined,
    undefined,
    config,
  );
  const eventUrls: string[] = [];
  class ObservedEventSource extends EventSource {
    constructor(url: string) {
      super(url);
      eventUrls.push(url);
    }
  }
  const manager = createPrivateLocalServiceManager({
    directory: config.serviceDirectory,
    eventSource: ObservedEventSource,
  });
  try {
    const deadline = AbortSignal.timeout(10_000);
    while ((await manager.status()) === undefined)
      await scheduler.wait(10, { signal: deadline });
    await run({
      root,
      manager,
      ledger,
      eventUrls,
      submit: async (sessionId) => {
        if (runtime === undefined) throw new Error("Native owner unavailable");
        const pending = await ledger.submit(
          {
            requester: {
              principalId: "fixture-agent",
              agentId: "fixture-agent",
              sessionId,
              displayName: "Fixture Agent",
            },
            module: "fixture-notes",
            operation: "write",
            access: "write",
            reversibility: "reversible",
            authorityFence: "fixture-grant:1",
            idempotencyKey: `fixture-turn:${sessionId}/tool:1/operation:0`,
            inputJson: '{"text":"saved"}',
          },
          effect,
        );
        if (pending.kind !== "pending_approval")
          throw new Error("Fixture did not stage a canonical approval");
        const presented = await runtime.presentApproval(
          sessionId,
          pending,
          capability,
        );
        if (presented.kind !== "presented")
          throw new Error("Native host did not bind the record");
        return pending.recordId;
      },
    });
  } finally {
    process.emit("SIGTERM", "SIGTERM");
    try {
      await running;
    } finally {
      database.close();
      await rm(root, { recursive: true, force: true });
    }
  }
}

async function nextForm(
  session: ShiitakeSession,
  watch: Awaited<ReturnType<ShiitakeSession["watch"]>>,
) {
  const forms = bindSessionExtension(session, mcpFormApprovalContract);
  for await (const frame of watch.changes) {
    if (frame.kind !== "update") continue;
    const view = forms.view(frame);
    if (view.status === "running" && view.value?.pending[0] !== undefined)
      return view.value.pending[0];
  }
  throw new Error("Session closed without its canonical approval");
}

it(
  "ACP prompt watches retain their private route, but closing the ACP connection removes it",
  async () =>
    withFormService(async ({ root, manager, eventUrls }) => {
      const agent = createPrivateLocalAcpAgent({
        manager,
        invocationRoot: root,
      });
      let snapshotUrl: URL | undefined;
      await acp.client().connectWith(agent, async (ctx) => {
        await ctx.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
        });
        const { sessionId } = await ctx.request(acp.methods.agent.session.new, {
          cwd: root,
          mcpServers: [],
        });
        for (let turn = 0; turn < 2; turn += 1) {
          const result = await ctx.request(acp.methods.agent.session.prompt, {
            sessionId,
            prompt: [{ type: "text", text: "Reply without using tools." }],
          });
          expect(result.stopReason).toBe("end_turn");
          const events = eventUrls.at(-1);
          if (events === undefined)
            throw new Error("ACP did not open a real Session watch");
          snapshotUrl = new URL(events);
          snapshotUrl.pathname = snapshotUrl.pathname.slice(
            0,
            -"/events".length,
          );
          snapshotUrl.search = "";
          const retained = await fetch(snapshotUrl);
          expect(retained.status).toBe(200);
          await retained.body?.cancel();
        }
      });
      if (snapshotUrl === undefined)
        throw new Error("ACP did not acquire a private route");
      const deadline = AbortSignal.timeout(5_000);
      for (;;) {
        const detached = await fetch(snapshotUrl, { signal: deadline });
        const status = detached.status;
        await detached.body?.cancel();
        if (status === 404) break;
        expect(status).toBe(200);
        await scheduler.wait(10, { signal: deadline });
      }
    }),
  20_000,
);

it(
  "releases an unwatched selection and the superseded rebind route",
  async () =>
    withFormService(async ({ root, manager }) => {
      const connection = await manager.connect({ invocationRoot: root });
      const address = connection.session.address;
      try {
        expect(await connection.rebind()).toMatchObject({ kind: "rebound" });
        expect((await fetch(address)).status).toBe(404);
        expect((await connection.session.read()).sessionId).toBe(
          connection.sessionId,
        );
        await connection.close();
        const unwatched = await manager.connect({ invocationRoot: root });
        const unwatchedAddress = unwatched.session.address;
        try {
          expect((await fetch(unwatchedAddress)).status).toBe(200);
          await unwatched.close();
          expect((await fetch(unwatchedAddress)).status).toBe(404);
        } finally {
          await unwatched.close();
        }
      } finally {
        await connection.close();
      }
    }),
  20_000,
);

it.each(["approve", "deny"] as const)(
  "the service delivers the real record and revision-pinned %s through the existing Session channel",
  async (decision) =>
    withFormService(async ({ root, manager, submit, ledger }) => {
      const connection = await manager.connect({ invocationRoot: root });
      const watch = await connection.session.watch();
      try {
        const observed = nextForm(connection.session, watch);
        const recordId = await submit(connection.sessionId);
        const form = await observed;
        expect(form.approval.record.recordId).toBe(recordId);
        expect(form.id).not.toBe(recordId);
        expect(form.approval.canAnswer).toBe(true);
        const input = {
          id: form.id,
          decision,
          expectedRevision: form.approval.record.revision,
        };
        const selection = {
          invocationRoot: root,
          databasePath: connection.databasePath,
          sessionId: connection.sessionId,
        };
        const inspector = await manager.inspect(selection);
        const unattached = await manager.connect(selection);
        const other = await manager.createSession({
          invocationRoot: root,
          databasePath: connection.databasePath,
          requestId: "other-session",
        });
        const otherWatch = await other.session.watch();
        try {
          for (const session of [inspector.session, unattached.session]) {
            expect(
              await session
                .extension(mcpFormApprovalContract.id)
                .call("answer", input),
            ).toEqual({ kind: "refused", reason: "not-attached" });
          }
          expect(
            await other.session
              .extension(mcpFormApprovalContract.id)
              .call("answer", input),
          ).toEqual({ kind: "refused", reason: "not-pending" });
          await assert.rejects(
            inspector.session
              .extension(mcpFormApprovalContract.id)
              .call("answer", {
                ...input,
                actor: "human",
              }),
          );
        } finally {
          await otherWatch.close();
          await inspector.close();
          await unattached.close();
          await other.close();
        }
        expect(
          await connection.session
            .extension(mcpFormApprovalContract.id)
            .call("answer", {
              ...input,
              expectedRevision: input.expectedRevision + 1,
            }),
        ).toEqual({ kind: "refused", reason: "stale-revision" });
        expect(
          await connection.session
            .extension(mcpFormApprovalContract.id)
            .call("answer", input),
        ).toMatchObject({
          kind: "answered",
          view: {
            record: {
              recordId,
              state: decision === "approve" ? "applied" : "denied",
            },
          },
        });
        expect(ledger.get(recordId)?.state).toBe(
          decision === "approve" ? "applied" : "denied",
        );
        expect(
          await connection.session
            .extension(mcpFormApprovalContract.id)
            .call("answer", input),
        ).toEqual({ kind: "refused", reason: "not-pending" });
        if (decision === "approve")
          expect(await readFile(join(root, "effects.txt"), "utf8")).toBe(
            "saved\n",
          );
        else
          await assert.rejects(readFile(join(root, "effects.txt"), "utf8"), {
            code: "ENOENT",
          });
      } finally {
        await watch.close();
        await connection.close();
      }
    }),
  20_000,
);

it(
  "UI close does not decide the durable record; a rebound live UI may answer it once",
  async () =>
    withFormService(async ({ root, manager, submit, ledger }) => {
      const connection = await manager.connect({ invocationRoot: root });
      const watch = await connection.session.watch();
      try {
        const observed = nextForm(connection.session, watch);
        const recordId = await submit(connection.sessionId);
        const form = await observed;
        await watch.close();
        expect(ledger.get(recordId)?.state).toBe("pending");
        const input = {
          id: form.id,
          decision: "approve",
          expectedRevision: form.approval.record.revision,
        };
        await assert.rejects(
          connection.session
            .extension(mcpFormApprovalContract.id)
            .call("answer", input),
        );
        expect(await connection.rebind()).toMatchObject({ kind: "rebound" });
        const reboundWatch = await connection.session.watch();
        try {
          expect(
            await connection.session
              .extension(mcpFormApprovalContract.id)
              .call("answer", input),
          ).toMatchObject({
            kind: "answered",
            view: { record: { state: "applied" } },
          });
        } finally {
          await reboundWatch.close();
        }
        expect(await readFile(join(root, "effects.txt"), "utf8")).toBe(
          "saved\n",
        );
      } finally {
        await watch.close();
        await connection.close();
      }
    }),
  20_000,
);
