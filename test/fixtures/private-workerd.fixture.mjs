import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import process from "node:process";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach } from "vitest";
import { z } from "zod";
import { Mycelium } from "@fungi.computer/mycelium";

export const openRuntimes = new Set();
// Mycelium's execution deadline starts before the Sandbox bundles the guest
// and boots a private workerd process, so a deadline that must fire only after
// guest callbacks are admitted has to cover that process start-up. That is a
// real I/O bound: a saturated host takes seconds to spawn workerd. Tests
// that wait on it also inspect the owned process tree and tear workerd down,
// so their Vitest bound adds room for that I/O beyond the deadline itself.
export const WORKERD_ADMISSION_BUDGET_MS = 5_000;
export const WORKERD_TEST_TIMEOUT_MS = WORKERD_ADMISSION_BUDGET_MS + 20_000;
const executionResultSchema = z.tuple([
  z.object({
    type: z.literal("result"),
    result: z.object({
      content: z.tuple([
        z.object({ type: z.literal("text"), text: z.string() }),
      ]),
    }),
  }),
]);

export function settledBeforeAdmission(cause) {
  const message = "Execution settled before its guest callbacks were admitted";
  throw new Error(message, { cause });
}

export function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export async function execute(lease, code, signal) {
  const parts = [];
  await observeExecution(lease, code, parts, signal);
  return parseExecutionResult(parts);
}

export async function observeExecution(lease, code, parts, signal) {
  const prepared = await Effect.runPromise(
    lease.executeTool.prepare({
      type: "toolCall",
      id: "local-workerd-proof",
      name: "execute",
      arguments: { code },
    }),
  );
  await Effect.runPromise(
    Stream.runForEach(prepared.execute(), (part) =>
      Effect.sync(() => parts.push(part)),
    ),
    signal === undefined ? undefined : { signal },
  );
}

function parseExecutionResult(parts) {
  const [part] = executionResultSchema.parse(
    parts.filter((value) => value.type === "result"),
  );
  const [content] = part.result.content;
  return JSON.parse(content.text);
}

export async function openRuntime(options) {
  const runtime = await Mycelium.make(options);
  openRuntimes.add(runtime);
  return runtime;
}

export async function closeRuntime(runtime, lease) {
  await lease.release();
  await runtime.close();
  openRuntimes.delete(runtime);
}

async function readProcess(processId) {
  try {
    const [stat, commandLine] = await Promise.all([
      readFile(`/proc/${processId}/stat`, "utf8"),
      readFile(`/proc/${processId}/cmdline`, "utf8"),
    ]);
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    const parentId = Number(fields[1]);
    const [executable = ""] = commandLine.split("\0");
    return {
      processId,
      parentId,
      executable: basename(executable),
    };
  } catch (cause) {
    // The process may exit before open (ENOENT) or during read (ESRCH).
    if (
      cause instanceof Error &&
      "code" in cause &&
      (cause.code === "ENOENT" || cause.code === "ESRCH")
    )
      return undefined;
    throw new Error("Could not inspect a process owned by the workerd proof", {
      cause,
    });
  }
}

export async function ownedWorkerdProcesses() {
  const descendants = [];
  const pending = [process.pid];
  const visited = new Set(pending);
  while (pending.length > 0) {
    const parentId = pending.pop();
    let children;
    try {
      children = (
        await readFile(`/proc/${parentId}/task/${parentId}/children`, "utf8")
      )
        .trim()
        .split(/\s+/u)
        .filter(Boolean)
        .map(Number);
    } catch (cause) {
      // A parent can exit between discovery and reading its child list.
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause.code === "ENOENT" || cause.code === "ESRCH")
      )
        continue;
      throw new Error("Could not inspect children of the workerd proof", {
        cause,
      });
    }
    for (const processId of children) {
      if (visited.has(processId)) continue;
      visited.add(processId);
      pending.push(processId);
      const entry = await readProcess(processId);
      if (entry !== undefined) descendants.push(entry);
    }
  }
  return descendants.filter(({ executable }) => executable === "workerd");
}

afterEach(async () => {
  await Promise.allSettled(
    [...openRuntimes].map(async (runtime) => {
      await runtime.close();
      openRuntimes.delete(runtime);
    }),
  );
});
