import assert from "node:assert/strict";
import console from "node:console";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { parseArgs } from "node:util";
import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import { goalContract } from "@fungi.computer/shiitake-extensions/goal";
import { loopContract } from "@fungi.computer/shiitake-extensions/loop";
import { planContract } from "@fungi.computer/shiitake-extensions/plan";
import { openPrivateLocalRuntimeHost } from "../dist/private-local-runtime-host.js";

const { values } = parseArgs({ options: { receipt: { type: "string" } } });
if (values.receipt === undefined)
  throw new Error("Supply --receipt <owner-only JSON path>");
const scratch = resolve(".botanical/goal-loop-sol-proof");
await mkdir(scratch, { recursive: true });
const root = await mkdtemp(scratch + "/home-");
const receipt = {
  revision: execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  runtime: "Local Bun public Session",
  model: "openai/gpt-6.1-sol",
  root,
  startedAt: new Date().toISOString(),
  status: "running",
  steps: [],
};
const host = await openPrivateLocalRuntimeHost({
  invocationRoot: root,
  providerId: "openai",
  modelId: "gpt-6.1-sol",
  reasoning: "low",
});
const session = host.session;
const loop = bindSessionExtension(session, loopContract);
const goal = bindSessionExtension(session, goalContract);
const plan = bindSessionExtension(session, planContract);

async function settled() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const snapshot = await session.read();
    if (
      snapshot.activity.queue.state === "idle" &&
      snapshot.pending.prompts.length === 0
    )
      return snapshot;
    await wait(200);
  }
  throw new Error("Model turn did not settle before proof deadline");
}
function record(name, snapshot) {
  receipt.steps.push({
    name,
    snapshot,
    transcriptIds: snapshot.messages.map((message) => message.id),
  });
}
async function persist() {
  await writeFile(values.receipt, JSON.stringify(receipt, null, 2), {
    mode: 0o600,
  });
}
try {
  await session.send(
    'Use forage.search and forage.describe to discover all Session goal, loop and plan tools. Include the exact forage.search({query:"schedule_next"}) case and searches "goal", "loop", "schedule", "plan". Then set a goal: create proof.txt containing exactly ok, verify it by reading it, and mark the goal complete with evidence. Maintain a two-step plan and complete both steps when done. Do not schedule a loop in this turn.',
    { requestId: "goal-file", delivery: "followUp" },
  );
  const first = await settled();
  assert.equal((await readFile(root + "/proof.txt", "utf8")).trim(), "ok");
  assert.equal(goal.view(first).value?.state, "complete");
  assert.ok(
    plan.view(first).value?.steps.every((step) => step.status === "completed"),
  );
  record("goal-file-and-plan", first);
  await wait(1_000);
  assert.equal(
    (await session.read()).messages.length,
    first.messages.length,
    "Completed goal continued",
  );

  await loop.call("startSelfPaced", {
    prompt:
      "Verify proof.txt exists, then use the discoverable loop.stop tool with a reason; do not request another wake.",
    requestId: "stop-loop",
  });
  const stopped = await settled();
  assert.equal(loop.view(stopped).value?.state, "finished");
  record("loop-stop-first-occurrence", stopped);

  const scheduleStartedAt = Date.now();
  await loop.call("startSelfPaced", {
    prompt:
      "Use loop.get. If its reason is null, call loop.schedule_next({delaySeconds:60,reason:'One delayed verification'}), then finish this turn. Otherwise verify proof.txt and call loop.stop with a reason. Do not create another goal.",
    requestId: "one-wake",
  });
  const scheduled = await settled();
  const scheduledLoop = loop.view(scheduled).value;
  assert.equal(scheduledLoop?.state, "active");
  assert.ok(
    scheduledLoop?.nextDueAt !== null && scheduledLoop?.nextDueAt !== undefined,
  );
  const dueAt = scheduledLoop.nextDueAt;
  assert.ok(
    dueAt >= scheduleStartedAt + 60_000,
    "Wake must be scheduled at least 60 seconds later",
  );
  const before = Date.now();
  record("loop-schedule-60", scheduled);
  await persist();
  await wait(Math.max(0, dueAt - Date.now()) + 2_000);
  let woken;
  for (let attempt = 0; attempt < 180; attempt++) {
    woken = await session.read();
    if (
      loop.view(woken).value?.state === "finished" &&
      woken.activity.queue.state === "idle"
    )
      break;
    await wait(1_000);
  }
  assert.equal(loop.view(woken).value?.state, "finished");
  assert.ok(Date.now() >= dueAt);
  assert.equal(
    woken.messages.filter((message) => message.value.role === "user").length,
    scheduled.messages.filter((message) => message.value.role === "user")
      .length + 1,
  );
  receipt.wake = { dueAt, waitStartedAt: before, finishedAt: Date.now() };
  record("one-real-delayed-occurrence", woken);
  receipt.status = "pass";
} catch (cause) {
  receipt.status = "fail";
  receipt.failure =
    cause instanceof Error
      ? { name: cause.name, message: cause.message }
      : { name: "NonError" };
  record("failure-readback", await session.read());
  throw cause;
} finally {
  receipt.finishedAt = new Date().toISOString();
  await persist();
  await host.close();
  console.log(
    JSON.stringify({
      status: receipt.status,
      receipt: values.receipt,
      revision: receipt.revision,
    }),
  );
}
