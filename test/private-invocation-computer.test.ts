import { directSandbox } from "@fungi.computer/mycelium/testing";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import { promisify } from "node:util";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { Knapsack, type KnapsackComputer } from "@fungi.computer/knapsack";
import { Mycelium, type InvocationContext } from "@fungi.computer/mycelium";
import {
  createPrivateInvocationComputer,
  likelySandboxDenied,
  runPrivateInvocationProcess,
} from "../src/private-invocation-computer.js";
import { createPrivateLocalComputerProcesses } from "../src/private-local-computer-processes.js";

const execFile = promisify(execFileCallback);

const temporaryDirectories: string[] = [];
const execResultSchema = z.strictObject({
  status: z.enum(["completed", "failed", "deadline_exceeded"]),
  elapsedMs: z.number().nonnegative().optional(),
  timeoutMs: z.number().positive().optional(),
  message: z.string().optional(),
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  sandbox: z.strictObject({
    mode: z.enum(["full-access", "workspace", "read-only"]),
    likelyDenied: z.boolean(),
    ranOutsideSandbox: z.boolean(),
  }),
  truncated: z.union([
    z.literal(false),
    z
      .array(
        z.strictObject({
          stream: z.enum(["stdout", "stderr"]),
          keptBytes: z.number().int(),
          totalBytes: z.number().int(),
        }),
      )
      .min(1),
  ]),
});

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(label: string) {
  const directory = await mkdtemp(join(tmpdir(), `fungi-local-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

it("exec streams stdout and stderr before exit without changing its terminal result", async () => {
  const root = await temporaryDirectory("live-output");
  const computer = await createPrivateInvocationComputer(root);
  const command =
    "for i in 1 2 3; do echo $i; echo e$i >&2; sleep 0.2; done; touch finished";
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const live = Promise.withResolvers<"output">();
  const running = computer.call(
    "exec",
    { command },
    {
      ...invocation(),
      output: {
        write: (stream, bytes) => {
          (stream === "stdout" ? stdout : stderr).push(bytes.slice());
          if (stdout.length > 0 && stderr.length > 0) live.resolve("output");
        },
      },
    },
  );
  try {
    expect(
      await Promise.race([live.promise, running.then(() => "terminal")]),
    ).toBe("output");
    expect(await exists(join(root, "finished"))).toBe(false);
  } finally {
    await running;
  }
  expect(Buffer.concat(stdout).toString()).toBe("1\n2\n3\n");
  expect(Buffer.concat(stderr).toString()).toBe("e1\ne2\ne3\n");
  const result = await running;
  expect(result).toEqual({
    status: "completed",
    exitCode: 0,
    stdout: "1\n2\n3\n",
    stderr: "e1\ne2\ne3\n",
    truncated: false,
    sandbox: {
      mode: "full-access",
      likelyDenied: false,
      ranOutsideSandbox: true,
    },
  });
  // Direct callers outside execute have no sink and retain the same contract.
  expect(await computer.call("exec", { command }, invocation())).toEqual(
    result,
  );
});

it("env reaches the direct form; HOME is refused", async () => {
  const root = await temporaryDirectory("exec-env-direct");
  const computer = await createPrivateInvocationComputer(root);
  const result = execResultSchema.parse(
    await computer.call(
      "exec",
      {
        executable: process.execPath,
        args: ["-e", "process.stdout.write(process.env.CUSTOM_VALUE ?? '')"],
        env: {
          ...Object.fromEntries(
            Array.from({ length: 63 }, (_, index) => [
              `KEY_${String(index)}`,
              "x".repeat(1_024),
            ]),
          ),
          CUSTOM_VALUE: "space ; $literal\nvalue",
        },
      },
      invocation(),
    ),
  );
  expect(result).toMatchObject({
    status: "completed",
    stdout: "space ; $literal\nvalue",
  });
  await expect(
    computer.call(
      "exec",
      { executable: "true", env: { HOME: root } },
      invocation(),
    ),
  ).rejects.toThrow();
});

it("env reaches the shell form with the same bounded name grammar", async () => {
  const root = await temporaryDirectory("exec-env-shell");
  const computer = await createPrivateInvocationComputer(root);
  const result = execResultSchema.parse(
    await computer.call(
      "exec",
      {
        command: 'printf "%s" "$CUSTOM_VALUE"',
        env: { CUSTOM_VALUE: "hello" },
      },
      invocation(),
    ),
  );
  expect(result).toMatchObject({ status: "completed", stdout: "hello" });
  for (const env of [
    { PATH: "/tmp" },
    { XDG_RUNTIME_DIR: "/tmp" },
    { DBUS_SESSION_BUS_ADDRESS: "invalid" },
    { TMPDIR: "/tmp" },
    { SSH_AUTH_SOCK: "/tmp/agent" },
    { FUNGI_SANDBOX: "full-access" },
    { LD_PRELOAD: "/tmp/library.so" },
    { DYLD_INSERT_LIBRARIES: "/tmp/library.dylib" },
    { invalid: "lowercase" },
    { "1INVALID": "leading digit" },
    { VALUE: 1 },
    { VALUE: "\0" },
    Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [`KEY_${String(index)}`, "x"]),
    ),
  ]) {
    await expect(
      computer.call("exec", { command: "true", env }, invocation()),
    ).rejects.toThrow();
    await expect(
      computer.call("exec", { executable: "true", env }, invocation()),
    ).rejects.toThrow();
  }
});

it("env reaches both managed start forms through the same admission grammar", async () => {
  const root = await temporaryDirectory("exec-env-managed");
  const processes = createPrivateLocalComputerProcesses(root);
  const computer = await createPrivateInvocationComputer(
    root,
    "/usr/bin:/bin",
    processes.scope("env"),
  );
  try {
    for (const form of [
      { command: 'printf "%s" "$CUSTOM_VALUE"' },
      {
        executable: process.execPath,
        args: ["-e", "process.stdout.write(process.env.CUSTOM_VALUE ?? '')"],
      },
    ]) {
      const started = z
        .object({ process: z.object({ id: z.string() }) })
        .parse(
          await computer.call(
            "exec",
            { operation: "start", ...form, env: { CUSTOM_VALUE: "managed" } },
            invocation(),
          ),
        );
      const settled = await computer.call(
        "exec",
        { operation: "wait", id: started.process.id, timeoutMs: 1000 },
        invocation(),
      );
      expect(settled).toMatchObject({
        complete: true,
        text: "managed",
        process: { state: "exited", exitCode: 0 },
      });
      await expect(
        computer.call(
          "exec",
          { operation: "start", ...form, env: { HOME: root } },
          invocation(),
        ),
      ).rejects.toThrow();
    }
  } finally {
    await processes.close();
  }
});

it.each(["run", "start"] as const)(
  "refuses 64 oversized env values with a typed validation error before %s launches either form",
  async (operation) => {
    const root = await temporaryDirectory("exec-env-value-bound");
    const processes = createPrivateLocalComputerProcesses(root);
    const computer = await createPrivateInvocationComputer(
      root,
      "/usr/bin:/bin",
      processes.scope("env-value-bound"),
    );
    const env = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `KEY_${String(index)}`,
        "x".repeat(1_025),
      ]),
    );
    try {
      for (const form of [
        { command: "touch should-not-run" },
        {
          executable: process.execPath,
          args: [
            "-e",
            "require('node:fs').writeFileSync('should-not-run', '')",
          ],
        },
      ]) {
        await expect(
          computer.call("exec", { operation, ...form, env }, invocation()),
        ).rejects.toBeInstanceOf(z.ZodError);
        await expect(
          access(join(root, "should-not-run")),
        ).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await processes.close();
    }
  },
);

it("Workspace escape stages without executing, while Full access ignores escape", async () => {
  const root = await temporaryDirectory("escape");
  const marker = join(root, "ran");
  let mode: "workspace" | "full-access" = "workspace";
  const stages: string[] = [];
  const computer = await createPrivateInvocationComputer(
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    () => mode,
    async ({ request, cwd }) => {
      expect(cwd).toBe(await realpath(root));
      stages.push(JSON.stringify(request));
      return {
        kind: "pending_approval",
        recordId: "one",
        description: {
          title: "computer.exec",
          inputBytes: 1,
          inputSha256: "a".repeat(64),
        },
      };
    },
  );
  const input = {
    executable: "touch",
    args: [marker],
    escape: { justification: "sandbox denied" },
  };
  expect(await computer.call("exec", input, invocation())).toMatchObject({
    kind: "pending_approval",
    recordId: "one",
  });
  expect(await exists(marker)).toBe(false);
  expect(await computer.call("exec", input, invocation())).toMatchObject({
    kind: "pending_approval",
    recordId: "one",
  });
  expect(stages).toHaveLength(2);
  mode = "full-access";
  expect(await computer.call("exec", input, invocation())).toMatchObject({
    status: "completed",
    sandbox: { mode: "full-access" },
  });
  expect(await exists(marker)).toBe(true);
  expect(stages).toHaveLength(2);
});

it("a direct argv prefix may run by policy, but shell text still asks", async () => {
  const root = await temporaryDirectory("prefix-policy");
  const decisions: string[] = [];
  let allowed = true;
  const computer = await createPrivateInvocationComputer(
    root,
    undefined,
    undefined,
    undefined,
    undefined,
    () => "workspace",
    () => {
      decisions.push("card");
      return Promise.resolve({
        kind: "pending_approval",
        recordId: "shell",
        description: {
          title: "computer.exec",
          inputBytes: 1,
          inputSha256: "a".repeat(64),
        },
      });
    },
    ({ request }) => {
      if (
        !allowed ||
        !("executable" in request) ||
        request.executable !== "git"
      )
        return Promise.resolve(undefined);
      decisions.push("policy");
      return Promise.resolve({
        status: "completed",
        exitCode: 0,
        stdout: "policy result",
        stderr: "",
        truncated: false,
        sandbox: {
          mode: "workspace",
          likelyDenied: false,
          ranOutsideSandbox: true,
        },
      });
    },
  );
  expect(
    await computer.call(
      "exec",
      { executable: "git", args: ["push", "-u", "origin", "b"] },
      invocation(),
    ),
  ).toMatchObject({ status: "completed", stdout: "policy result" });
  expect(
    await computer.call(
      "exec",
      { command: "git push; touch ~/x", escape: { justification: "blocked" } },
      invocation(),
    ),
  ).toMatchObject({ kind: "pending_approval" });
  expect(
    await computer.call(
      "exec",
      {
        executable: "sh",
        args: ["-c", "git push; touch ~/x"],
        escape: { justification: "blocked" },
      },
      invocation(),
    ),
  ).toMatchObject({ kind: "pending_approval" });
  allowed = false;
  expect(
    await computer.call(
      "exec",
      {
        executable: "git",
        args: ["push", "-u", "origin", "b"],
        escape: { justification: "rule removed" },
      },
      invocation(),
    ),
  ).toMatchObject({ kind: "pending_approval" });
  expect(decisions).toEqual(["policy", "card", "card", "card"]);
});

function invocation(signal = new AbortController().signal): InvocationContext {
  return { executionId: "local-exec-proof", deadlineAt: null, signal };
}

function shellLiteral(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(path: string, milliseconds = 2_000) {
  const deadline = Date.now() + milliseconds;
  while (!(await exists(path))) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${path}`);
    await delay(10);
  }
}

// These fixtures keep ordinary children in the parent process group. Once it
// is absent, no delayed marker writer remains: completion needs no extra sleep.
async function groupAbsent(parentPath: string) {
  const groupId = Number((await readFile(parentPath, "utf8")).trim());
  try {
    process.kill(-groupId, 0);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") {
      return true;
    }
    throw error;
  }
}

async function call(
  computer: KnapsackComputer,
  input: { command: string; cwd?: string; timeoutMs?: number },
  signal?: AbortSignal,
) {
  return execResultSchema.parse(
    await computer.call("exec", input, invocation(signal)),
  );
}

async function callDirect(
  computer: KnapsackComputer,
  input: {
    executable: string;
    args?: string[];
    stdin?: string;
    cwd?: string;
    timeoutMs?: number;
  },
  signal?: AbortSignal,
) {
  return execResultSchema.parse(
    await computer.call("exec", input, invocation(signal)),
  );
}

async function abortThroughMycelium(
  computer: KnapsackComputer,
  command: string,
  parentPath: string,
  readyPath?: string,
): Promise<number> {
  const runtime = await Mycelium.make({
    sources: [
      Knapsack.computer({
        id: "local-exec",
        name: "computer",
        computer,
      }),
    ],
    sandbox: directSandbox(async (bindings) => {
      const exec = bindings.computer?.exec;
      if (exec === undefined) throw new Error("Computer exec is unavailable");
      return exec({ command });
    }),
  });
  const lease = await runtime.acquire();
  const controller = new AbortController();

  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "local-exec-abort",
        name: "execute",
        arguments: { code: "return computer.exec({})" },
      }),
    );
    const running = Effect.runPromise(Stream.runDrain(prepared.execute()), {
      signal: controller.signal,
    });
    await waitFor(parentPath);
    if (readyPath !== undefined) await waitFor(readyPath);
    const abortedAt = performance.now();
    controller.abort();
    await expect(running).rejects.toBeDefined();
    const elapsed = performance.now() - abortedAt;
    expect(await groupAbsent(parentPath)).toBe(true);
    return elapsed;
  } finally {
    await lease.release();
    await runtime.close();
  }
}

describe("private invocation Computer", () => {
  it("marks sandbox denials without treating ordinary shell failures as denials", () => {
    const result = {
      status: "failed" as const,
      exitCode: 1,
      stdout: "",
      stderr: "fatal: could not lock config file: Device or resource busy",
      truncated: false as const,
    };
    expect(likelySandboxDenied("workspace", result)).toBe(true);
    expect(
      likelySandboxDenied("read-only", { ...result, stderr: "EROFS" }),
    ).toBe(true);
    expect(
      likelySandboxDenied("workspace", {
        ...result,
        stderr: "seccomp blocked",
      }),
    ).toBe(true);
    expect(likelySandboxDenied("workspace", { ...result, exitCode: 2 })).toBe(
      false,
    );
    expect(likelySandboxDenied("workspace", { ...result, exitCode: 126 })).toBe(
      false,
    );
    expect(likelySandboxDenied("workspace", { ...result, exitCode: 127 })).toBe(
      false,
    );
    expect(
      likelySandboxDenied("workspace", { ...result, stderr: "bad syntax" }),
    ).toBe(false);
    expect(likelySandboxDenied("full-access", result)).toBe(false);
  });

  it("reports the live mode and the denial hint on a real command", async () => {
    const root = await temporaryDirectory("computer-denial");
    const computer = await createPrivateInvocationComputer(
      root,
      "/usr/bin:/bin",
      undefined,
      homedir(),
      undefined,
      () => "workspace",
    );
    const result = await call(computer, {
      command: "printf 'sh: operation not permitted\\n' >&2; exit 1",
    });
    expect(result.sandbox).toEqual({
      mode: "workspace",
      likelyDenied: true,
      ranOutsideSandbox: true,
    });
  });

  it("refuses NUL shell input with an actionable error and keeps later exec calls usable", async () => {
    const root = await temporaryDirectory("computer-nul");
    const computer = await createPrivateInvocationComputer(
      root,
      "/usr/bin:/bin",
    );
    let command = "printf hidden-command-text\0";
    const runtime = await Mycelium.make({
      sources: [
        Knapsack.computer({ id: "local-exec-nul", name: "computer", computer }),
      ],
      sandbox: directSandbox(async (bindings) => {
        const exec = bindings.computer?.exec;
        if (exec === undefined) throw new Error("Computer exec is unavailable");
        return exec({ command });
      }),
    });
    const lease = await runtime.acquire();
    const execute = async () => {
      const prepared = await Effect.runPromise(
        lease.executeTool.prepare({
          type: "toolCall",
          id: "local-exec-nul",
          name: "execute",
          arguments: { code: "return computer.exec({})" },
        }),
      );
      return Effect.runPromise(Stream.runCollect(prepared.execute()));
    };
    try {
      const [refused] = await Promise.allSettled([execute()]);
      expect(refused).toMatchObject({
        status: "rejected",
        reason: { _tag: "MuleError", phase: "tool" },
      });
      if (refused.status !== "rejected")
        throw new Error("Expected shell input refusal");
      const diagnostic = z
        .object({ message: z.string() })
        .parse(refused.reason);
      expect(diagnostic.message).toContain("NUL byte");
      expect(diagnostic.message).toContain("double the backslash");
      expect(diagnostic.message).toContain("no process was started");
      expect(diagnostic.message).not.toContain("hidden-command-text");
      command = "printf usable";
      const result = await execute();
      expect(JSON.stringify(result)).toContain("usable");
      const escaped = await call(computer, {
        command: String.raw`printf '%s' '\x00'`,
      });
      expect(escaped.stdout).toBe(String.raw`\x00`);
    } finally {
      await lease.release();
      await runtime.close();
    }
  });

  it("advertises only exec and keeps default and requested cwd inside its root", async () => {
    // Temporary roots may sit behind a symlink (macOS /var -> /private/var).
    // The Computer canonicalizes its root and cwd, so the test uses realpaths.
    const root = await realpath(await temporaryDirectory("computer-cwd"));
    const nested = join(root, "nested");
    const outside = await realpath(
      await temporaryDirectory("computer-outside"),
    );
    await mkdir(nested);
    const computer = await createPrivateInvocationComputer(root);

    await expect(
      computer.getCapabilities(new AbortController().signal),
    ).resolves.toMatchObject([{ id: "exec", name: "exec", kind: "runtime" }]);
    process.env.FUNGI_TEST_HOST_SECRET = "must-not-reach-local-command";
    try {
      await expect(
        call(computer, { command: 'printf %s "$FUNGI_TEST_HOST_SECRET"' }),
      ).resolves.toMatchObject({ status: "completed", stdout: "" });
    } finally {
      delete process.env.FUNGI_TEST_HOST_SECRET;
    }
    await expect(
      call(computer, { command: 'printf %s "$PWD"' }),
    ).resolves.toMatchObject({
      status: "completed",
      exitCode: 0,
      stdout: root,
    });
    await expect(
      call(computer, { command: 'printf %s "$PWD"', cwd: nested }),
    ).resolves.toMatchObject({ stdout: nested });
    await expect(
      call(computer, { command: "printf unavailable", cwd: outside }),
    ).rejects.toThrow("outside the invocation root");
    await expect(
      computer.call(
        "exec",
        { command: "printf ignored", extra: true },
        invocation(),
      ),
    ).rejects.toBeDefined();
    await expect(
      computer.call("not_exec", { command: "printf ignored" }, invocation()),
    ).rejects.toThrow("Computer capability is unavailable");
  });

  it("tells the model that nohup does not survive the exec call", async () => {
    const computer = await createPrivateInvocationComputer(
      await temporaryDirectory("computer-nohup-doc"),
    );
    const [capability] = z
      .array(z.record(z.string(), z.unknown()))
      .parse(await computer.getCapabilities(new AbortController().signal));
    expect(capability?.description).toContain(
      "exec kills its group at call end; nohup/& die.",
    );
  });

  it("advertises a bounded command timeout that leaves headroom under the sandbox deadline", async () => {
    const computer = await createPrivateInvocationComputer(
      await temporaryDirectory("computer-timeout-schema"),
    );
    const [capability] = z
      .array(z.record(z.string(), z.unknown()))
      .parse(await computer.getCapabilities(new AbortController().signal));
    const advertised = JSON.stringify(capability);
    expect(advertised).toContain('"default":180000');
    // The per-command ceiling sits below the 900000 ms invocation deadline by
    // a real margin (120000 ms), not right up against it: the old 840000 ms
    // ceiling left only 60000 ms for setup and teardown, which is what made a
    // legitimate near-max command one retry away from a generic rejection.
    expect(advertised).toContain("780000 ms");
    expect(advertised).toContain("900000 ms");
    await expect(
      call(computer, { command: "printf ready", timeoutMs: 31_000 }),
    ).resolves.toMatchObject({ status: "completed", stdout: "ready" });
  });

  it("clamps a requested timeout above the safe ceiling instead of rejecting it", async () => {
    const computer = await createPrivateInvocationComputer(
      await temporaryDirectory("computer-timeout-clamp"),
    );
    // A command that finishes well inside the clamped ceiling still
    // succeeds: the clamp only reduces the budget, it never refuses the call.
    await expect(
      call(computer, { command: "printf ready", timeoutMs: 840_001 }),
    ).resolves.toMatchObject({ status: "completed", stdout: "ready" });
  });

  it("names the clamp and the command in a clamped command's timeout message", async () => {
    // A real clamp always runs at the 780000 ms ceiling, far too long for a
    // unit test to wait out. runPrivateInvocationProcess takes the effective
    // timeoutMs and the originally requested one as separate arguments, so
    // this exercises the exact message-building logic at a fast, explicit
    // 20 ms timeout while still reporting (correctly) that it was clamped
    // down from a much larger request.
    const command = ChildProcess.make("sh", [
      "-c",
      "while :; do sleep 1; done",
    ]);
    const result = await runPrivateInvocationProcess(
      command,
      new AbortController().signal,
      20,
      {
        requestedMs: 840_001,
        describeCommand: () => "while :; do sleep 1; done",
      },
    );
    expect(result.status).toBe("deadline_exceeded");
    if (result.status !== "deadline_exceeded")
      throw new Error("Expected a command timeout");
    expect(result.message).toContain("timeoutMs=20 ms");
    expect(result.message).toContain("clamped from the requested 840001 ms");
    expect(result.message).toContain("780000 ms");
    expect(result.message).toContain("900000 ms");
    expect(result.message).toContain("while :; do sleep 1; done");
  });

  it("returns bounded stdout and stderr for completed and failed shell commands", async () => {
    const computer = await createPrivateInvocationComputer(
      await temporaryDirectory("computer-output"),
    );
    const started = performance.now();
    await expect(
      call(computer, {
        command: "printf stdout; printf stderr >&2; exit 7",
      }),
    ).resolves.toEqual({
      status: "failed",
      exitCode: 7,
      stdout: "stdout",
      stderr: "stderr",
      truncated: false,
      sandbox: {
        mode: "full-access",
        likelyDenied: false,
        ranOutsideSandbox: true,
      },
    });
    expect(performance.now() - started).toBeLessThan(900);
    const truncated = await call(computer, {
      command: "head -c 70000 /dev/zero | tr '\\0' x",
    });
    expect(truncated.status).toBe("completed");
    expect(truncated.stdout).toMatch(
      /^x+\n\[fungi: stdout truncated: [\d.]+ KiB of 68\.4 KiB shown; redirect to a file or use head\/tail\]$/u,
    );
    expect(Buffer.byteLength(truncated.stdout)).toBeLessThanOrEqual(64 * 1024);
    expect(truncated.stderr).toBe("");
    expect(truncated.truncated).toEqual([
      { stream: "stdout", keptBytes: 64 * 1024 - 256, totalBytes: 70000 },
    ]);
  });

  it("says when stderr is cut and keeps stdout whole", async () => {
    const computer = await createPrivateInvocationComputer(
      await temporaryDirectory("computer-stderr-cut"),
    );
    const result = await call(computer, {
      command: "printf ok; head -c 900000 /dev/zero | tr '\\0' e >&2",
    });
    expect(result.stdout).toBe("ok");
    expect(result.stderr).toMatch(
      /\n\[fungi: stderr truncated: [\d.]+ KiB of 878\.9 KiB shown; redirect to a file or use head\/tail\]$/u,
    );
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(64 * 1024);
    expect(result.truncated).toEqual([
      { stream: "stderr", keptBytes: 64 * 1024 - 256, totalBytes: 900000 },
    ]);
  });

  it("documents the stream cap in the exec tool description", async () => {
    const computer = await createPrivateInvocationComputer(
      await temporaryDirectory("computer-description"),
    );
    const [capability] = z
      .array(z.record(z.string(), z.unknown()))
      .parse(await computer.getCapabilities(new AbortController().signal));
    expect(capability?.description).toContain("64 KiB");
    expect(capability?.description).toContain("head/tail");
  });

  it("expands tilde and HOME consistently in the restricted Computer shell", async () => {
    const computer = await createPrivateInvocationComputer(
      await temporaryDirectory("computer-home"),
    );
    const home = process.env.HOME ?? homedir();
    await expect(
      call(computer, {
        command: `printf '%s|%s' ~/bin/heavy "$HOME/bin/heavy"`,
      }),
    ).resolves.toMatchObject({
      status: "completed",
      stdout: `${home}/bin/heavy|${home}/bin/heavy`,
    });
  });

  it("lets a project Git hook use the selected client's pnpm PATH", async () => {
    const root = await temporaryDirectory("computer-hook-path");
    const repo = join(root, "repo");
    const remote = join(root, "remote.git");
    const toolchain = join(root, "toolchain");
    await mkdir(repo);
    await mkdir(toolchain);
    await execFile("git", ["init", "-q", "--bare", remote]);
    await execFile("git", ["init", "-q", repo]);
    await writeFile(join(repo, "file.txt"), "fixture\n");
    await execFile("git", ["-C", repo, "add", "file.txt"]);
    await execFile("git", [
      "-C",
      repo,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture",
    ]);
    await execFile("git", ["-C", repo, "remote", "add", "origin", remote]);
    const hook = join(repo, ".git", "hooks", "pre-push");
    await writeFile(hook, "#!/bin/sh\npnpm --version\n");
    await chmod(hook, 0o755);
    const pnpm = join(toolchain, "pnpm");
    await writeFile(pnpm, "#!/bin/sh\nprintf fixture-pnpm\n");
    await chmod(pnpm, 0o755);

    const servicePath = await createPrivateInvocationComputer(
      root,
      "/usr/bin:/bin",
    );
    const denied = await call(servicePath, {
      command: "git push origin HEAD",
      cwd: repo,
    });
    expect(denied).toMatchObject({ status: "failed" });
    expect(denied.stderr).toContain("pnpm: not found");

    const clientPath = await createPrivateInvocationComputer(
      root,
      `${toolchain}:/usr/bin:/bin`,
    );
    const accepted = await call(clientPath, {
      command: "git push origin HEAD",
      cwd: repo,
    });
    expect(accepted).toMatchObject({ status: "completed", exitCode: 0 });
    expect(accepted.stdout).toContain("fixture-pnpm");
  });

  it("does not acquire a command for an already-aborted invocation", async () => {
    const root = await temporaryDirectory("computer-pre-abort");
    const marker = join(root, "marker");
    const computer = await createPrivateInvocationComputer(root);

    await expect(
      call(
        computer,
        { command: `: > ${shellLiteral(marker)}` },
        AbortSignal.abort(),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(await exists(marker)).toBe(false);
  });

  it("settles command timeout only after ordinary-child cleanup", async () => {
    const root = await temporaryDirectory("computer-timeout");
    const marker = join(root, "marker");
    const parent = join(root, "parent");
    const computer = await createPrivateInvocationComputer(root);
    const result = await call(computer, {
      command: `printf %s "$$" > ${shellLiteral(parent)}; (sleep 5; : > ${shellLiteral(marker)}) & while :; do sleep 1; done`,
      timeoutMs: 20,
    });

    expect(result).toMatchObject({
      status: "deadline_exceeded",
      exitCode: -1,
    });
    expect(result.message).toContain("timeoutMs");
    expect(await groupAbsent(parent)).toBe(true);
    expect(await exists(marker)).toBe(false);
  }, 10_000);

  it("cleans a child when the command fails after process acquisition", async () => {
    const root = await temporaryDirectory("computer-early-failure");
    const marker = join(root, "marker");
    const parent = join(root, "parent");
    const computer = await createPrivateInvocationComputer(root);

    await expect(
      call(computer, {
        command: `printf %s "$$" > ${shellLiteral(parent)}; (sleep 5; : > ${shellLiteral(marker)}) & kill -KILL $$`,
      }),
    ).rejects.toBeDefined();
    expect(await groupAbsent(parent)).toBe(true);
    expect(await exists(marker)).toBe(false);
  }, 10_000);

  it("forwards Mycelium abort to a held command and its ordinary child", async () => {
    const root = await temporaryDirectory("computer-ordinary-child");
    const marker = join(root, "marker");
    const parent = join(root, "parent");
    const computer = await createPrivateInvocationComputer(root);

    await abortThroughMycelium(
      computer,
      `printf %s "$$" > ${shellLiteral(parent)}; (sleep 5; : > ${shellLiteral(marker)}) & while :; do sleep 1; done`,
      parent,
    );
    expect(await exists(marker)).toBe(false);
  }, 10_000);

  it("escalates an all-TERM-resistant owned process group through Mycelium", async () => {
    const root = await temporaryDirectory("computer-term-resistant");
    const marker = join(root, "marker");
    const parent = join(root, "parent");
    const computer = await createPrivateInvocationComputer(root);

    const elapsed = await abortThroughMycelium(
      computer,
      `trap '' TERM; printf %s "$$" > ${shellLiteral(parent)}; (sleep 5; : > ${shellLiteral(marker)}) & while :; do sleep 1; done`,
      parent,
    );
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(4_000);
    expect(await exists(marker)).toBe(false);
  }, 10_000);

  it("escalates after the leader exits while its same-group child ignores TERM", async () => {
    const root = await temporaryDirectory("computer-leader-exits");
    const marker = join(root, "marker");
    const parent = join(root, "parent");
    const ready = join(root, "ready");
    const computer = await createPrivateInvocationComputer(root);

    await abortThroughMycelium(
      computer,
      `trap 'exit 0' TERM; printf %s "$$" > ${shellLiteral(parent)}; (trap '' TERM; : > ${shellLiteral(ready)}; sleep 5; : > ${shellLiteral(marker)}) & while :; do sleep 1; done`,
      parent,
      ready,
    );
    expect(await exists(marker)).toBe(false);
  }, 10_000);

  describe("direct form (executable/args/stdin)", () => {
    it("does not acquire a process for an already-aborted invocation", async () => {
      const root = await temporaryDirectory("computer-direct-pre-abort");
      const marker = join(root, "marker");
      const computer = await createPrivateInvocationComputer(root);

      await expect(
        callDirect(
          computer,
          { executable: "touch", args: [marker] },
          AbortSignal.abort(),
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(await exists(marker)).toBe(false);
    });

    it("an omitted stdin is immediate EOF, not an open pipe", async () => {
      const root = await temporaryDirectory("computer-direct-omitted-stdin");
      const computer = await createPrivateInvocationComputer(root);
      const startedAt = performance.now();
      await expect(
        callDirect(computer, { executable: "cat", timeoutMs: 20_000 }),
      ).resolves.toMatchObject({
        status: "completed",
        exitCode: 0,
        stdout: "",
      });
      // `cat` with no input blocks on stdin until it sees EOF. Finishing far
      // under the 20 s timeoutMs is itself part of the proof: before the
      // fix, Effect's default open "pipe" left this hanging to the deadline.
      expect(performance.now() - startedAt).toBeLessThan(2_000);
    });

    it("refuses a cwd outside the root, including through a symlink", async () => {
      const root = await realpath(
        await temporaryDirectory("computer-direct-cwd"),
      );
      const outside = await realpath(
        await temporaryDirectory("computer-direct-cwd-outside"),
      );
      const nested = join(root, "nested");
      await mkdir(nested);
      const escape = join(root, "escape");
      await symlink(outside, escape);
      const computer = await createPrivateInvocationComputer(root);

      await expect(
        callDirect(computer, { executable: "true", cwd: outside }),
      ).rejects.toThrow("outside the invocation root");
      await expect(
        callDirect(computer, { executable: "true", cwd: escape }),
      ).rejects.toThrow("outside the invocation root");
      await expect(
        callDirect(computer, { executable: "true", cwd: nested }),
      ).resolves.toMatchObject({ status: "completed" });
    });

    it("defaults to PATH, HOME and the user session locators, keeps the selected client PATH, and never leaks a host secret", async () => {
      const root = await temporaryDirectory("computer-direct-env");
      const toolchain = join(root, "toolchain");
      await mkdir(toolchain);
      const fakeTool = join(toolchain, "fungi-direct-fake-tool");
      await writeFile(fakeTool, "#!/bin/sh\nprintf fixture-fake-tool\n");
      await chmod(fakeTool, 0o755);
      const computer = await createPrivateInvocationComputer(
        root,
        `${toolchain}:/usr/bin:/bin`,
      );
      process.env.FUNGI_TEST_HOST_SECRET = "must-not-reach-direct-exec";
      try {
        // `env` with no args prints exactly its own received environment,
        // one NAME=value per line, with no interpreter-added variables.
        // python3 is not used for this assertion: CPython's own locale
        // coercion (PEP 538/540) adds an LC_CTYPE it was never given, which
        // would make an exact-set assertion fail for a reason that has
        // nothing to do with this Computer's env restriction.
        const envLines = await callDirect(computer, { executable: "env" });
        expect(envLines.status).toBe("completed");
        const names = envLines.stdout
          .split("\n")
          .filter((line) => line.length > 0)
          .map((line) => line.slice(0, line.indexOf("=")))
          .sort();
        expect(names).toEqual(
          [
            "HOME",
            "PATH",
            ...(process.env.XDG_RUNTIME_DIR ? ["XDG_RUNTIME_DIR"] : []),
            ...(process.env.DBUS_SESSION_BUS_ADDRESS
              ? ["DBUS_SESSION_BUS_ADDRESS"]
              : []),
          ].sort(),
        );
        expect(envLines.stdout).toContain(`PATH=${toolchain}:/usr/bin:/bin`);
        expect(envLines.stdout).not.toContain("must-not-reach-direct-exec");
        // The direct form resolves a bare executable name through the same
        // selected-client PATH it hands the child, not merely through
        // Node's own ambient PATH.
        await expect(
          callDirect(computer, { executable: "fungi-direct-fake-tool" }),
        ).resolves.toMatchObject({
          status: "completed",
          stdout: "fixture-fake-tool",
        });
      } finally {
        delete process.env.FUNGI_TEST_HOST_SECRET;
      }
    });

    it("tears down a TERM-resistant descendant in the direct form's own group on deadline", async () => {
      const root = await temporaryDirectory("computer-direct-deadline");
      const parent = join(root, "parent");
      const marker = join(root, "marker");
      const computer = await createPrivateInvocationComputer(root);
      // The marker path reaches the grandchild as its own argv[1], not
      // embedded inside the grandchild's `-c` string, so neither path ever
      // nests inside another string literal in this generated script.
      const script = [
        "import os, signal, subprocess, sys, time",
        "signal.signal(signal.SIGTERM, signal.SIG_IGN)",
        `open(${JSON.stringify(parent)}, "w").write(str(os.getpid()))`,
        `subprocess.Popen([sys.executable, "-c", "import sys, time; time.sleep(5); open(sys.argv[1], 'w').close()", ${JSON.stringify(marker)}])`,
        "while True:",
        "    time.sleep(1)",
      ].join("\n");

      const result = await callDirect(computer, {
        executable: "python3",
        args: ["-"],
        stdin: script,
        timeoutMs: 2_500,
      });
      expect(result.status).toBe("deadline_exceeded");
      await waitFor(parent);
      expect(await groupAbsent(parent)).toBe(true);
      expect(await exists(marker)).toBe(false);
    }, 15_000);
  });
});
