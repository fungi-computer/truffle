import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { ApprovalLedger } from "@fungi.computer/approvals";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { openPrivateLocalRuntimeHost } from "../src/private-local-runtime-host.js";
import { createLocalUiAttachment } from "../src/private-local-ui-attachment.js";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";

it("starts the Local Agent's next turn with the user's denial reason", async () => {
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
    try {
      const ledger = new ApprovalLedger({
        owner: fromNodeSqlite(database),
        home: { kind: "local", id: host.agentId },
        now: Date.now,
      });
      const staged = await ledger.request({
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
      });
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
    } finally {
      attachment.close();
      await host.close();
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
