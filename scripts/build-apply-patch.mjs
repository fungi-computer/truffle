import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, URL } from "node:url";
import console from "node:console";
const { fetch } = globalThis;
import process from "node:process";
import { parseArgs } from "node:util";
import { nativeNotices } from "./native-notices.mjs";
import { codexPatchPin } from "../native/apply-patch/pin.mjs";
import {
  ensureNativeHostToolchain,
  selectCargoInvocation,
} from "./native-toolchain.mjs";

// Linux x64 always builds against the release's glibc floor, never host headers.
// Other native hosts supply Rust 1.98.1, a C compiler and pkg-config.
const { values } = parseArgs({
  options: {
    target: { type: "string", default: `${process.platform}-${process.arch}` },
    "in-container": { type: "boolean", default: false },
  },
});
const platform = values.target;
const crossLinuxArm =
  platform === "linux-arm64" &&
  process.platform === "linux" &&
  process.arch === "x64";
const macTarget = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
}[platform];
const crossMac = macTarget !== undefined && process.platform !== "darwin";
// The Linux Docker image and the mac cross-build's container already put
// rustup's pinned `cargo` proxy first on PATH; only a genuinely native host
// build needs to ask rustup for it explicitly.
const containerized = platform === "linux-x64" || crossMac || crossLinuxArm;
if (
  platform !== `${process.platform}-${process.arch}` &&
  !crossMac &&
  !crossLinuxArm
)
  throw new Error(`Unsupported native build target: ${platform}`);
const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
const repositoryRoot = resolve(runtimeRoot, "../..");
if (!values["in-container"]) {
  const destination =
    crossMac || crossLinuxArm
      ? resolve(repositoryRoot, `.botanical/native-build/${platform}/bin`)
      : resolve(runtimeRoot, "native/bin");
  const { ensureNativePatchArtifact } =
    await import("./native-patch-cache.mjs");
  const result = await ensureNativePatchArtifact({
    cacheRoot: resolve(
      process.env.XDG_CACHE_HOME ?? resolve(homedir(), ".cache"),
      "fungi/native-patch",
    ),
    pin: codexPatchPin,
    target: platform,
    wrapper: resolve(runtimeRoot, "native/apply-patch/main.rs"),
    destination,
    build: async () => {
      if (containerized) {
        const { buildPatchInContainer } =
          await import("./build-apply-patch-container.mjs");
        await buildPatchInContainer(platform);
      } else {
        await new Promise((accept, reject) => {
          const child = spawn(
            process.execPath,
            [
              fileURLToPath(import.meta.url),
              "--target",
              platform,
              "--in-container",
            ],
            { stdio: "inherit" },
          );
          child.once("error", reject);
          child.once("exit", (code, signal) =>
            code === 0
              ? accept()
              : reject(
                  new Error(`Native patch build failed (${signal ?? code})`),
                ),
          );
        });
      }
    },
  });
  console.log(
    `Pinned Codex patch artifact ${result.kind}: ${codexPatchPin.version}/${platform} (${result.artifact})`,
  );
  process.exit(0);
}
const inJammy = platform === "linux-x64" || crossLinuxArm;
if (inJammy && process.report.getReport().header.glibcVersionRuntime !== "2.35")
  throw new Error("The Linux release builder requires glibc 2.35");
const buildRoot = resolve(repositoryRoot, ".botanical/native-build");
const scratch =
  platform === "linux-x64" ? buildRoot : resolve(buildRoot, platform);
const archive = resolve(buildRoot, `codex-${codexPatchPin.version}.tar.gz`);
const upstream = resolve(scratch, `codex-${codexPatchPin.version}/codex-rs`);
const sha256 = codexPatchPin.sourceSha256;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: "inherit", ...options });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} failed (${String(result.status)})`);
}

await mkdir(scratch, { recursive: true });
try {
  await access(archive);
} catch {
  const response = await fetch(
    `https://github.com/openai/codex/archive/refs/tags/${codexPatchPin.version}.tar.gz`,
  );
  if (!response.ok)
    throw new Error(`Codex source download failed: ${response.status}`);
  await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
}
if (
  createHash("sha256")
    .update(await readFile(archive))
    .digest("hex") !== sha256
)
  throw new Error("Pinned Codex source checksum mismatch");
// Re-extract the verified source so old wrapper or manifest edits cannot survive.
run("tar", ["-xzf", archive, "-C", scratch]);
const manifestPath = resolve(upstream, "Cargo.toml");
const manifest = await readFile(manifestPath, "utf8");
// The release tag bumps workspace package versions but leaves 0.0.0 in its
// lockfile. Restore that build-only metadata; all dependency pins stay intact.
await writeFile(
  manifestPath,
  manifest.replace(
    `version = "${codexPatchPin.version.slice(6)}"`,
    'version = "0.0.0"',
  ),
);
await copyFile(
  resolve(runtimeRoot, "native/apply-patch/main.rs"),
  resolve(upstream, "apply-patch/src/fungi-main.rs"),
);
const patchManifest = resolve(upstream, "apply-patch/Cargo.toml");
await writeFile(
  patchManifest,
  `${await readFile(patchManifest, "utf8")}\n[[bin]]\nname = "fungi-apply-patch"\npath = "src/fungi-main.rs"\n`,
);
const target = resolve(scratch, inJammy ? "target-jammy" : "target");
const cargoHome = process.env.CARGO_HOME ?? resolve(homedir(), ".cargo");
const nativePathFlags = [
  `-ffile-prefix-map=${repositoryRoot}=/build`,
  `-ffile-prefix-map=${cargoHome}=/cargo`,
]
  .map((flag) => JSON.stringify(flag))
  .join(" ");
const nativeToolchain = "1.98.1";
if (!containerized) ensureNativeHostToolchain({ toolchain: nativeToolchain });
const { command: cargoCommand, args: cargoArgs } = selectCargoInvocation({
  containerized,
  toolchain: nativeToolchain,
  cargoArgs: [
    crossMac ? "zigbuild" : "build",
    "--release",
    ...(crossMac
      ? ["--target", macTarget]
      : crossLinuxArm
        ? ["--target", "aarch64-unknown-linux-gnu"]
        : []),
    "--message-format=json",
    "--manifest-path",
    manifestPath,
    "--locked",
    "-p",
    "codex-apply-patch",
    "--bin",
    "fungi-apply-patch",
  ],
});
const cargo = spawnSync(cargoCommand, cargoArgs, {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  env: {
    ...process.env,
    CARGO_TARGET_DIR: target,
    CARGO_ENCODED_RUSTFLAGS: [
      `--remap-path-prefix=${repositoryRoot}=/build`,
      `--remap-path-prefix=${cargoHome}=/cargo`,
    ].join("\x1f"),
    CFLAGS: nativePathFlags,
    CXXFLAGS: nativePathFlags,
    CC_SHELL_ESCAPED_FLAGS: "1",
    CARGO_PROFILE_RELEASE_DEBUG: "0",
    CARGO_PROFILE_RELEASE_INCREMENTAL: "false",
    // Cargo strips debug references during linking, before Mach-O signing.
    CARGO_PROFILE_RELEASE_STRIP: "debuginfo",
  },
});
if (cargo.error) throw cargo.error;
process.stderr.write(cargo.stderr);
const messages = cargo.stdout
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
for (const message of messages) {
  if (message.reason === "compiler-message" && message.message.rendered)
    process.stderr.write(message.message.rendered);
}
if (cargo.status !== 0) throw new Error("Native patch engine build failed");
const artifacts = messages
  .filter((message) => message.reason === "compiler-artifact")
  .map(({ package_id, manifest_path }) => ({ package_id, manifest_path }));
await writeFile(
  resolve(scratch, "apply-patch-artifacts.json"),
  JSON.stringify(artifacts, null, 2) + "\n",
);
const destination =
  crossMac || crossLinuxArm
    ? resolve(scratch, "bin/fungi-apply-patch")
    : resolve(runtimeRoot, "native/bin/fungi-apply-patch");
await mkdir(dirname(destination), { recursive: true });
const executable = messages.find(
  (message) =>
    message.reason === "compiler-artifact" &&
    message.target.name === "fungi-apply-patch" &&
    message.executable,
)?.executable;
if (!executable) throw new Error("Cargo did not report the patch executable");
await copyFile(executable, destination);
// Keep the cross-linker's Mach-O code signature intact; Linux strip cannot
// re-sign a Mach-O executable. Native Apple builds use Apple's strip.
if (!crossMac)
  run(crossLinuxArm ? "aarch64-linux-gnu-strip" : "strip", [
    process.platform === "darwin" ? "-x" : "--strip-unneeded",
    destination,
  ]);
await writeFile(
  resolve(dirname(destination), "build.json"),
  JSON.stringify(
    {
      platform,
      packages: await nativeNotices(artifacts, dirname(upstream)),
    },
    null,
    2,
  ) + "\n",
);
console.log(`Built pinned Codex patch engine: ${destination}`);
