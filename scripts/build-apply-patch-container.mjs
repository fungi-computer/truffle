import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";
import {
  installProofContainerTrap,
  proofNameLabel,
  proofOwnerPidLabel,
} from "../../../tooling/proof-containers/proof-janitor.mjs";

function run(command, args) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) accept();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
}

export async function buildPatchInContainer(platform) {
  const repository = fileURLToPath(new URL("../../../", import.meta.url));
  const context = resolve(
    repository,
    "runtimes/local/scripts",
    platform === "linux-x64"
      ? "native-linux"
      : platform === "linux-arm64"
        ? "native-linux-arm64"
        : "native-macos",
  );
  const digest = createHash("sha256")
    .update(await readFile(resolve(context, "Dockerfile")))
    .digest("hex");
  const image = `botanical-patch-${platform}:${digest.slice(0, 16)}`;
  const scratch = resolve(repository, ".botanical/native-build");
  const destination = resolve(repository, "runtimes/local/native/bin");
  await mkdir(scratch, { recursive: true });
  await mkdir(destination, { recursive: true });
  await run("docker", [
    "build",
    "--platform=linux/amd64",
    "-t",
    image,
    context,
  ]);
  const owner = installProofContainerTrap(`patch-${platform}`);
  try {
    await run("docker", [
      "run",
      "--rm",
      "--init",
      "--platform=linux/amd64",
      "--name",
      owner.workerName,
      "--label",
      `${proofOwnerPidLabel}=${owner.pid}`,
      "--label",
      `${proofNameLabel}=${owner.name}`,
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--mount",
      `type=bind,src=${resolve(repository, "runtimes/local/scripts")},dst=${resolve(repository, "runtimes/local/scripts")},readonly`,
      "--mount",
      `type=bind,src=${resolve(repository, "runtimes/local/native/apply-patch")},dst=${resolve(repository, "runtimes/local/native/apply-patch")},readonly`,
      "--mount",
      `type=bind,src=${scratch},dst=${scratch}`,
      "--mount",
      `type=bind,src=${destination},dst=${destination}`,
      "--mount",
      `type=bind,src=${process.execPath},dst=/usr/local/bin/node,readonly`,
      "--workdir",
      repository,
      "--env",
      "HOME=/tmp/patch-home",
      "--env",
      `CARGO_HOME=${scratch}/${platform === "linux-x64" ? "cargo-jammy" : `cargo-${platform}`}`,
      "--env",
      `CARGO_BUILD_JOBS=${process.env.CARGO_BUILD_JOBS ?? "4"}`,
      image,
      "node",
      "runtimes/local/scripts/build-apply-patch.mjs",
      "--target",
      platform,
      "--in-container",
    ]);
    await writeFile(
      resolve(
        scratch,
        platform === "linux-x64"
          ? "linux-builder.json"
          : `${platform}-builder.json`,
      ),
      JSON.stringify(
        {
          image,
          dockerfileSha256: digest,
          rust: "1.98.1",
          platform,
          glibc: platform.startsWith("linux-") ? "2.35" : undefined,
        },
        null,
        2,
      ) + "\n",
    );
  } finally {
    owner.cleanup();
  }
}
