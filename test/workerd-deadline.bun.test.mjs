import assert from "node:assert/strict";
import console from "node:console";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { z } from "zod";
import { Mycelium } from "@fungi.computer/mycelium";
import { Knapsack } from "@fungi.computer/knapsack";
import {
  createPrivateInvocationComputer,
  createPrivateWorkerdSandbox,
} from "../dist/index.js";

const durationMs = z.coerce
  .number()
  .int()
  .min(2_000)
  .max(720_000)
  .parse(process.argv[2]);
const deadlineMs = Math.min(durationMs - 1_000, 310_000);
const resultSchema = z.tuple([
  z.object({
    type: z.literal("result"),
    result: z.object({
      content: z.tuple([
        z.object({ type: z.literal("text"), text: z.string() }),
      ]),
    }),
  }),
]);
const root = await mkdtemp(join(tmpdir(), "fungi-dispatch-deadline-"));
const startedAt = performance.now();
async function execute(code) {
  const runtime = await Mycelium.make({
    execution: { timeoutMs: durationMs + 60_000 },
    sources: [
      Knapsack.computer({
        id: "local-computer",
        name: "Local Computer",
        computer: await createPrivateInvocationComputer(root),
      }),
    ],
    sandbox: createPrivateWorkerdSandbox(),
  });
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "deadline-proof",
        name: "execute",
        arguments: { code },
      }),
    );
    const parts = await Effect.runPromise(
      Stream.runCollect(prepared.execute()),
    );
    const [part] = resultSchema.parse(
      parts.filter((value) => value.type === "result"),
    );
    return JSON.parse(part.result.content[0].text);
  } finally {
    await lease.release();
    await runtime.close();
  }
}
try {
  const results = await Promise.allSettled([
    execute(
      `await new Promise(resolve => setTimeout(resolve, ${durationMs})); return "survived";`,
    ),
    execute(
      `return await Local_Computer.exec({ command: "printf early; sleep ${durationMs / 1000}; printf late", timeoutMs: ${durationMs + 30_000} });`,
    ),
    execute(
      `return await Local_Computer.exec({ command: "printf partial; printf warning >&2; sleep ${durationMs / 1000}", timeoutMs: ${deadlineMs} });`,
    ),
  ]);
  const [guest, command, deadline] = results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  });
  assert.equal(guest, "survived");
  assert.equal(command.status, "completed");
  assert.equal(command.stdout, "earlylate");
  assert.equal(command.stderr, "");
  assert.equal(deadline.status, "deadline_exceeded");
  assert.equal(deadline.timeoutMs, deadlineMs);
  assert(deadline.elapsedMs >= deadlineMs);
  assert.equal(deadline.stdout, "partial");
  assert.equal(deadline.stderr, "warning");
  assert.equal(deadline.truncated, false);
  assert.equal(deadline.exitCode, -1);
  console.log(
    JSON.stringify({
      durationMs,
      elapsedMs: Math.round(performance.now() - startedAt),
      status: "passed",
    }),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
