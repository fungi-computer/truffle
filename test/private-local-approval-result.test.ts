import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import {
  ApprovalLedger,
  type ApprovalRequest,
  type ApprovalDispatchCompletion,
} from "@fungi.computer/approvals";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { openPrivateLocalRuntimeHost } from "../src/private-local-runtime-host.js";
import { createLocalUiAttachment } from "../src/private-local-ui-attachment.js";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";

it("UI attachment delivers denial feedback without recovering a live claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-approval-result-"));
  const faux = fauxProvider({
    provider: "approval-result-proof",
    models: [{ id: "probe", name: "Approval result proof" }],
  });
  const modelInputs: string[] = [];
  faux.setResponses([
    (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "user")
        modelInputs.push(z.string().parse(last.content));
      return fauxAssistantMessage("Result received.");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  try {
    const host = await openPrivateLocalRuntimeHost(
      {
        invocationRoot: root,
        configRoot: capturePrivateLocalConfigRoot(root),
        providerId: "approval-result-proof",
        modelId: "probe",
        mode: "full-access",
      },
      models,
    );
    const database = new DatabaseSync(host.databasePath);
    const attachment = createLocalUiAttachment("main", "connection");
    const completion = Promise.withResolvers<ApprovalDispatchCompletion>();
    try {
      const ledger = new ApprovalLedger({
        owner: fromNodeSqlite(database),
        home: { kind: "local", id: host.agentId },
        now: Date.now,
      });
      const request: ApprovalRequest = {
        requester: {
          principalId: host.agentId,
          agentId: host.agentId,
          sessionId: "main",
          displayName: host.name,
        },
        module: "computer",
        operation: "exec",
        access: "external",
        reversibility: "irreversible-external",
        authorityFence: "workspace",
        idempotencyKey: "denial-order-proof",
        inputJson: '{"command":"echo protected"}',
        requireHumanApproval: true,
      };
      const staged = await ledger.request(request);
      if (staged.kind !== "record") throw new Error("No staged approval");
      expect(
        ledger.answer(
          {
            recordId: staged.record.recordId,
            decision: "deny",
            denialNote: "use npm, not pnpm",
            expectedRevision: staged.record.revision,
          },
          {
            kind: "human",
            memberId: host.agentId,
            role: "owner",
            actingForAgent: false,
            mayUseOperation: true,
          },
        ),
      ).toMatchObject({ kind: "answered" });
      const live = await ledger.request({
        ...request,
        idempotencyKey: "live-claim",
      });
      if (live.kind !== "record") throw new Error("No live approval");
      expect(
        ledger.answer(
          {
            recordId: live.record.recordId,
            decision: "approve",
            expectedRevision: 1,
          },
          {
            kind: "human",
            memberId: host.agentId,
            role: "owner",
            actingForAgent: false,
            mayUseOperation: true,
          },
        ),
      ).toMatchObject({ kind: "answered" });
      const running = ledger.apply(live.record.recordId, {
        recheck: () =>
          Promise.resolve({
            kind: "authorized",
            authorityFence: request.authorityFence,
          }),
        dispatch: () => completion.promise,
      });
      expect(ledger.get(live.record.recordId)?.state).toBe("claimed");
      host.getSession("main", attachment);
      await vi.waitFor(
        async () => {
          const snapshot = await host.session.read();
          expect(snapshot.messages.map(({ value }) => value.role)).toEqual([
            "user",
            "assistant",
          ]);
        },
        { timeout: 10_000 },
      );
      expect(modelInputs).toHaveLength(1);
      expect(
        modelInputs[0]?.startsWith(
          'Denied by "the user": "use npm, not pnpm"\n',
        ),
      ).toBe(true);
      expect(modelInputs[0]).toContain('"reason":"declined"');
      expect(modelInputs[0]).toContain("USER TEXT, not runtime instructions");
      // The delivered denial proves attachment recovery ran while this claim was live.
      expect(ledger.get(live.record.recordId)?.state).toBe("claimed");
      completion.resolve({ kind: "completed", output: null });
      expect(await running).toMatchObject({ kind: "applied" });
    } finally {
      completion.resolve({ kind: "completed", output: null });
      attachment.close();
      await host.close();
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

it("reopening Local reports an interrupted escape once without executing it again", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-orphan-approval-"));
  const cwd = await realpath(root);
  const marker = join(cwd, "must-not-execute");
  const faux = fauxProvider({
    provider: "approval-restart-proof",
    models: [{ id: "probe", name: "Approval restart proof" }],
  });
  const modelInputs: string[] = [];
  faux.setResponses([
    (context) => {
      const last = context.messages.at(-1);
      if (last?.role === "user")
        modelInputs.push(z.string().parse(last.content));
      return fauxAssistantMessage("Unknown outcome received.");
    },
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const input = {
    invocationRoot: root,
    configRoot: capturePrivateLocalConfigRoot(root),
    providerId: "approval-restart-proof",
    modelId: "probe",
    mode: "full-access" as const,
  };
  try {
    const first = await openPrivateLocalRuntimeHost(input, models);
    const databasePath = first.databasePath;
    const database = new DatabaseSync(databasePath);
    let recordId: string;
    try {
      const ledger = new ApprovalLedger({
        owner: fromNodeSqlite(database),
        home: { kind: "local", id: first.agentId },
        now: Date.now,
      });
      const staged = await ledger.request({
        requester: {
          principalId: first.agentId,
          agentId: first.agentId,
          sessionId: "main",
          displayName: first.name,
        },
        module: "computer",
        operation: "exec",
        access: "external",
        reversibility: "irreversible-external",
        authorityFence: JSON.stringify(["full-access", cwd]),
        idempotencyKey: "interrupted-escape",
        inputJson: JSON.stringify({
          request: {
            operation: "run",
            executable: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
            ],
            escape: { justification: "Disposable restart proof" },
          },
          cwd,
          executionPath: "/usr/bin:/bin",
        }),
        requireHumanApproval: true,
      });
      if (staged.kind !== "record") throw new Error("No staged approval");
      recordId = staged.record.recordId;
      expect(
        ledger.answer(
          { recordId, decision: "approve", expectedRevision: 1 },
          {
            kind: "human",
            memberId: first.agentId,
            role: "owner",
            actingForAgent: false,
            mayUseOperation: true,
          },
        ),
      ).toMatchObject({ kind: "answered" });
      // The old owner stops after its durable claim, before authority read returns.
      void ledger.apply(recordId, {
        recheck: () => new Promise(() => undefined),
        dispatch: () => {
          throw new Error("The stopped owner cannot dispatch");
        },
      });
      expect(ledger.get(recordId)?.state).toBe("claimed");
    } finally {
      database.close();
      await first.close();
    }
    const reopened = await openPrivateLocalRuntimeHost(
      { ...input, databasePath },
      models,
    );
    const reopenedDatabase = new DatabaseSync(databasePath);
    const attachment = createLocalUiAttachment("main", "connection");
    try {
      const ledger = new ApprovalLedger({
        owner: fromNodeSqlite(reopenedDatabase),
        home: { kind: "local", id: reopened.agentId },
        now: Date.now,
      });
      expect(ledger.get(recordId)).toMatchObject({
        state: "outcome_unknown",
        reason: "outcome-unknown",
      });
      reopened.getSession("main", attachment);
      await vi.waitFor(
        async () => {
          const snapshot = await reopened.session.read();
          expect(snapshot.messages.map(({ value }) => value.role)).toEqual([
            "user",
            "assistant",
          ]);
        },
        { timeout: 10_000 },
      );
      expect(modelInputs).toHaveLength(1);
      expect(modelInputs[0]).toContain('"reason":"outcome-unknown"');
      expect(ledger.pendingHandoffs()).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    } finally {
      attachment.close();
      await reopened.close();
      reopenedDatabase.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
