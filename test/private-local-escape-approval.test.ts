import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  ApprovalLedger,
  type ApprovalApplyHost,
} from "@fungi.computer/approvals";
import { dispatchApprovedLocalExec } from "../src/private-invocation-computer.js";
import { createPrivateLocalComputerProcesses } from "../src/private-local-computer-processes.js";

const execFile = promisify(execFileCallback);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "fungi-approved-commit-"));
  const processes = createPrivateLocalComputerProcesses(root);
  const database = new DatabaseSync(":memory:");
  cleanups.push(async () => {
    await processes.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  });
  await execFile("git", ["init", "-q", root]);
  await execFile("git", ["-C", root, "config", "user.name", "Test"]);
  await execFile("git", [
    "-C",
    root,
    "config",
    "user.email",
    "test@example.invalid",
  ]);
  await writeFile(join(root, "tracked.txt"), "approved\n");
  await execFile("git", ["-C", root, "add", "tracked.txt"]);
  const ledger = new ApprovalLedger({
    owner: fromNodeSqlite(database),
    home: { kind: "local", id: "commit-proof" },
    now: Date.now,
  });
  let mode = "workspace";
  const fence = () => JSON.stringify([mode, root]);
  const host: ApprovalApplyHost = {
    recheck: () =>
      Promise.resolve({ kind: "authorized", authorityFence: fence() }),
    dispatch: async ({ input }) => {
      const evidence = z
        .object({
          request: z.unknown(),
          cwd: z.string(),
        })
        .parse(input);
      const output = await dispatchApprovedLocalExec(
        evidence.request,
        evidence.cwd,
        "/usr/bin:/bin",
        root,
        processes.scope("main"),
        "workspace",
      );
      return { kind: "completed", output: z.json().parse(output) };
    },
  };
  async function stage(key: string) {
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
      authorityFence: fence(),
      idempotencyKey: key,
      inputJson: JSON.stringify({
        request: {
          operation: "run",
          executable: "git",
          args: ["commit", "-m", key],
        },
        cwd: root,
        mode,
        denialLine: "Read-only file system",
      }),
      requireHumanApproval: true,
    });
    if (result.kind !== "record") throw new Error(result.reason);
    return result.record;
  }
  const human = {
    kind: "human" as const,
    memberId: "owner",
    role: "owner" as const,
    actingForAgent: false,
    mayUseOperation: true,
  };
  return {
    root,
    ledger,
    host,
    human,
    stage,
    changeMode: () => {
      mode = "read-only";
    },
  };
}

it("approval claims one unsandboxed git commit; a second approval does not dispatch", async () => {
  const { root, ledger, host, human, stage } = await fixture();
  const record = await stage("approved-once");
  expect(
    ledger.answer(
      {
        recordId: record.recordId,
        decision: "approve",
        expectedRevision: record.revision,
      },
      human,
    ),
  ).toMatchObject({ kind: "answered" });
  expect(
    ledger.answer(
      {
        recordId: record.recordId,
        decision: "approve",
        expectedRevision: record.revision,
      },
      human,
    ),
  ).toMatchObject({ kind: "refused" });
  expect(await ledger.apply(record.recordId, host)).toMatchObject({
    kind: "applied",
  });
  expect(await ledger.apply(record.recordId, host)).toMatchObject({
    kind: "applied",
  });
  const log = await execFile("git", ["-C", root, "log", "--format=%s"]);
  expect(log.stdout.trim()).toBe("approved-once");
  expect(await readFile(join(root, "tracked.txt"), "utf8")).toBe("approved\n");
  const notices: string[] = [];
  expect(
    await ledger.handoff(record.recordId, (notice) => {
      notices.push(notice.deliveryId);
      return Promise.resolve({ commandId: "delivered" });
    }),
  ).toMatchObject({ kind: "delivered" });
  expect(notices).toHaveLength(1);
});

it("deny and a changed mode refuse an escaped commit without changing Git history", async () => {
  const { root, ledger, host, human, stage, changeMode } = await fixture();
  const denied = await stage("denied");
  ledger.answer(
    {
      recordId: denied.recordId,
      decision: "deny",
      expectedRevision: denied.revision,
    },
    human,
  );
  expect(await ledger.apply(denied.recordId, host)).toMatchObject({
    kind: "refused",
  });
  const changed = await stage("changed");
  ledger.answer(
    {
      recordId: changed.recordId,
      decision: "approve",
      expectedRevision: changed.revision,
    },
    human,
  );
  changeMode();
  expect(await ledger.apply(changed.recordId, host)).toMatchObject({
    kind: "refused",
    reason: "fenced",
  });
  await expect(execFile("git", ["-C", root, "log", "-1"])).rejects.toThrow();
});

it("a real Workspace Agent runs a narrow rule without writing a ledger approval", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { createModels } = await import("@earendil-works/pi-ai");
  const { fauxAssistantMessage, fauxProvider, fauxToolCall } =
    await import("@earendil-works/pi-ai/providers/faux");
  const { capturePrivateLocalConfigRoot } =
    await import("../src/private-local-config-root.js");
  const { localExecRules } = await import("../src/private-local-exec-rules.js");
  const { openPrivateLocalRuntimeHost } =
    await import("../dist/private-local-runtime-host.js");
  const area = await mkdtemp(join(tmpdir(), "fungi-project-rule-host-"));
  const project = join(area, "project");
  const home = join(area, "home");
  await mkdir(project);
  await mkdir(home);
  cleanups.push(() => rm(area, { recursive: true, force: true }));
  await execFile("git", ["init", "-q", project]);
  await execFile("git", ["-C", project, "config", "user.name", "Test"]);
  await execFile("git", [
    "-C",
    project,
    "config",
    "user.email",
    "test@example.invalid",
  ]);
  await writeFile(join(project, "tracked"), "approved\n");
  await execFile("git", ["-C", project, "add", "tracked"]);
  await writeFile(
    join(project, ".git", "hooks", "pre-commit"),
    "#!/bin/sh\necho rule-stdout\necho rule-stderr >&2\nsleep 0.6\n",
    { mode: 0o755 },
  );
  localExecRules(project).add(["git", "commit"]);
  localExecRules(project).add(["git", "status"]);
  const nested = join(project, "nested");
  await mkdir(nested);
  await execFile("git", ["init", "-q", nested]);
  const faux = fauxProvider({
    provider: "narrow-rule-proof",
    models: [{ id: "probe", name: "Narrow rule proof" }],
  });
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("execute", {
        code:
          "return await env.computers.local.exec(" +
          JSON.stringify({
            executable: "git",
            args: ["status"],
            cwd: nested,
          }) +
          ")",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage(
      fauxToolCall("execute", {
        code:
          "return await env.computers.local.exec(" +
          JSON.stringify({
            executable: "git",
            args: ["commit", "-am", "rule-matched"],
          }) +
          ")",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  const models = createModels();
  models.setProvider(faux.provider);
  const matchedRules: {
    agentId: string;
    executable: string;
    ruleId: string;
  }[] = [];
  const host = await openPrivateLocalRuntimeHost(
    {
      invocationRoot: project,
      configRoot: capturePrivateLocalConfigRoot(home),
      providerId: "narrow-rule-proof",
      modelId: "probe",
      mode: "workspace",
      onExecRuleMatch: (match) => {
        matchedRules.push(match);
      },
    },
    models,
  );
  try {
    const watch = await host.session.watch();
    try {
      const accepted = await host.session.send("Commit the staged change.", {
        requestId: "narrow-rule-run",
      });
      let completed = false;
      let liveRuleOutput = false;
      for await (const frame of watch.changes) {
        if (frame.kind === "tool_output") {
          liveRuleOutput ||= frame.toolOutput.some(
            (output) =>
              output.tail.includes("rule-stdout") &&
              output.tail.includes("rule-stderr"),
          );
        }
        if (frame.kind !== "update") continue;
        const terminal = frame.terminals.find(
          (item) => item.commandId === accepted.commandId,
        );
        if (terminal === undefined) continue;
        expect(terminal.outcome).toBe("completed");
        completed = true;
        break;
      }
      expect(completed).toBe(true);
      expect(liveRuleOutput).toBe(true);
    } finally {
      await watch.close();
    }
    const log = await execFile("git", [
      "-C",
      project,
      "log",
      "-1",
      "--format=%s",
    ]);
    expect(log.stdout.trim()).toBe("rule-matched");
    const database = new DatabaseSync(host.databasePath);
    try {
      expect(
        database
          .prepare("SELECT count(*) AS total FROM approval_records")
          .get(),
      ).toMatchObject({ total: 0 });
      expect(
        database
          .prepare(
            "SELECT name FROM sqlite_master WHERE name = 'private_local_exec_rules'",
          )
          .get(),
      ).toBeUndefined();
      const agent = z
        .object({ agent_id: z.string() })
        .parse(
          database.prepare("SELECT agent_id FROM private_local_identity").get(),
        );
      expect(matchedRules).toEqual([
        {
          agentId: agent.agent_id,
          executable: "git",
          ruleId: localExecRules(project).match(["git", "commit"])?.ruleId,
        },
      ]);
    } finally {
      database.close();
    }
  } finally {
    await host.close();
  }
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("execute", {
        code:
          "return await env.computers.local.exec(" +
          JSON.stringify({ executable: "git", args: ["status"] }) +
          ")",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  const readOnlyHost = await openPrivateLocalRuntimeHost(
    {
      invocationRoot: project,
      configRoot: capturePrivateLocalConfigRoot(home),
      providerId: "narrow-rule-proof",
      modelId: "probe",
      mode: "read-only",
      onExecRuleMatch: (match) => matchedRules.push(match),
    },
    models,
  );
  try {
    const watch = await readOnlyHost.session.watch();
    try {
      const accepted = await readOnlyHost.session.send("Check status.", {
        requestId: "read-only-no-rule",
      });
      for await (const frame of watch.changes) {
        if (frame.kind !== "update") continue;
        const terminal = frame.terminals.find(
          (item) => item.commandId === accepted.commandId,
        );
        if (terminal !== undefined) {
          expect(terminal.outcome).toBe("completed");
          break;
        }
      }
    } finally {
      await watch.close();
    }
    expect(matchedRules).toHaveLength(1);
  } finally {
    await readOnlyHost.close();
  }
  const late = join(area, "late-project");
  await mkdir(late);
  localExecRules(late).add(["git", "status"]);
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("execute", {
        code:
          "return await env.computers.local.exec(" +
          JSON.stringify({ executable: "git", args: ["status"] }) +
          ")",
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("done"),
  ]);
  let lateMatches = 0;
  const lateHost = await openPrivateLocalRuntimeHost(
    {
      invocationRoot: late,
      configRoot: capturePrivateLocalConfigRoot(home),
      providerId: "narrow-rule-proof",
      modelId: "probe",
      mode: "workspace",
      onExecRuleMatch: () => {
        lateMatches += 1;
      },
    },
    models,
  );
  try {
    // The project had no protected Git marker when its Session was opened.
    // Simulate an Agent creating its own .git before the next command.
    await execFile("git", ["init", "-q", late]);
    const watch = await lateHost.session.watch();
    try {
      const accepted = await lateHost.session.send("Check status.", {
        requestId: "late-agent-repo",
      });
      for await (const frame of watch.changes) {
        if (frame.kind !== "update") continue;
        const terminal = frame.terminals.find(
          (item) => item.commandId === accepted.commandId,
        );
        if (terminal !== undefined) {
          expect(terminal.outcome).toBe("completed");
          break;
        }
      }
    } finally {
      await watch.close();
    }
    expect(lateMatches).toBe(0);
  } finally {
    await lateHost.close();
  }
}, 30_000);
