import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  ApprovalLedger,
  type ApprovalAnswerer,
  type ApprovalApplyHost,
  type ApprovalRequest,
} from "@fungi.computer/approvals";
import { Mycelium } from "@fungi.computer/mycelium";
import { invokeModuleOperation } from "@fungi.computer/mycelium/remote";
import type { SqliteOwner } from "@fungi.computer/shiitake";
import {
  createPrivateSqliteOwner,
  openPrivateWritableSqliteDatabase,
} from "../src/private-sqlite-owner.js";

const actor: ApprovalAnswerer = {
  kind: "human",
  memberId: "driver-owner",
  role: "owner",
  actingForAgent: false,
  mayUseOperation: true,
};
const request: ApprovalRequest = {
  requester: {
    principalId: "driver-agent",
    agentId: "driver-agent",
    sessionId: "driver-session",
    displayName: "Driver Agent",
  },
  module: "native-notes",
  operation: "write",
  access: "write",
  reversibility: "reversible",
  authorityFence: "driver-fixture:1",
  idempotencyKey: "persisted-command/tool/0",
  inputJson: '{"text":"saved through native driver"}',
};
const home = { kind: "local", id: "native-driver-fixture" } as const;
function disableAutoApprove(ledger: ApprovalLedger) {
  assert.equal(
    ledger.setAutoApprove(
      {
        scope: { agentId: null },
        family: { module: null, access: "write" },
        enabled: false,
      },
      actor,
    ).kind,
    "updated",
  );
}
function applyHost(owner: SqliteOwner): ApprovalApplyHost {
  const module = Mycelium.module({
    id: request.module,
    name: "notes",
    operations: {
      write: Mycelium.operation({
        access: "write",
        input: z.strictObject({ text: z.string() }),
        output: z.strictObject({ saved: z.string() }),
        execute: ({ text }) => {
          owner.sql.exec("INSERT INTO native_effects VALUES (?)", text);
          return Promise.resolve({ saved: text });
        },
      }),
    },
  });
  return {
    recheck: () =>
      Promise.resolve({
        kind: "authorized",
        authorityFence: request.authorityFence,
      }),
    dispatch: async ({ record, input }) => ({
      kind: "completed",
      output: await invokeModuleOperation(module, record.operation, input, {
        executionId: record.recordId,
        deadlineAt: null,
        signal: AbortSignal.timeout(5_000),
      }),
    }),
  };
}

// Native driver parity, not a substitute for production requester/grant/Session proofs.
export async function nativeApprovalDriverReplay() {
  const directory = mkdtempSync(join(tmpdir(), "local-approval-driver-"));
  try {
    const path = join(directory, "agent.sqlite");
    const first = openPrivateWritableSqliteDatabase(path, 0);
    let recordId: string;
    try {
      const owner = createPrivateSqliteOwner(first);
      owner.sql.exec("CREATE TABLE native_effects (text TEXT NOT NULL)");
      const ledger = new ApprovalLedger({ owner, home, now: () => 100 });
      disableAutoApprove(ledger);
      const pending = await ledger.submit(request, applyHost(owner));
      assert.ok(pending.kind === "pending_approval");
      recordId = pending.recordId;
      const record = ledger.get(recordId);
      assert.ok(record);
      assert.equal(record.state, "pending");
      assert.equal(
        ledger.answer(
          { recordId, expectedRevision: record.revision, decision: "approve" },
          actor,
        ).kind,
        "answered",
      );
      assert.deepEqual(
        owner.sql.exec("SELECT * FROM native_effects").toArray(),
        [],
      );
    } finally {
      first.close();
    }
    const reopened = openPrivateWritableSqliteDatabase(path, 0);
    try {
      const owner = createPrivateSqliteOwner(reopened);
      const ledger = new ApprovalLedger({ owner, home, now: () => 200 });
      const host = applyHost(owner);
      assert.equal((await ledger.apply(recordId, host)).kind, "applied");
      // A human-approved result reaches the requester as its own message; a
      // retried request reports it as answered and never applies again.
      assert.deepEqual(await ledger.submit(request, host), {
        kind: "refused",
        reason: "already-answered",
      });
      assert.equal((await ledger.apply(recordId, host)).kind, "applied");
      assert.deepEqual(
        owner.sql.exec("SELECT * FROM native_effects").toArray(),
        [{ text: "saved through native driver" }],
      );
      assert.equal(reopened.isTransaction, false);
      assert.equal(reopened.prepare("SELECT 42 AS value").get()?.value, 42);
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function nativeApprovalDriverRollback() {
  const database = openPrivateWritableSqliteDatabase(":memory:", 0);
  try {
    const owner = createPrivateSqliteOwner(database);
    owner.sql.exec("CREATE TABLE native_targets (record_id TEXT PRIMARY KEY)");
    const failure = new Error("native target persistence failed");
    let fail = true;
    const ledger = new ApprovalLedger({
      owner,
      home,
      now: () => 100,
      persistIntent: (record) => {
        owner.sql.exec(
          "INSERT INTO native_targets VALUES (?)",
          record.recordId,
        );
        if (fail) throw failure;
        return undefined;
      },
    });
    disableAutoApprove(ledger);
    await assert.rejects(
      ledger.submit(request, applyHost(owner)),
      (cause) => cause === failure,
    );
    const capability = ledger.capability({
      actor: () => Promise.resolve(actor),
      decision: () =>
        Promise.reject(new Error("Read must not decide an approval")),
    });
    assert.deepEqual((await capability.list({})).items, []);
    assert.deepEqual(ledger.pendingHandoffs(), []);
    assert.equal(
      owner.sql.exec("SELECT count(*) AS count FROM native_targets").one()
        .count,
      0,
    );
    fail = false;
    const pending = await ledger.submit(request, applyHost(owner));
    assert.ok(pending.kind === "pending_approval");
    const outerFailure = new Error("outer rollback after released inner");
    assert.throws(
      () =>
        owner.transactionSync(() => {
          const record = ledger.get(pending.recordId);
          assert.ok(record);
          assert.equal(
            ledger.answer(
              {
                recordId: record.recordId,
                expectedRevision: record.revision,
                decision: "deny",
              },
              actor,
            ).kind,
            "answered",
          );
          throw outerFailure;
        }),
      (cause) => cause === outerFailure,
    );
    assert.equal(ledger.get(pending.recordId)?.state, "pending");
    assert.equal(database.isTransaction, false);
    assert.equal(database.prepare("SELECT 42 AS value").get()?.value, 42);
  } finally {
    database.close();
  }
}
