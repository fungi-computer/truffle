import { directSandbox } from "@fungi.computer/mycelium/testing";
import {
  access,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { scaledBudgetMs } from "../../../tooling/repository/scripts/proof-budget.mjs";

import { Knapsack, type KnapsackComputer } from "@fungi.computer/knapsack";
import {
  Mycelium,
  type InvocationContext,
  type ModuleRegistration,
  type MyceliumJsonValue,
} from "@fungi.computer/mycelium";
import { createPrivateInvocationComputer } from "../src/private-invocation-computer.js";
import {
  createPrivateLocalComputerProcesses,
  type PrivateLocalComputerProcesses,
} from "../src/private-local-computer-processes.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(label: string) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), `fungi-local-processes-${label}-`)),
  );
  const processes = createPrivateLocalComputerProcesses(root);
  cleanups.push(async () => {
    await processes.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, processes };
}

async function computerFor(
  root: string,
  processes: PrivateLocalComputerProcesses,
  scope = "session-a",
) {
  return createPrivateInvocationComputer(
    root,
    "/usr/bin:/bin",
    processes.scope(scope),
  );
}

function invocation(): InvocationContext {
  return {
    executionId: "local-process-proof",
    deadlineAt: null,
    signal: new AbortController().signal,
  };
}

const processSchema = z.looseObject({
  id: z.string(),
  state: z.enum(["running", "exited"]),
  exitCode: z.number().int().nullable(),
  logPath: z.string(),
  logBytes: z.number().int(),
});
const waitSchema = z.looseObject({
  process: processSchema,
  timedOut: z.boolean(),
});
const readSchema = z.looseObject({
  text: z.string(),
  nextOffset: z.number().int(),
  complete: z.boolean(),
});
const killSchema = z.looseObject({
  process: processSchema,
  signalled: z.boolean(),
});

async function start(computer: KnapsackComputer, command: string) {
  return z
    .object({ process: processSchema })
    .parse(
      await computer.call(
        "exec",
        { operation: "start", command },
        invocation(),
      ),
    ).process;
}

function groupAlive(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Poll a process's log for the process-group id its shell printed first. */
async function printedGroup(computer: KnapsackComputer, id: string) {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const read = readSchema.parse(
      await computer.call("exec", { operation: "poll", id }, invocation()),
    );
    const groupId = Number(read.text.split("\n")[0]);
    if (
      read.text.includes("\n") &&
      Number.isSafeInteger(groupId) &&
      groupId > 1
    )
      return groupId;
    if (Date.now() >= deadline) throw new Error("No process group printed");
    await delay(20);
  }
}

/** Run one `execute` tool call over these modules, the way an agent does. */
async function execute(
  modules: readonly ModuleRegistration[],
  sources: NonNullable<Parameters<typeof Mycelium.make>[0]["sources"]>,
  body: (
    call: (
      operation: string,
      input: MyceliumJsonValue,
    ) => Promise<MyceliumJsonValue>,
  ) => Promise<MyceliumJsonValue>,
): Promise<MyceliumJsonValue> {
  let output: MyceliumJsonValue = null;
  const runtime = await Mycelium.make({
    sources,
    modules,
    sandbox: directSandbox(async (bindings) => {
      const computer = bindings.computer;
      if (computer === undefined) throw new Error("Computer is unavailable");
      output = await body(async (operation, input) => {
        const selected = computer[operation];
        if (selected === undefined)
          throw new Error(`Computer ${operation} is unavailable`);
        return await selected(input);
      });
      return null;
    }),
  });
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "local-process-call",
        name: "execute",
        arguments: { code: "return null" },
      }),
    );
    await Effect.runPromise(Stream.runDrain(prepared.execute()));
  } finally {
    await lease.release();
    await runtime.close();
  }
  return output;
}

describe("local Computer background processes", () => {
  it("refuses NUL start input before allocating a background process", async () => {
    const { root, processes } = await fixture("nul-start");
    const computer = await computerFor(root, processes);
    await expect(
      start(computer, "printf hidden-command-text\0"),
    ).rejects.toMatchObject({
      _tag: "CapabilityFailed",
      cause: {
        kind: "InvalidInput",
        message:
          "Computer exec command or argument contains a NUL byte. Remove it or double the backslash in JavaScript escapes (for example, \\\\x00); no process was started.",
      },
    });
    expect(processes.scope("session-a").list()).toEqual([]);
  });

  it("exec starts immediately, bounds waits and preserves the output and failure across calls", async () => {
    const { root, processes } = await fixture("exec-background");
    const computer = await computerFor(root, processes);
    const call = (input: MyceliumJsonValue, signal = invocation().signal) =>
      computer.call("exec", input, {
        executionId: "background",
        deadlineAt: null,
        signal,
      });
    const resultSchema = z.looseObject({
      process: processSchema,
      text: z.string(),
      timedOut: z.boolean(),
    });
    const started = resultSchema.parse(
      await call({
        operation: "start",
        command:
          "printf ready; while [ ! -f finish ]; do sleep 0.01; done; printf done >&2; exit 7",
      }),
    );
    expect(started.process.state).toBe("running");
    await expect(call({ command: "printf available" })).resolves.toMatchObject({
      stdout: "available",
    });
    const early = resultSchema.parse(
      await call({ operation: "wait", id: started.process.id, timeoutMs: 25 }),
    );
    expect(early).toMatchObject({
      timedOut: true,
      process: { state: "running", exitCode: null },
    });
    const abort = new AbortController();
    const waiting = call(
      { operation: "wait", id: started.process.id, timeoutMs: 60_000 },
      abort.signal,
    );
    abort.abort();
    await expect(waiting).rejects.toBeDefined();
    await expect(
      call({ operation: "poll", id: started.process.id }),
    ).resolves.toMatchObject({ process: { state: "running" } });
    await expect(
      call({ operation: "wait", id: started.process.id, timeoutMs: 300_000 }),
    ).rejects.toBeDefined();
    await writeFile(join(root, "finish"), "");
    await expect(
      call({ operation: "wait", id: started.process.id, timeoutMs: 3_000 }),
    ).resolves.toMatchObject({
      timedOut: false,
      process: { state: "exited", exitCode: 7 },
      text: "readydone",
      complete: true,
    });
    await expect(
      call({ operation: "poll", id: started.process.id }),
    ).resolves.toMatchObject({ process: { exitCode: 7 }, text: "readydone" });
  });

  it("starts a direct executable+args background process with stdin, no shell, and reads its exit", async () => {
    const { root, processes } = await fixture("exec-background-direct");
    const computer = await computerFor(root, processes);
    const call = (input: MyceliumJsonValue) =>
      computer.call("exec", input, invocation());
    const resultSchema = z.looseObject({
      process: processSchema,
      text: z.string(),
      timedOut: z.boolean(),
    });
    const started = resultSchema.parse(
      await call({
        operation: "start",
        executable: "python3",
        args: [
          "-c",
          "import sys; d = sys.stdin.buffer.read(); sys.stdout.buffer.write(d); sys.exit(3)",
        ],
        stdin: "direct-background-stdin-$(whoami)-é",
      }),
    );
    expect(started.process.state).toBe("running");
    const finished = resultSchema.parse(
      await call({
        operation: "wait",
        id: started.process.id,
        timeoutMs: 5_000,
      }),
    );
    expect(finished).toMatchObject({
      timedOut: false,
      process: { state: "exited", exitCode: 3 },
      text: "direct-background-stdin-$(whoami)-é",
      complete: true,
    });
  });

  it("repeated background children that exit before draining a large stdin (EPIPE) never crash the host", async () => {
    const { root, processes } = await fixture("exec-background-epipe-loop");
    const computer = await computerFor(root, processes);
    const call = (input: MyceliumJsonValue) =>
      computer.call("exec", input, invocation());
    const resultSchema = z.looseObject({
      process: processSchema,
      timedOut: z.boolean(),
    });
    // Writing more than one pipe buffer's worth (the Linux default is 64
    // KiB) makes the write hit EPIPE once the child is gone and nothing
    // drains it. A single start is probabilistic: one write can land before
    // the child exits and never EPIPE at all. The real shape-review probe
    // found an uncaught EPIPE killed the host within 20 iterations for
    // either executable, so loop both that many times; reaching the final
    // assertion for all of them is itself part of the proof.
    const stdin = "x".repeat(128 * 1_024);
    for (const spec of [
      { executable: "true", args: [] },
      { executable: "head", args: ["-c1"] },
    ]) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const started = resultSchema.parse(
          await call({ operation: "start", stdin, ...spec }),
        );
        expect(started.process.state).toBe("running");
        const finished = resultSchema.parse(
          await call({
            operation: "wait",
            id: started.process.id,
            timeoutMs: 5_000,
          }),
        );
        expect(finished).toMatchObject({
          timedOut: false,
          process: { state: "exited", exitCode: 0 },
        });
      }
    }
  }, 30_000);

  it("cancelling a background direct-form wait leaves the job alive; kill then stops it", async () => {
    const { root, processes } = await fixture("exec-background-direct-cancel");
    const computer = await computerFor(root, processes);
    const call = (input: MyceliumJsonValue, signal = invocation().signal) =>
      computer.call("exec", input, {
        executionId: "background-direct-cancel",
        deadlineAt: null,
        signal,
      });
    const resultSchema = z.looseObject({ process: processSchema });
    const started = resultSchema.parse(
      await call({ operation: "start", executable: "sleep", args: ["5"] }),
    );
    expect(started.process.state).toBe("running");
    const abort = new AbortController();
    const waiting = call(
      { operation: "wait", id: started.process.id, timeoutMs: 60_000 },
      abort.signal,
    );
    abort.abort();
    await expect(waiting).rejects.toBeDefined();
    await expect(
      call({ operation: "poll", id: started.process.id }),
    ).resolves.toMatchObject({ process: { state: "running" } });
    const killed = z
      .looseObject({ process: processSchema, signalled: z.boolean() })
      .parse(await call({ operation: "kill", id: started.process.id }));
    expect(killed).toMatchObject({
      signalled: true,
      process: { state: "exited" },
    });
  });

  it("refuses both command and executable, and neither, for background start", async () => {
    const { root, processes } = await fixture("exec-background-mutex");
    const computer = await computerFor(root, processes);
    await expect(
      computer.call(
        "exec",
        { operation: "start", command: "printf a", executable: "python3" },
        invocation(),
      ),
    ).rejects.toMatchObject({ name: "ZodError" });
    await expect(
      computer.call("exec", { operation: "start" }, invocation()),
    ).rejects.toMatchObject({ name: "ZodError" });
    expect(processes.scope("session-a").list()).toEqual([]);
  });

  it("returns the latest bounded tail after log eviction and resumes UTF-8 output", async () => {
    const { root, processes } = await fixture("tail");
    const computer = await computerFor(root, processes);
    const started = await start(
      computer,
      "head -c 8388610 /dev/zero | tr '\\0' x; printf 'éEND'",
    );
    const result = await computer.call(
      "exec",
      {
        operation: "wait",
        id: started.id,
        timeoutMs: 10_000,
        maxBytes: 8,
      },
      invocation(),
    );
    expect(result).toMatchObject({
      text: "xxxéEND",
      complete: true,
      process: { exitCode: 0, logTruncated: true, logStartOffset: 7 },
    });
    expect((await stat(started.logPath)).size).toBe(8 * 1_024 * 1_024);
    const evicted = await computer.call(
      "exec",
      {
        operation: "poll",
        id: started.id,
        offset: 0,
        maxBytes: 4,
      },
      invocation(),
    );
    expect(evicted).toMatchObject({ offset: 7, nextOffset: 11, text: "xxxx" });
    const split = readSchema.parse(
      await computer.call(
        "exec",
        {
          operation: "poll",
          id: started.id,
          offset: 8_388_609,
          maxBytes: 2,
        },
        invocation(),
      ),
    );
    expect(split).toMatchObject({ text: "x", nextOffset: 8_388_610 });
    await expect(
      computer.call(
        "exec",
        {
          operation: "poll",
          id: started.id,
          offset: split.nextOffset,
          maxBytes: 8,
        },
        invocation(),
      ),
    ).resolves.toMatchObject({ text: "éEND", complete: true });
    const binary = await start(computer, "printf '\\377\\302'");
    await expect(
      computer.call(
        "exec",
        {
          operation: "wait",
          id: binary.id,
          timeoutMs: 3_000,
        },
        invocation(),
      ),
    ).resolves.toMatchObject({ text: "\uFFFD\uFFFD", complete: true });
  });

  it("starts a command, waits for it, and reads its log", async () => {
    const { root, processes } = await fixture("wait-read");
    const computer = await computerFor(root, processes);
    const advertised = JSON.stringify(
      await computer.getCapabilities(new AbortController().signal),
    );
    expect(advertised).toContain('operation:\\"start\\"');

    const started = await start(computer, "sleep 5 && echo done");
    expect(started.state).toBe("running");
    expect(started.logPath).toBe(
      join(root, ".fungi", "processes", `${started.id}.log`),
    );

    const early = waitSchema.parse(
      await computer.call(
        "exec",
        { operation: "wait", id: started.id, timeoutMs: 200 },
        invocation(),
      ),
    );
    expect(early).toMatchObject({
      timedOut: true,
      process: { state: "running" },
    });

    const finished = waitSchema.parse(
      await computer.call(
        "exec",
        { operation: "wait", id: started.id, timeoutMs: 10_000 },
        invocation(),
      ),
    );
    expect(finished).toMatchObject({
      timedOut: false,
      process: { state: "exited", exitCode: 0 },
    });
    // Waiting again on an exited process returns at once.
    await expect(
      computer.call(
        "exec",
        { operation: "wait", id: started.id },
        invocation(),
      ),
    ).resolves.toMatchObject({ timedOut: false });

    const read = readSchema.parse(
      await computer.call(
        "exec",
        { operation: "poll", id: started.id },
        invocation(),
      ),
    );
    expect(read).toMatchObject({
      text: "done\n",
      nextOffset: 5,
      complete: true,
    });
    expect(await readFile(started.logPath, "utf8")).toBe("done\n");
    await expect(
      computer.call(
        "exec",
        { operation: "wait", id: started.id, timeoutMs: 60_001 },
        invocation(),
      ),
    ).rejects.toBeDefined();
  }, 15_000);

  it("keeps a process running across two execute calls", async () => {
    const { root, processes } = await fixture("across-calls");
    const computer = await computerFor(root, processes);
    const sources = [
      Knapsack.computer({ id: "local-computer", name: "computer", computer }),
    ];
    const started = z.object({ process: processSchema }).parse(
      await execute([], sources, (bound) =>
        bound("exec", {
          operation: "start",
          command: "sleep 1; echo survived",
        }),
      ),
    ).process;
    // The first execute call and its scope are gone; the process is not.
    await expect(
      computer.call(
        "exec",
        { operation: "poll", id: started.id },
        invocation(),
      ),
    ).resolves.toMatchObject({ process: { state: "running" } });
    const waited = waitSchema.parse(
      await execute([], sources, (bound) =>
        bound("exec", { operation: "wait", id: started.id, timeoutMs: 10_000 }),
      ),
    );
    expect(waited.process).toMatchObject({ state: "exited", exitCode: 0 });
    const read = readSchema.parse(
      await execute([], sources, (bound) =>
        bound("exec", { operation: "poll", id: started.id }),
      ),
    );
    expect(read.text).toBe("survived\n");
  }, 15_000);

  it("stops a process and everything it started", async () => {
    const { root, processes } = await fixture("kill");
    const computer = await computerFor(root, processes);
    const marker = join(root, "marker");
    const started = await start(
      computer,
      `trap '' TERM; (sleep 4; : > ${marker}) & echo $$; while :; do sleep 1; done`,
    );
    const groupId = await printedGroup(computer, started.id);
    expect(groupAlive(groupId)).toBe(true);

    const killed = killSchema.parse(
      await computer.call(
        "exec",
        { operation: "kill", id: started.id },
        invocation(),
      ),
    );
    expect(killed).toMatchObject({
      signalled: true,
      process: { state: "exited" },
    });
    await expect
      .poll(() => groupAlive(groupId), {
        message: "stopped process group exits",
        timeout: scaledBudgetMs(3_000),
        interval: 250,
      })
      .toBe(false);
    await expect(
      computer.call(
        "exec",
        { operation: "kill", id: started.id },
        invocation(),
      ),
    ).resolves.toMatchObject({ signalled: false });
    await delay(4_200);
    expect(await exists(marker)).toBe(false);
  }, 15_000);

  it("cleans a Session's processes and logs up when the Session ends", async () => {
    const { root, processes } = await fixture("session-end");
    const sessionA = await computerFor(root, processes, "session-a");
    const sessionB = await computerFor(root, processes, "session-b");
    const owned = await start(sessionA, "echo $$; sleep 60");
    const other = await start(sessionB, "sleep 60");
    const groupId = await printedGroup(sessionA, owned.id);

    // Another Session cannot see, wait for or stop this one's process.
    for (const operation of ["poll", "wait", "kill"])
      await expect(
        sessionB.call("exec", { operation, id: owned.id }, invocation()),
      ).rejects.toThrow("Computer process not found");

    await processes.disposeScope("session-a");
    expect(groupAlive(groupId)).toBe(false);
    expect(await exists(owned.logPath)).toBe(false);
    await expect(
      sessionA.call("exec", { operation: "poll", id: owned.id }, invocation()),
    ).rejects.toThrow("Computer process not found");
    await expect(
      sessionB.call("exec", { operation: "poll", id: other.id }, invocation()),
    ).resolves.toMatchObject({ process: { state: "running" } });

    await processes.close();
    await expect(start(sessionB, "true")).rejects.toThrow("closed");
    expect(await exists(other.logPath)).toBe(false);
  }, 15_000);

  it("enforces the per-Session running cap", async () => {
    const { root, processes } = await fixture("cap");
    const computer = await computerFor(root, processes);
    const started = [];
    for (let index = 0; index < 8; index += 1)
      started.push(await start(computer, "sleep 60"));
    await expect(start(computer, "sleep 60")).rejects.toThrow(
      "at most 8 background processes",
    );
    const [first] = started;
    if (first === undefined) throw new Error("No process started");
    await computer.call(
      "exec",
      { operation: "kill", id: first.id },
      invocation(),
    );
    await expect(start(computer, "true")).resolves.toMatchObject({
      state: "running",
    });
  }, 30_000);

  it("refuses every process operation behind the Computer's tool gate", async () => {
    const { root, processes } = await fixture("gate");
    const computer = await computerFor(root, processes);
    const acquired = await Knapsack.computer({
      id: "local-computer",
      name: "computer",
      computer,
    }).acquire({
      signal: new AbortController().signal,
      invalidate: () => undefined,
    });
    const operations: string[] = [];
    const gated = acquired.snapshot.modules.map((module) =>
      Mycelium.gate(module, ({ operation }) => {
        operations.push(operation);
        return { kind: "refuse", value: { refused: operation } };
      }),
    );
    try {
      for (const operation of ["start", "poll", "wait", "kill", "list"]) {
        const output = await execute(gated, [], (bound) =>
          bound("exec", { operation, command: "sleep 60" }),
        );
        expect(output).toEqual({ refused: "exec" });
      }
      expect(operations).toEqual(Array(5).fill("exec"));
      expect(processes.scope("session-a").list()).toEqual([]);
    } finally {
      await acquired.release();
    }
  });
});
