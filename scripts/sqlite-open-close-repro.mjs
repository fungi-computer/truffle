// Standalone Bun reproduction; no Botanical imports, real stores or providers.
// timeout --kill-after=5s 600s bun sqlite-open-close-repro.mjs --mode open-close
import { gc, revision, sleep, version } from "bun";
import { heapStats } from "bun:jsc";
import { Database } from "bun:sqlite";
import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { parseArgs } from "node:util";

const started = performance.now();
const { values } = parseArgs({
  options: {
    mode: { type: "string", default: "open-close" },
    cycles: { type: "string", default: "1000000" },
    "max-ms": { type: "string", default: "570000" },
  },
});
const mode = values.mode;
const cycles = Number(values.cycles);
const maxMs = Number(values["max-ms"]);
if (
  !["control", "open-close", "read"].includes(mode) ||
  !Number.isSafeInteger(cycles) ||
  cycles < 1 ||
  cycles > 1_000_000 ||
  !Number.isSafeInteger(maxMs) ||
  maxMs < 1 ||
  maxMs > 570_000
)
  throw new Error(
    "Expected mode control|open-close|read, cycles 1..1000000, max-ms 1..570000",
  );

const area = mkdtempSync(join(tmpdir(), "bun-sqlite-open-close-"));
const path = join(area, "fixture.sqlite");
const seed = new Database(path, { create: true, strict: true });
seed.run("CREATE TABLE entry (value INTEGER)");
seed.run("INSERT INTO entry VALUES (1)");
seed.close(true);

function cycle() {
  if (mode === "control") return 1;
  const database = new Database(path, {
    readonly: true,
    create: false,
    strict: true,
  });
  try {
    if (mode === "read") {
      database.run("PRAGMA busy_timeout = 250");
      return database.prepare("SELECT value FROM entry").get().value;
    }
    return 1;
  } finally {
    database.close(true);
  }
}

async function sample(completed) {
  // Drain finalizers between batches, then request full GC on both versions.
  await sleep(0);
  gc(true);
  await sleep(0);
  gc(true);
  const { heapSize, objectCount } = heapStats();
  const { rss, heapUsed, external } = process.memoryUsage();
  console.log(
    JSON.stringify({
      completed,
      rss,
      heapUsed,
      external,
      jscHeapSize: heapSize,
      jscObjectCount: objectCount,
      elapsedMs: Math.round(performance.now() - started),
    }),
  );
}

let completed = 0;
let checksum = 0;
try {
  console.log(
    JSON.stringify({
      kind: "metadata",
      bun: version,
      revision,
      platform: process.platform,
      arch: process.arch,
      mode,
      cycles,
      maxMs,
      warmup: 10_000,
    }),
  );
  for (let index = 0; index < 10_000; index++) checksum += cycle();
  await sample(0);
  while (completed < cycles && performance.now() - started < maxMs) {
    const end = Math.min(completed + 10_000, cycles);
    for (; completed < end; completed++) checksum += cycle();
    await sample(completed);
  }
  console.log(
    JSON.stringify({
      kind: "result",
      completed,
      requested: cycles,
      checksum,
      status: completed === cycles ? "complete" : "wall-time-limit",
    }),
  );
  if (completed !== cycles) process.exitCode = 2;
} finally {
  rmSync(area, { recursive: true, force: true });
}
