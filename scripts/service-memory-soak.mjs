/**
 * Bun memory soak for the Local Agent directory: SOAK_AGENTS (100) Agent
 * stores in one disposable project, listed SOAK_ROUNDS (300) times the way
 * the Agent directory and the sub-agents footer list them (store discovery
 * plus every profile). Prints RSS and the mimalloc 48/80-byte page counts
 * that grew without bound in the live service. Never opens ~/.fungi or a
 * provider.
 *
 *   pnpm --dir runtimes/local build && bun runtimes/local/scripts/service-memory-soak.mjs
 */
import { gc } from "bun";
import { heapStats } from "bun:jsc";
import console from "node:console";
import { copyFile, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import process from "node:process";
import { dirname, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { capturePrivateLocalConfigRoot } from "../dist/private-local-config-root.js";
import { openPrivateLocalRuntimeHost } from "../dist/private-local-runtime-host.js";
import {
  listPrivateLocalAgentStores,
  readPrivateLocalAgentProfile,
} from "../dist/private-local-session-discovery.js";

const agents = Number(process.env.SOAK_AGENTS ?? 100);
const rounds = Number(process.env.SOAK_ROUNDS ?? 300);

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
      rssMb: Math.round(process.memoryUsage.rss() / 1e6),
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
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(area, { recursive: true, force: true });
}
