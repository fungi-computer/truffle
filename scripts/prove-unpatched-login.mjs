import assert from "node:assert/strict";
import console from "node:console";
import process from "node:process";
import { execFileSync } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";

// Build prerequisites belong to Turbo, never this proof. Pack only the runtime
// dependency closure; npm gets registry pi-ai, never the workspace installation.
const root = fileURLToPath(new URL("../../../", import.meta.url));
const run = (bin, args, cwd) =>
  execFileSync(bin, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const workspaces = JSON.parse(
  run("pnpm", ["list", "-r", "--depth=-1", "--json"], root),
);
const packages = new Map();
for (const entry of workspaces) {
  const manifest = JSON.parse(
    await readFile(join(entry.path, "package.json"), "utf8"),
  );
  packages.set(manifest.name, { path: entry.path, manifest });
}
const closure = new Map();
function visit(name) {
  if (closure.has(name)) return;
  const entry = packages.get(name);
  assert.ok(entry, `Missing workspace ${name}`);
  closure.set(name, entry);
  for (const [dependency, spec] of Object.entries({
    ...entry.manifest.dependencies,
    ...entry.manifest.optionalDependencies,
  }))
    if (spec.startsWith("workspace:")) visit(dependency);
}
visit("@fungi.computer/truffle");
const scratch = await mkdtemp(join(tmpdir(), "truffle-unpatched-npm-"));
assert.ok(!resolve(scratch).startsWith(resolve(root) + "/"));
try {
  const packs = join(scratch, "packs");
  const install = join(scratch, "consumer");
  await mkdir(packs);
  await mkdir(install);
  const tarballs = [];
  for (const [name, entry] of closure) {
    const tarball = join(
      packs,
      name.replaceAll("/", "-").replaceAll("@", "") + ".tgz",
    );
    // pnpm translates workspace: references in the publication manifest.
    run("pnpm", ["pack", "--out", tarball], entry.path);
    if (name === "@fungi.computer/truffle") {
      const staging = join(scratch, "truffle");
      await mkdir(staging);
      run("tar", ["-xzf", tarball, "-C", staging], scratch);
      const result = JSON.parse(
        run(
          "npm",
          ["pack", "--json", "--ignore-scripts", "--pack-destination", packs],
          join(staging, "package"),
        ),
      );
      tarballs.push(join(packs, result[0].filename));
    } else tarballs.push(tarball);
  }
  await writeFile(
    join(install, "package.json"),
    JSON.stringify({
      name: "truffle-unpatched-login-proof",
      private: true,
      type: "module",
      // Same Effect companion pin as pnpm-workspace.yaml; no Pi patch or override.
      overrides: { "@effect/platform-node-shared": "4.0.2" },
    }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...tarballs,
      "@earendil-works/pi-ai@1.3.0",
      "jose@6.2.11",
      "react@18.3.1",
      "react-dom@18.3.1",
    ],
    install,
  );
  const lock = JSON.parse(
    await readFile(join(install, "package-lock.json"), "utf8"),
  );
  const pi = lock.packages["node_modules/@earendil-works/pi-ai"];
  assert.equal(pi.version, "1.3.0");
  assert.ok(pi.resolved.startsWith("https://registry.npmjs.org/"));
  const fixture = join(install, "login.mjs");
  await copyFile(
    new URL("../test/packed-openai-login.proof.mjs", import.meta.url),
    fixture,
  );
  console.log(run(process.execPath, [fixture], install));
  console.log(
    `Unpatched npm pi-ai: ${pi.resolved}; packed ${closure.size} runtime workspaces`,
  );
} catch (cause) {
  console.error(
    `Packed proof failed; disposable evidence retained at ${scratch}`,
  );
  throw cause;
}
await rm(scratch, { recursive: true, force: true });
