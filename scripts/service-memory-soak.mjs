/**
 * Bun memory soak for the Local Agent directory: SOAK_AGENTS (100) Agent
 * stores in one disposable project, listed SOAK_ROUNDS (300) times the way
 * the Agent directory and the sub-agents footer list them (store discovery
 * plus every profile). Prints RSS and the mimalloc 48/80-byte page counts
 * that grew without bound in the live service. Then measures bounded public
 * Session reads over an 80 MB compacted history. Setup samples distinguish an
 * open/write/warmup RSS offset from growth during the measured read loop.
 * Never opens ~/.fungi or a provider.
 *
 *   pnpm --dir runtimes/local build && bun runtimes/local/scripts/service-memory-soak.mjs
 */
import { gc } from "bun";
import { heapStats } from "bun:jsc";
import { Buffer } from "node:buffer";
import console from "node:console";
import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import process from "node:process";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import * as Effect from "effect/Effect";
import { capturePrivateLocalConfigRoot } from "../dist/private-local-config-root.js";
import { openPrivateLocalRuntimeHost } from "../dist/private-local-runtime-host.js";
import {
  listPrivateLocalAgentStores,
  readPrivateLocalAgentProfile,
} from "../dist/private-local-session-discovery.js";
import {
  createPrivateSqliteOwner,
  openPrivateWritableSqliteDatabase,
} from "../dist/private-sqlite-owner.js";
import { memoryHost } from "../../../packages/shiitake/src/testing.ts";
import { prepareWoodstockSchema } from "../../../packages/shiitake/src/internal/woodstock/index.ts";
import { writeLargeSession } from "../../../packages/shiitake/test/fixtures/large-session.fixture.ts";

const agents = Number(process.env.SOAK_AGENTS ?? 100);
const rounds = Number(process.env.SOAK_ROUNDS ?? 300);

// Kernel-produced counters, not physical disk I/O alone: SQLite pages served
// from the OS cache still burn CPU and copy bytes into its 2 MB page cache.
function readIo() {
  const text = readFileSync("/proc/self/io", "utf8");
  return {
    bytes: Buffer.byteLength(text),
    counters: Object.fromEntries(
      text
        .trim()
        .split("\n")
        .map((line) => {
          const [key, value] = line.split(":");
          return [key, Number(value)];
        }),
    ),
  };
}

/** The real public read pipeline over Local's native owner, without a provider. */
async function sessionReads(databasePath) {
  const database = openPrivateWritableSqliteDatabase(databasePath, 5000);
  const native = createPrivateSqliteOwner(database);
  let walks = 0;
  let storeReads = 0;
  const owner = {
    transactionSync: native.transactionSync,
    sql: {
      exec: (statement, ...bindings) => {
        if (/\bWITH\s+RECURSIVE\b/iu.test(statement)) walks += 1;
        if (/^\s*(?:SELECT|WITH)\b/iu.test(statement)) storeReads += 1;
        return native.sql.exec(statement, ...bindings);
      },
    },
  };
  let host;
  try {
    database.exec("PRAGMA cache_size = -2048");
    // The template comes from built Local code. Prepare through the source
    // being measured before writing history, not only when memoryHost opens.
    Effect.runSync(prepareWoodstockSchema(owner));
    sample("Session SQLite opened");
    const history = writeLargeSession(owner, {
      sessionId: "memory-soak-history",
      turns: 250,
      textBytes: 160_000,
      compactEvery: 50,
      keepTurns: 4,
    });
    sample("Session history written");
    host = await memoryHost({ owner });
    sample("Session host prepared");
    const session = host.agent.session(history.sessionId);
    await session.read({ limit: 50 });
    sample("Session first warm read");
    await session.read({ limit: 50 });
    sample("Session second warm read");
    gc(true);
    const reads = 30;
    console.log(JSON.stringify({ label: "Session read window begins", reads }));
    const io = readIo();
    const cpu = process.cpuUsage();
    const started = performance.now();
    const initialRss = process.memoryUsage.rss();
    let peakRss = initialRss;
    const initialWalks = walks;
    const initialStoreReads = storeReads;
    for (let index = 0; index < reads; index += 1) {
      const snapshot = await session.read({ limit: 50 });
      if (
        snapshot.messages.length === 0 ||
        snapshot.messages.at(-1)?.id !== history.turns.at(-1)?.assistantId
      )
        throw new Error(
          "Session soak did not read the expected newest message",
        );
      peakRss = Math.max(peakRss, process.memoryUsage.rss());
      await delay(2000);
    }
    const elapsedMs = performance.now() - started;
    const used = process.cpuUsage(cpu);
    const after = readIo();
    const readBytes = after.counters.rchar - io.counters.rchar - io.bytes;
    const physicalReadBytes =
      after.counters.read_bytes - io.counters.read_bytes;
    const cpuMs = (used.user + used.system) / 1000;
    console.log(
      JSON.stringify({
        label: "Session reads on 80 MB history",
        reads,
        elapsedMs,
        initialRssMb: initialRss / 1e6,
        peakRssMb: peakRss / 1e6,
        finalRssMb: process.memoryUsage.rss() / 1e6,
        cpuMs,
        cpuPercent: (100 * cpuMs) / elapsedMs,
        cpuMsPerRead: cpuMs / reads,
        readBytesPerSecond: readBytes / (elapsedMs / 1000),
        physicalReadBytesPerSecond: physicalReadBytes / (elapsedMs / 1000),
        // 4096-byte SQLite page equivalents, including OS-cache reads. This
        // is deliberately not labelled a count of physical disk reads.
        pageReadEquivalentsPerRead: readBytes / 4096 / reads,
        storeReadsPerRead: (storeReads - initialStoreReads) / reads,
        recursiveQueriesPerRead: (walks - initialWalks) / reads,
      }),
    );
  } finally {
    await host?.close();
    database.close();
  }
}

function sample(label) {
  const stats = heapStats();
  const pages = new Map(
    (stats.mimalloc?.page_bins ?? []).map((bin) => [
      bin.block_size,
      bin.current,
    ]),
  );
  console.log(
    JSON.stringify({
      label,
      rssMb: process.memoryUsage.rss() / 1e6,
      pages48: pages.get(48) ?? 0,
      pages80: pages.get(80) ?? 0,
    }),
  );
}

const area = await mkdtemp(join(tmpdir(), "fungi-memory-soak-"));
const previousHome = process.env.HOME;
try {
  const configRoot = capturePrivateLocalConfigRoot(join(area, "home"));
  await mkdir(configRoot.home, { recursive: true });
  process.env.HOME = configRoot.home;
  const project = join(area, "project");
  await mkdir(project);
  const root = await realpath(project);
  const faux = fauxProvider({
    provider: "memory-soak",
    models: [{ id: "probe", name: "Memory soak" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const host = await openPrivateLocalRuntimeHost(
    {
      invocationRoot: root,
      configRoot,
      providerId: "memory-soak",
      modelId: "probe",
    },
    models,
  );
  const template = host.databasePath;
  await host.close();
  for (let index = 1; index < agents; index += 1) {
    const store = join(
      dirname(dirname(template)),
      `local_store_soak${String(index)}`,
    );
    await mkdir(store);
    await copyFile(template, join(store, "agent.sqlite"));
  }
  gc(true);
  sample(`created ${String(agents)} Agents`);
  for (let round = 1; round <= rounds; round += 1) {
    for (const path of await listPrivateLocalAgentStores(root))
      readPrivateLocalAgentProfile(path);
    if (round % Math.max(1, Math.floor(rounds / 5)) === 0) {
      gc(true);
      sample(`listed ${String(round)} times`);
    }
  }
  await sessionReads(template);
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(area, { recursive: true, force: true });
}
