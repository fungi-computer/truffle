/**
 * Linux/Bun diagnostic: six concurrent real Local Agent owners, each streaming
 * a 400 KB faux reply while a slow Session watcher reads it. Warm five rounds,
 * then measure 25 rounds (150 opens/turns/closes). No real provider or user store.
 * This checks retained growth; it does not identify the historical stall's cause.
 */
import assert from "node:assert/strict";
import console from "node:console";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { performance } from "node:perf_hooks";
import { gc, sleep } from "bun";
import { heapStats } from "bun:jsc";
import { Database } from "bun:sqlite";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { capturePrivateLocalConfigRoot } from "../dist/private-local-config-root.js";
import { openPrivateLocalRuntimeHost } from "../dist/private-local-runtime-host.js";

assert.equal(
  process.platform,
  "linux",
  "The descriptor measurement needs /proc",
);
console.log(
  JSON.stringify({
    event: "soak-runtime",
    bun: process.versions.bun,
    platform: process.platform,
  }),
);
const started = performance.now();
const area = await mkdtemp(join(tmpdir(), "fungi-stream-memory-"));
const configRoot = capturePrivateLocalConfigRoot(join(area, "home"));
const project = join(area, "project");
const concurrency = 6;
const warmupRounds = 5;
const measuredRounds = 25;
const reply = "abcdefgh".repeat(50_000);
const faux = fauxProvider({
  provider: "memory-soak",
  models: [{ id: "probe", name: "Memory soak" }],
  tokenSize: { min: 64, max: 64 },
});
const models = createModels();
models.setProvider(faux.provider);

async function sample(round) {
  // Drain native finalizers too. Report retained rather than pre-GC heap cells.
  await sleep(0);
  gc(true);
  await sleep(0);
  gc(true);
  const heap = heapStats();
  const value = {
    round,
    rss: process.memoryUsage.rss(),
    strings: heap.objectTypeCounts.string ?? 0,
    statements: heap.objectTypeCounts.SQLStatement ?? 0,
    fds: (await readdir("/proc/self/fd")).length,
    threads: (await readdir("/proc/self/task")).length,
    elapsedMs: Math.round(performance.now() - started),
  };
  console.log(JSON.stringify({ event: "retained-memory", ...value }));
  return value;
}

async function turn(round, index) {
  const directory = join(project, `${String(round)}-${String(index)}`);
  await mkdir(directory);
  const databasePath = join(directory, "agent.sqlite");
  new Database(databasePath, { create: true }).close(true);
  const host = await openPrivateLocalRuntimeHost(
    {
      invocationRoot: project,
      configRoot,
      databasePath,
      providerId: "memory-soak",
      modelId: "probe",
    },
    models,
  );
  let watch;
  let consuming;
  let frames = 0;
  try {
    watch = await host.session.watch();
    consuming = (async () => {
      for await (const frame of watch.changes) {
        assert.ok(frame.kind);
        frames++;
        await sleep(10);
      }
    })();
    await host.session.send("Stream the fixture reply");
    const deadline = performance.now() + 30_000;
    for (;;) {
      const snapshot = await host.session.read();
      const terminal = snapshot.terminals.at(-1);
      if (terminal !== undefined) {
        assert.equal(
          terminal.outcome,
          "completed",
          terminal.diagnostic ?? "Missing completion",
        );
        const assistant = snapshot.messages.at(-1);
        assert.ok(assistant, "Missing completed assistant message");
        assert.equal(
          assistant.value.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join(""),
          reply,
        );
        break;
      }
      assert.ok(
        performance.now() < deadline,
        "The fixture turn did not settle",
      );
      await sleep(10);
    }
  } finally {
    try {
      await watch?.close();
      await consuming;
    } finally {
      await host.close();
    }
  }
  assert.ok(frames > 0, "The Session watcher received no frames");
}

try {
  await mkdir(configRoot.home, { recursive: true });
  await mkdir(project);
  let baseline;
  let final;
  for (let round = 1; round <= warmupRounds + measuredRounds; round++) {
    faux.setResponses(
      Array.from(
        { length: concurrency },
        () => () => fauxAssistantMessage(reply),
      ),
    );
    await Promise.all(
      Array.from({ length: concurrency }, (_, index) => turn(round, index)),
    );
    assert.equal(
      faux.state.callCount,
      round * concurrency,
      "Unexpected provider retries or extra turns",
    );
    const current = await sample(round);
    if (round === warmupRounds) baseline = current;
    if (round <= warmupRounds) continue;
    assert.ok(baseline);
    assert.ok(
      current.rss <= baseline.rss + 128 * 1024 * 1024,
      "RSS growth exceeded 128 MiB after warmup",
    );
    assert.ok(
      current.strings <= baseline.strings + 20_000,
      "Retained string growth exceeded 20,000 cells",
    );
    assert.ok(
      current.fds <= baseline.fds + 3,
      "Descriptors grew after Agent close",
    );
    assert.ok(
      current.statements <= baseline.statements + 3,
      "SQLite statements grew after Agent close",
    );
    final = current;
  }
  console.log(
    JSON.stringify({
      event: "soak-complete",
      turns: concurrency * measuredRounds,
      baseline,
      final,
    }),
  );
} finally {
  await rm(area, { recursive: true, force: true });
}
