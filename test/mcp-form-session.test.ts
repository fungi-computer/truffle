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
import { localExecRules } from "../src/private-local-exec-rules.js";
import { mcpFormApprovalContract } from "../src/private-mcp-form-contract.js";

it("rejects omitted and unknown answer decisions at the Session command boundary", () => {
  const decode = Schema.decodeUnknownSync(
    mcpFormApprovalContract.commands.answer.input,
  );
  for (const decision of [undefined, "always", "Always allow"]) {
    expect(() =>
      decode({ id: "pending-1", expectedRevision: 1, decision }),
    ).toThrow();
  }
  expect(
    decode({ id: "pending-1", expectedRevision: 1, decision: "approve" })
      .decision,
  ).toBe("approve");
});

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
  const order: string[] = [];
  let ruleIntent = false;
  const rules = localExecRules(root);
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
      order.push("dispatch");
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
      if (ruleIntent) {
        order.push("rule");
        rules.add(["notes", "write"]);
      }
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
    {
      command: "notes write",
      cwd: root,
      justification: "Write blocked",
      form: "direct",
      kind: "exec",
      argv: ["notes", "write"],
      prefix: ["notes", "write"],
      alwaysAllowCoverage: "Direct argv notes write in this project",
    },
    (selected) => {
      ruleIntent = selected === "prefix";
    },
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
  expect(form.review?.alwaysAllowCoverage).toBe(
    "Direct argv notes write in this project",
  );
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
      await raw.extension(mcpFormApprovalContract.id).call("answer", {
        ...answer,
        decision: "always-allow",
      }),
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
        decision: "always-allow",
        expectedRevision: answer.expectedRevision + 1,
      }),
    ).toEqual({ kind: "refused", reason: "stale-revision" });
    expect(ledger.get(submitted.recordId)?.state).toBe("pending");
    const eligibleActor = actor;
    actor = { ...eligibleActor, mayUseOperation: false };
    expect(
      await session
        .extension(mcpFormApprovalContract.id)
        .call("answer", { ...answer, decision: "approve" }),
    ).toEqual({ kind: "refused", reason: "not-eligible" });
    expect(ledger.get(submitted.recordId)?.state).toBe("pending");
    actor = eligibleActor;
    expect(
      await session
        .extension(mcpFormApprovalContract.id)
        .call("answer", { ...answer, decision: "approve" }),
    ).toMatchObject({
      kind: "answered",
      view: { record: { recordId: submitted.recordId, state: "applied" } },
    });
    expect(await readFile(join(root, "effects.txt"), "utf8")).toBe("saved\n");
    expect(order).toEqual(["dispatch"]);
    expect(rules.list()).toEqual([]);
    expect(
      await session
        .extension(mcpFormApprovalContract.id)
        .call("answer", answer),
    ).toEqual({ kind: "refused", reason: "not-pending" });
    expect(await readFile(join(root, "effects.txt"), "utf8")).toBe("saved\n");

    const submitAgain = async (key: string) => {
      const next = await ledger.submit(
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
          idempotencyKey: key,
          inputJson: '{"text":"saved again"}',
        },
        effect,
      );
      if (next.kind !== "pending_approval")
        throw new Error("Fixture did not stage another approval");
      const presented = await local.presentApproval(
        sessionId,
        next,
        capability,
        {
          form: "direct",
          kind: "exec",
          command: "notes write",
          cwd: root,
          justification: "Write blocked",
          ...(key.endsWith("tool:3/operation:0")
            ? {
                alwaysAllowUnavailableReason:
                  "This request has no reusable rule.",
              }
            : { prefix: ["notes", "write"] }),
        },
        (selected) => {
          ruleIntent = selected === "prefix";
        },
      );
      if (presented.kind !== "presented")
        throw new Error("Local host did not present the approval");
      const slot = (await raw.read()).extensions[mcpFormApprovalContract.id];
      if (slot?.status !== "running")
        throw new Error("Local approval projection unavailable");
      const form = Schema.decodeUnknownSync(
        mcpFormApprovalContract.projection.schema,
      )(slot.value).pending[0];
      if (!form) throw new Error("Missing projected approval");
      return { next, form };
    };
    const second = await submitAgain("fixture-turn:1/tool:2/operation:0");
    expect(
      await session.extension(mcpFormApprovalContract.id).call("answer", {
        id: second.form.id,
        decision: "always-allow",
        expectedRevision: second.form.approval.record.revision,
      }),
    ).toMatchObject({
      kind: "answered",
      view: { record: { recordId: second.next.recordId, state: "applied" } },
    });
    expect(rules.list()).toEqual([["notes", "write"]]);
    expect(order).toEqual(["dispatch", "rule", "dispatch"]);

    const third = await submitAgain("fixture-turn:1/tool:3/operation:0");
    expect(third.form.review?.alwaysAllowUnavailableReason).toBe(
      "This request has no reusable rule.",
    );
    expect(
      await session.extension(mcpFormApprovalContract.id).call("answer", {
        id: third.form.id,
        decision: "deny",
        expectedRevision: third.form.approval.record.revision,
        denialNote: "Use the sandbox instead",
      }),
    ).toMatchObject({
      kind: "answered",
      view: {
        record: { state: "denied", denialNote: "Use the sandbox instead" },
      },
    });
    expect(order).toEqual(["dispatch", "rule", "dispatch"]);
  } finally {
    await watch?.close();
    attachment.close();
    await host.close();
    await local.processes.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
