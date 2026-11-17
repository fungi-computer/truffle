/**
 * Writes one synthetic Agent store with the Local host of whatever checkout runs
 * this file. It exists to produce the committed old-schema fixtures under
 * packages/shiitake/test/fixtures/historical-stores: run it, unchanged, inside a
 * checkout of the historical commit (a temporary `git worktree`), never against
 * a person's own `.fungi` folder. Everything stored is scripted here: a stub
 * model, a note this file writes, and a few Sessions. It imports the built Local host
 * (dist), because the execute tool needs the built sandbox worker.
 *
 *   HOME=SCRATCH node --import tsx historical-store.generator.mts OUTPUT
 */
import { DatabaseSync } from "node:sqlite";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { z } from "zod";
import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import { loopContract } from "@fungi.computer/shiitake-extensions/loop";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createPrivateLocalSessionRequestId,
  openPrivateLocalRuntimeHost,
} from "../../dist/private-local-runtime-host.js";

const outArgument = process.argv[2];
// What every historical host's Watchdog table can answer: how much work is unsettled.
const unsettledRow = z.object({ count: z.number() });
if (outArgument === undefined) throw new Error("Expected an output folder");
const out = resolve(outArgument);
if (process.env.HOME?.startsWith(out) !== true)
  throw new Error("Set HOME to a scratch directory inside the output folder");

await mkdir(join(out, "notes"), { recursive: true });
await writeFile(join(out, "notes", "fixture-note.txt"), "Synthetic note.\n");
// A one-pixel image, so a tool run that reads it stores image details beside its text.
await writeFile(
  join(out, "notes", "pixel.png"),
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

const models = createModels();
const faux = fauxProvider({
  provider: "faux-local",
  models: [{ id: "offline", name: "Offline fixture" }],
});
models.setProvider(faux.provider);
const toolCall = (name: string, args: Record<string, string>) =>
  fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
// Long enough that a later compaction has an earlier turn to summarize.
const filler = (label: string) =>
  Array.from(
    { length: 1000 },
    (_, line) => `${label} line ${String(line)}: synthetic filler text.`,
  ).join("\n");
// A retryable provider failure, so the Session records its automatic retry.
const overloaded = fauxAssistantMessage("", {
  stopReason: "error",
  errorMessage: JSON.stringify({
    type: "error",
    error: { type: "overloaded_error", message: "Overloaded" },
  }),
});
faux.setResponses([
  ...(process.env.FIXTURE_RETRY === "0" ? [] : [overloaded]),
  toolCall("list", { path: "notes" }),
  toolCall("read", { path: "notes/fixture-note.txt" }),
  toolCall("execute", {
    code: 'async () => (await env.computers.local.files.read({ path: "notes/pixel.png" })).path',
  }),
  fauxAssistantMessage("Fixture reply one."),
  fauxAssistantMessage("Fixture reply two."),
  fauxAssistantMessage("Long reply one."),
  fauxAssistantMessage("Long reply two."),
  fauxAssistantMessage("Synthetic summary of the earlier turns."),
  fauxAssistantMessage("Second session reply."),
  fauxAssistantMessage("Third session reply."),
  // Spare answers for a host that runs a loop's prompt as soon as it starts.
  fauxAssistantMessage("Spare reply."),
  fauxAssistantMessage("Spare reply."),
]);

const host = await openPrivateLocalRuntimeHost(
  {
    invocationRoot: out,
    providerId: "faux-local",
    modelId: "offline",
    name: "Fixture Agent",
    mode: "full-access",
  },
  models,
);

function unsettled(): number {
  const database = new DatabaseSync(host.databasePath, { readOnly: true });
  try {
    return unsettledRow.parse(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM watchdog_jobs WHERE state != 'settled'",
        )
        .get(),
    ).count;
  } finally {
    database.close();
  }
}

async function settle() {
  const deadline = Date.now() + 60_000;
  // A host reads its own jobs as settled a moment after the last row lands.
  while (unsettled() > 0) {
    if (Date.now() > deadline) throw new Error("Fixture work did not settle");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}

async function prompt(
  session: typeof host.session,
  requestId: string,
  text: string,
) {
  await session.command({
    type: "prompt",
    delivery: "followUp",
    requestId,
    text,
  });
  await settle();
}

try {
  await prompt(
    host.session,
    "fixture-one",
    "Fixture prompt one: read the note.",
  );
  await prompt(host.session, "fixture-two", "Fixture prompt two.");
  await prompt(host.session, "fixture-long-one", filler("first"));
  await prompt(host.session, "fixture-long-two", filler("second"));
  await host.session.command({ type: "compact", requestId: "fixture-compact" });
  await settle();
  const second = await host.createSession(createPrivateLocalSessionRequestId());
  await prompt(
    host.getSession(second),
    "fixture-three",
    "Second session prompt.",
  );
  const third = await host.createSession(createPrivateLocalSessionRequestId());
  await prompt(host.getSession(third), "fixture-four", "Third session prompt.");
  // Last, because a registered timer keeps an older host from reporting idle:
  // a loop keeps one timer for its next hourly wake.
  await bindSessionExtension(host.getSession(second), loopContract).call(
    "startFixedInterval",
    {
      prompt: "Check the beds",
      requestId: "fixture-loop",
      expression: "0 * * * *",
      timeZone: "UTC",
    },
  );
} finally {
  await host.close();
}

// Leave one self-contained file: fold the journal in and drop the sidecars.
const directory = join(out, ".fungi", "agents", host.agentId);
const database = new DatabaseSync(join(directory, "agent.sqlite"));
try {
  database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
} finally {
  database.close();
}
for (const name of await readdir(directory))
  if (name !== "agent.sqlite")
    await rm(join(directory, name), { recursive: true, force: true });
console.log(join(directory, "agent.sqlite"));
