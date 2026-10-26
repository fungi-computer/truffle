import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import process from "node:process";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const local = resolve(repository, "runtimes/local");
const host = `${process.platform}-${process.arch}`;
const platforms = process.argv.includes("--cross")
  ? ["linux-x64", "linux-arm64", "darwin-arm64", "darwin-x64"]
  : [host];
const digests = {};
for (const platform of platforms) {
  const root =
    platform === host
      ? resolve(local, "native/bin")
      : resolve(repository, `.botanical/native-build/${platform}/bin`);
  let patch;
  try {
    patch = await readFile(resolve(root, "fungi-apply-patch"));
  } catch (cause) {
    if (
      platform !== host &&
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ENOENT"
    )
      continue;
    throw cause;
  }
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const entry = { patch: digest(patch) };
  if (platform.startsWith("linux-")) {
    entry.bwrap = digest(await readFile(resolve(root, "fungi-bwrap")));
    entry.seccomp = digest(await readFile(resolve(root, "fungi-seccomp.bpf")));
    entry.seccompWorkspace = digest(
      await readFile(resolve(root, "fungi-seccomp-workspace.bpf")),
    );
  }
  digests[platform] = entry;
}
const module = `// Generated from native build output; not a runtime sidecar.\nexport const nativeDigests = Object.freeze(${JSON.stringify(digests)});\n`;
const output = resolve(local, "src/private-local-native-digests.js");
if (process.argv.includes("--verify")) {
  const { nativeDigests } = await import(output);
  if (JSON.stringify(nativeDigests[host]) !== JSON.stringify(digests[host]))
    throw new Error(
      "Built native digests differ from native/bin; run build:native",
    );
} else {
  await writeFile(output, module);
}
