import { DatabaseSync } from "node:sqlite";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as Schema from "effect/Schema";
import {
  ApprovalLedger,
  type ApprovalAnswerer,
  type ApprovalApplyHost,
} from "@fungi.computer/approvals";
import { fauxModelSource, memoryHost } from "@fungi.computer/shiitake/testing";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { createPrivateLocalTools } from "../src/private-local-runtime-host.js";
import { createLocalUiAttachment } from "../src/private-local-ui-attachment.js";
import { mcpFormApprovalContract } from "../src/private-mcp-form-contract.js";

it("the selected Session presents the real record and only a live host-bound UI can answer its revision, applying once", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-ledger-session-"));
  const database = new DatabaseSync(":memory:");
  const local = await createPrivateLocalTools(root);
  const host = await memoryHost({
    extensions: local.extensions,
    tools: local.tools,
    model: fauxModelSource([]),
  });
  const sessionId = await host.agent.createSession("ledger-form");
  const raw = host.agent.session(sessionId);
  const attachment = createLocalUiAttachment(sessionId);
  const session = local.bindSession(sessionId, raw, attachment);
  const ledger = new ApprovalLedger({
    owner: fromNodeSqlite(database),
    home: { kind: "local", id: "fixture-local" },
    now: () => 10,
  });
  let actor: ApprovalAnswerer = {
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
    dispatch: async ({ input }) => {
      const { text } = Schema.decodeUnknownSync(
        Schema.Struct({ text: Schema.String }),
      )(input);
      await appendFile(join(root, "effects.txt"), text + "\n");
      return { kind: "completed", output: "saved" };
    },
  };
  const capability = ledger.capability({
    actor: () => Promise.resolve(actor),
    decision: async (recordId) => {
      await ledger.apply(recordId, effect);
    },
  });
  const submitted = await ledger.submit(
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
      idempotencyKey: "fixture-turn:1/tool:1/operation:0",
      inputJson: '{"text":"saved"}',
    },
    effect,
  );
  if (submitted.kind !== "pending_approval")
    throw new Error("Fixture did not stage a real pending approval");
  const presented = await local.presentApproval(
    sessionId,
    submitted,
    capability,
  );
  if (presented.kind !== "presented")
    throw new Error("Local host did not present the ledger record");
  const snapshot = await raw.read();
  const slot = snapshot.extensions[mcpFormApprovalContract.id];
  if (slot?.status !== "running")
    throw new Error("Local approval projection unavailable");
  const projection = Schema.decodeUnknownSync(
    mcpFormApprovalContract.projection.schema,
  )(slot.value);
  expect(projection.pending).toHaveLength(1);
  const form = projection.pending[0];
  if (form === undefined) throw new Error("Missing projected approval");
  expect(form.id).not.toBe(submitted.recordId);
  expect(form.approval).toEqual(
    await capability.get({ recordId: submitted.recordId }),
  );
  const answer = {
    id: form.id,
    decision: "approve",
    expectedRevision: form.approval.record.revision,
  };
  let watch: Awaited<ReturnType<typeof session.watch>> | undefined;
  try {
    expect(
      await raw.extension(mcpFormApprovalContract.id).call("answer", answer),
    ).toEqual({ kind: "refused", reason: "not-attached" });
    expect(
      await session
        .extension(mcpFormApprovalContract.id)
        .call("answer", answer),
    ).toEqual({ kind: "refused", reason: "not-attached" });
    watch = await session.watch();
    expect(
      await session.extension(mcpFormApprovalContract.id).call("answer", {
        ...answer,
        expectedRevision: answer.expectedRevision + 1,
      }),
    ).toEqual({ kind: "refused", reason: "stale-revision" });
    expect(ledger.get(submitted.recordId)?.state).toBe("pending");
    const eligibleActor = actor;
    actor = { ...eligibleActor, mayUseOperation: false };
    expect(
      await session
        .extension(mcpFormApprovalContract.id)
        .call("answer", answer),
    ).toEqual({ kind: "refused", reason: "not-eligible" });
    expect(ledger.get(submitted.recordId)?.state).toBe("pending");
    actor = eligibleActor;
    expect(
      await session
        .extension(mcpFormApprovalContract.id)
        .call("answer", answer),
    ).toMatchObject({
      kind: "answered",
      view: { record: { recordId: submitted.recordId, state: "applied" } },
    });
    expect(await readFile(join(root, "effects.txt"), "utf8")).toBe("saved\n");
    expect(
      await session
        .extension(mcpFormApprovalContract.id)
        .call("answer", answer),
    ).toEqual({ kind: "refused", reason: "not-pending" });
    expect(await readFile(join(root, "effects.txt"), "utf8")).toBe("saved\n");
  } finally {
    await watch?.close();
    attachment.close();
    await host.close();
    await local.processes.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
