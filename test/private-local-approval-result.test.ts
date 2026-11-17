import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as Schema from "effect/Schema";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { ApprovalLedger } from "@fungi.computer/approvals";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { expect, it, vi } from "vitest";
import * as invocationComputer from "../dist/private-invocation-computer.js";
import { openPrivateLocalRuntimeHost } from "../dist/private-local-runtime-host.js";
import { createLocalUiAttachment } from "../dist/private-local-ui-attachment.js";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import { mcpFormApprovalContract } from "../src/private-mcp-form-contract.js";

type Computer = Awaited<
  ReturnType<typeof invocationComputer.createPrivateInvocationComputer>
>;

it.each(["approve", "deny", "cancel", "expire", "duplicate"] as const)(
  "%s answers the waiting tool call without admitting a Session message",
  async (decision) => {
    const root = await mkdtemp(join(tmpdir(), "fungi-in-call-"));
    const marker = join(root, "ran");
    const faux = fauxProvider({
      provider: "approval-call-proof",
      models: [{ id: "probe", name: "Approval call proof" }],
    });
    let modelResult = "";
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("execute", {
          code: `return await env.computers.local.exec(${JSON.stringify({
            executable: process.execPath,
            args: [
              "-e",
              `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'ran'); console.log('approved-output')`,
            ],
            escape: { justification: "Disposable approval proof" },
            timeoutMs: decision === "expire" ? 775_000 : 180_000,
          })});`,
        }),
      ),
      (context) => {
        modelResult = JSON.stringify(
          context.messages.filter((message) => message.role === "toolResult"),
        );
        return fauxAssistantMessage("Done.");
      },
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    let retry: (() => ReturnType<Computer["call"]>) | undefined;
    const createComputer = invocationComputer.createPrivateInvocationComputer;
    // Replay the real Computer call with its original host-attested context,
    // as a transport retry would. Ordinary model calls get distinct ordinals.
    const replay =
      decision === "duplicate"
        ? vi
            .spyOn(invocationComputer, "createPrivateInvocationComputer")
            .mockImplementation(async (...args) => {
              const computer = await createComputer(...args);
              return {
                ...computer,
                call: (...call: Parameters<typeof computer.call>) => {
                  retry ??= () => computer.call(...call);
                  return computer.call(...call);
                },
              };
            })
        : undefined;
    try {
      const host = await openPrivateLocalRuntimeHost(
        {
          invocationRoot: root,
          configRoot: capturePrivateLocalConfigRoot(root),
          providerId: "approval-call-proof",
          modelId: "probe",
          mode: "workspace",
        },
        models,
      );
      const database = new DatabaseSync(host.databasePath);
      const attachment = createLocalUiAttachment("main", "connection");
      // The unattended expiry case deliberately has no UI attachment.
      const session =
        decision === "expire"
          ? host.session
          : host.getSession("main", attachment);
      const watch = await session.watch();
      const forms = async () => {
        const slot = (await session.read()).extensions[
          mcpFormApprovalContract.id
        ];
        if (slot?.status !== "running")
          throw new Error("Missing approval projection");
        return Schema.decodeUnknownSync(
          mcpFormApprovalContract.projection.schema,
        )(slot.value).pending;
      };
      try {
        const accepted = await session.send("Run the command.", {
          requestId: "original",
        });
        await vi.waitFor(
          async () => {
            expect(await forms()).toHaveLength(1);
          },
          {
            timeout: 10_000,
          },
        );
        const form = (await forms())[0];
        if (form === undefined) throw new Error("Missing card");
        expect(modelResult).toBe("");
        expect(existsSync(marker)).toBe(false);
        if (decision === "duplicate") {
          if (retry === undefined) throw new Error("Missing original call");
          let duplicateResult:
            Awaited<ReturnType<Computer["call"]>> | undefined;
          const duplicate = retry().then((result) => {
            duplicateResult = result;
          });
          await vi.waitFor(
            () => {
              expect(duplicateResult).toEqual({
                kind: "refused",
                reason: "in-flight",
              });
            },
            { timeout: 10_000 },
          );
          await duplicate;
          expect(await forms()).toEqual([form]);
          expect(modelResult).toBe("");
          expect(existsSync(marker)).toBe(false);
        }
        const admissions = () =>
          database
            .prepare("SELECT count(*) AS total FROM session_command_admissions")
            .get();
        const before = admissions();
        if (decision === "cancel") {
          await session.cancel({ commandId: accepted.commandId });
        } else if (decision !== "expire") {
          const answer = {
            id: form.id,
            decision: decision === "duplicate" ? "approve" : decision,
            expectedRevision: form.approval.record.revision,
          };
          await session
            .extension(mcpFormApprovalContract.id)
            .call(
              "answer",
              decision === "deny"
                ? { ...answer, denialNote: "Use the sandbox instead" }
                : answer,
            );
        }
        await vi.waitFor(
          async () => {
            expect(await forms()).toEqual([]);
          },
          {
            timeout: 10_000,
          },
        );
        if (decision !== "cancel")
          await vi.waitFor(
            () => {
              expect(modelResult).not.toBe("");
            },
            {
              timeout: 10_000,
            },
          );
        expect(admissions()).toEqual(before);
        expect(
          (await session.read()).messages.filter(
            ({ value }) => value.role === "user",
          ),
        ).toHaveLength(1);
        expect(await forms()).toEqual([]);
        if (decision === "approve" || decision === "duplicate") {
          expect(modelResult).toContain("approved-output");
          expect(await readFile(marker, "utf8")).toBe("ran");
        } else if (decision === "deny") {
          expect(modelResult).toContain("Denied by");
          expect(modelResult).toContain("the user");
          expect(modelResult).toContain("Use the sandbox instead");
          expect(modelResult).toContain("USER TEXT");
          expect(existsSync(marker)).toBe(false);
        } else {
          const ledger = new ApprovalLedger({
            owner: fromNodeSqlite(database),
            home: { kind: "local", id: host.agentId },
            now: Date.now,
          });
          expect(ledger.get(form.approval.record.recordId)?.state).toBe(
            "expired",
          );
          expect(existsSync(marker)).toBe(false);
          if (decision === "expire") {
            expect(modelResult).toContain("approval_expired");
            expect(modelResult).toContain("Always-allow rule");
          }
        }
      } finally {
        await watch.close();
        attachment.close();
        await host.close();
        database.close();
      }
    } finally {
      replay?.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);

it("boot withdraws the old owner's waiting approval without a message or effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-in-call-restart-"));
  const faux = fauxProvider({
    provider: "approval-restart-proof",
    models: [{ id: "probe", name: "Restart proof" }],
  });
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
      authorityFence: "workspace",
      idempotencyKey: "interrupted-wait",
      inputJson: "{}",
      requireHumanApproval: true,
      expiresAt: Date.now() + 60_000,
    });
    if (staged.kind !== "record") throw new Error("No approval");
    await first.close();
    const reopened = await openPrivateLocalRuntimeHost(
      { ...input, databasePath },
      models,
    );
    try {
      expect(ledger.get(staged.record.recordId)?.state).toBe("expired");
      expect((await reopened.session.read()).messages).toEqual([]);
    } finally {
      await reopened.close();
      database.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
