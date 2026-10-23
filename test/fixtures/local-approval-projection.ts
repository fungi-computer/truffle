import assert from "node:assert/strict";
import * as Schema from "effect/Schema";
import {
  ApprovalLedger,
  type ApprovalAnswerer,
} from "@fungi.computer/approvals";
import { correlationKey } from "@fungi.computer/cairn";
import { mcpFormApprovalContract } from "../../src/private-mcp-form-contract.js";
import {
  createPrivateSqliteOwner,
  openPrivateWritableSqliteDatabase,
} from "../../src/private-sqlite-owner.js";

export async function assertLocalApprovalProjection() {
  const database = openPrivateWritableSqliteDatabase(":memory:", 0);
  try {
    const ledger = new ApprovalLedger({
      owner: createPrivateSqliteOwner(database),
      home: { kind: "local", id: "fixture-local-home" },
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
    const pending = await ledger.submit(
      {
        requester: {
          principalId: "fixture-agent",
          agentId: "fixture-agent",
          sessionId: "fixture-session",
          displayName: "Fixture Agent",
        },
        module: "fixture-notes",
        operation: "write",
        access: "write",
        reversibility: "reversible",
        authorityFence: "fixture-grant-generation:1",
        idempotencyKey: "fixture-turn:1/tool:1/operation:0",
        inputJson: '{"text":"saved"}',
      },
      {
        recheck: (record) =>
          Promise.resolve({
            kind: "authorized",
            authorityFence: record.authorityFence,
          }),
        dispatch: () => {
          throw new Error("Pending submission must not dispatch");
        },
      },
    );
    if (pending.kind !== "pending_approval")
      throw new Error("Fixture policy did not stage an approval");
    const capability = ledger.capability({
      actor: () => Promise.resolve(actor),
      decision: () => {
        throw new Error("Reading a pending form must not decide it");
      },
    });
    const view = await capability.get({ recordId: pending.recordId });
    assert.equal(view?.record.recordId, pending.recordId);
    assert.equal(view.canAnswer, true);
    const formId = correlationKey();
    assert.notEqual(formId, pending.recordId);
    assert.equal(
      Schema.is(mcpFormApprovalContract.projection.schema)({
        pending: [{ id: formId, approval: view }],
      }),
      true,
    );
  } finally {
    database.close();
  }
}
