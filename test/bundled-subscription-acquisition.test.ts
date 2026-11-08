import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { afterEach, expect, it } from "vitest";
import { openAIAccessToken } from "./openai-fixtures.js";

const run = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true })),
  );
});

// The service worker is bundled on its own (`build:service-worker`), so Pi's
// relative `./anthropic.js`-style OAuth imports have nothing to load beside it.
// This entry acquires a subscription model the way the worker does, from a
// bundle written to an empty folder with the worker's esbuild options.
const entry = `
import { createPrivateCredentialStore } from "./private-file-credential-store.js";
import { createPrivateModels } from "./local-models.js";
import { acquireSubscriptionTurn } from "./subscription-turn.js";

const [credentialPath, providerId] = process.argv.slice(2);
await createPrivateCredentialStore(credentialPath).modify(providerId, () =>
  Promise.resolve({
    type: "oauth",
    access: process.env.FIXTURE_ACCESS,
    refresh: "fixture-refresh-never-used",
    expires: Date.now() + 3_600_000,
  }),
);
const turn = await acquireSubscriptionTurn(
  createPrivateModels(credentialPath),
  providerId,
  new AbortController().signal,
);
const auth = await turn.models.getAuth(providerId);
await turn.release();
process.stdout.write(auth?.auth.apiKey ?? "");
`;

async function acquireFromBundle(providerId: string, access: string) {
  const root = await mkdtemp(join(tmpdir(), "fungi-bundled-acquisition-"));
  roots.push(root);
  // Like the packed Spore: the worker sits in dist/ beside nothing but its
  // own bundle, under a package manifest.
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "fixture-spore", version: "0.0.0", type: "module" }),
  );
  const outfile = join(root, "dist", "private-local-service-worker.mjs");
  await build({
    stdin: { contents: entry, resolveDir: source, loader: "ts" },
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    conditions: ["bun"],
    target: "es2024",
    external: ["bun", "bun:*", "miniflare", "@napi-rs/keyring"],
    logLevel: "silent",
  });
  const { stdout } = await run(
    "bun",
    [outfile, join(root, "credentials.json"), providerId],
    {
      cwd: root,
      env: { ...process.env, FIXTURE_ACCESS: access },
    },
  );
  return stdout;
}

it("a bundled service worker resolves the Claude subscription's OAuth flow", async () => {
  const access = "fixture-claude-access";
  expect(await acquireFromBundle("anthropic", access)).toBe(access);
}, 120_000);

it("a bundled service worker resolves the ChatGPT subscription's OAuth flow", async () => {
  const access = openAIAccessToken("fixture-chatgpt-person");
  expect(await acquireFromBundle("openai", access)).toBe(access);
}, 120_000);
