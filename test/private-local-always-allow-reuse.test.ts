import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  ApprovalLedger,
  type ApprovalApplyHost,
} from "@fungi.computer/approvals";
import type { InvocationContext } from "@fungi.computer/mycelium";
import { expect, it } from "vitest";
import {
  createPrivateInvocationComputer,
  dispatchApprovedLocalExec,
  shellOutput,
} from "../src/private-invocation-computer.js";
import { localExecEscapeReview } from "../src/private-local-exec-review.js";
import { localExecRules } from "../src/private-local-exec-rules.js";
import { createPrivateLocalComputerProcesses } from "../src/private-local-computer-processes.js";

const execFile = promisify(execFileCallback);
const context: InvocationContext = {
  executionId: "git-commit-reuse",
  deadlineAt: null,
  signal: new AbortController().signal,
};

it("shell-form Git cannot offer argv reuse and explains why in Details", () => {
  const review = localExecEscapeReview(
    {
      command: 'git commit -am "another message"',
      escape: { justification: "Git metadata is protected" },
    },
    "/project",
  );
  expect(review.prefix).toBeUndefined();
  expect(review.alwaysAllowUnavailableReason).toContain("Shell");
});

it("a saved Always allow git commit applies to a later -am; shell asks once", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-commit-reuse-"));
  const database = new DatabaseSync(":memory:");
  const processes = createPrivateLocalComputerProcesses(root);
  const git = (args: string[]) => execFile("git", ["-C", root, ...args]);
  try {
    await git(["init", "-q"]);
    await git(["config", "user.name", "Fixture"]);
    await git(["config", "user.email", "fixture@example.invalid"]);
    await writeFile(join(root, "tracked.txt"), "first\n");
    await git(["add", "tracked.txt"]);
    const rules = localExecRules(root);
    const ledger = new ApprovalLedger({
      owner: fromNodeSqlite(database),
      home: { kind: "local", id: "commit-reuse" },
      now: Date.now,
    });
    const apply: ApprovalApplyHost = {
      recheck: (record) =>
        Promise.resolve({
          kind: "authorized",
          authorityFence: record.authorityFence,
        }),
      dispatch: async ({ input }) => {
        const saved = z
          .object({ request: z.unknown(), cwd: z.string() })
          .parse(input);
        return {
          kind: "completed",
          output: z
            .json()
            .parse(
              await dispatchApprovedLocalExec(
                saved.request,
                saved.cwd,
                "/usr/bin:/bin",
                root,
                processes.scope("main"),
                "workspace",
              ),
            ),
        };
      },
    };
    let ordinal = 0;
    const cards: ReturnType<typeof localExecEscapeReview>[] = [];
    const computer = await createPrivateInvocationComputer(
      root,
      "/usr/bin:/bin",
      processes.scope("main"),
      root,
      undefined,
      () => "workspace",
      async ({ request, cwd }) => {
        ordinal++;
        const review = localExecEscapeReview(request, cwd, {
          configuredRemotes: new Set(),
        });
        cards.push(review);
        const result = await ledger.request({
          requester: {
            principalId: "agent",
            agentId: "agent",
            sessionId: "main",
            displayName: "Agent",
          },
          module: "computer",
          operation: "exec",
          access: "external",
          reversibility: "irreversible-external",
          authorityFence: "workspace:" + root,
          idempotencyKey: String(ordinal),
          inputJson: JSON.stringify({ request, cwd }),
          requireHumanApproval: true,
        });
        if (result.kind !== "record") throw new Error("Approval not staged");
        return {
          kind: "pending_approval",
          recordId: result.record.recordId,
          description: result.record.description,
        };
      },
      async ({ request, cwd }) => {
        if (!("executable" in request)) return undefined;
        const match = rules.match([request.executable, ...request.args]);
        return match === undefined
          ? undefined
          : shellOutput.parse(
              await dispatchApprovedLocalExec(
                request,
                cwd,
                "/usr/bin:/bin",
                root,
                processes.scope("main"),
                "workspace",
              ),
            );
      },
    );
    const run = (
      input: Record<string, string | string[] | { justification: string }>,
    ) => computer.call("exec", input, context);
    const first = await run({
      executable: "git",
      args: ["commit", "-m", "first"],
      escape: { justification: "Git metadata is protected" },
    });
    expect(first).toMatchObject({ kind: "pending_approval" });
    expect(cards[0]?.prefix).toEqual(["git", "commit"]);
    const { recordId } = z.object({ recordId: z.string() }).parse(first);
    const record = ledger.get(recordId);
    if (!record) throw new Error("Approval record missing");
    expect(
      ledger.answer(
        {
          recordId: record.recordId,
          decision: "approve",
          expectedRevision: record.revision,
        },
        {
          kind: "human",
          memberId: "owner",
          role: "owner",
          actingForAgent: false,
          mayUseOperation: true,
        },
      ),
    ).toMatchObject({ kind: "answered" });
    rules.add(cards[0]?.prefix ?? []);
    expect(await ledger.apply(record.recordId, apply)).toMatchObject({
      kind: "applied",
    });
    const saved = z
      .object({
        version: z.number(),
        rules: z.array(
          z.object({ id: z.string(), prefix: z.array(z.string()) }),
        ),
      })
      .parse(
        JSON.parse(
          await readFile(join(root, ".fungi", "exec-rules.json"), "utf8"),
        ),
      );
    expect(saved).toMatchObject({
      version: 2,
      rules: [{ prefix: ["git", "commit"] }],
    });
    await writeFile(join(root, "tracked.txt"), "second\n");
    expect(
      await run({
        executable: "git",
        args: ["commit", "-am", "second"],
        escape: { justification: "Git metadata is protected" },
      }),
    ).toMatchObject({ status: "completed", exitCode: 0 });
    expect(cards).toHaveLength(1);
    expect(cards[0]?.alwaysAllowCoverage).toContain("-am");
    expect((await git(["log", "-2", "--format=%s"])).stdout.trim()).toBe(
      "second\nfirst",
    );
    expect(
      database.prepare("SELECT count(*) AS total FROM approval_records").get(),
    ).toMatchObject({ total: 1 });
    await writeFile(join(root, "tracked.txt"), "third\n");
    expect(
      await run({
        command: 'git commit -am "third"',
        escape: { justification: "Git metadata is protected" },
      }),
    ).toMatchObject({ kind: "pending_approval" });
    expect(cards[1]?.prefix).toBeUndefined();
    expect(cards[1]?.alwaysAllowUnavailableReason).toContain("Shell");
    expect(saved.rules[0]?.id).toMatch(/^local_exec_rule/u);
  } finally {
    await processes.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
