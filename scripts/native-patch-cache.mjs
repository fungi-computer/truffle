import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { z } from "zod";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const versionSchema = z.string().regex(/^rust-v\d+\.\d+\.\d+$/u);
const targetSchema = z.enum([
  "linux-x64",
  "linux-arm64",
  "darwin-x64",
  "darwin-arm64",
]);
const pinSchema = z.object({
  version: versionSchema,
  sourceSha256: digestSchema,
});
const receiptSchema = z.strictObject({
  schemaVersion: z.literal(1),
  version: versionSchema,
  target: targetSchema,
  sourceSha256: digestSchema,
  wrapperSha256: digestSchema,
  binarySha256: digestSchema,
  noticesSha256: digestSchema,
});
const noticesSchema = z.object({
  platform: targetSchema,
  packages: z.array(
    z.object({ name: z.string().min(1), texts: z.array(z.string()) }),
  ),
});
function missing(cause) {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
async function digest(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/** One immutable artifact per Codex pin/target, shared by every checkout and updater. */
export async function ensureNativePatchArtifact({
  cacheRoot,
  pin: inputPin,
  target: inputTarget,
  wrapper,
  destination,
  build,
}) {
  const pin = pinSchema.parse(inputPin);
  const target = targetSchema.parse(inputTarget);
  const wrapperSha256 = await digest(wrapper);
  const key = join(cacheRoot, pin.version, target);
  const artifact = join(key, "artifact");
  await mkdir(key, { recursive: true, mode: 0o700 });
  async function published() {
    try {
      await stat(artifact);
    } catch (cause) {
      if (missing(cause)) return false;
      throw cause;
    }
    const receipt = receiptSchema.parse(
      JSON.parse(await readFile(join(artifact, "receipt.json"), "utf8")),
    );
    if (
      receipt.version !== pin.version ||
      receipt.target !== target ||
      receipt.sourceSha256 !== pin.sourceSha256 ||
      receipt.wrapperSha256 !== wrapperSha256
    )
      throw new Error(
        `Cached patch artifact does not match this pin or wrapper: ${artifact}. Use a new pin before rebuilding.`,
      );
    if (
      (await digest(join(artifact, "fungi-apply-patch"))) !==
        receipt.binarySha256 ||
      (await digest(join(artifact, "build.json"))) !== receipt.noticesSha256
    )
      throw new Error(
        `Cached patch artifact checksum mismatch: ${artifact}. The artifact was not used or rebuilt.`,
      );
    const notices = noticesSchema.parse(
      JSON.parse(await readFile(join(artifact, "build.json"), "utf8")),
    );
    if (notices.platform !== target)
      throw new Error("Cached patch notices do not match their target");
    return true;
  }
  async function restore(kind) {
    await mkdir(destination, { recursive: true });
    await copyFile(
      join(artifact, "fungi-apply-patch"),
      join(destination, "fungi-apply-patch"),
    );
    await copyFile(
      join(artifact, "build.json"),
      join(destination, "build.json"),
    );
    await chmod(join(destination, "fungi-apply-patch"), 0o755);
    return { kind, artifact };
  }
  if (await published()) return restore("hit");
  // Compilation runs in an asynchronous child, so the maintained lock heartbeat stays live.
  const release = await lockfile.lock(key, {
    stale: 120_000,
    update: 20_000,
    retries: { retries: 600, factor: 1.5, minTimeout: 50, maxTimeout: 1_000 },
  });
  let staging;
  try {
    if (await published()) return await restore("hit");
    await build();
    const notices = noticesSchema.parse(
      JSON.parse(await readFile(join(destination, "build.json"), "utf8")),
    );
    if (notices.platform !== target)
      throw new Error("Native build does not match the cache target");
    staging = await mkdtemp(join(key, "staging-"));
    await copyFile(
      join(destination, "fungi-apply-patch"),
      join(staging, "fungi-apply-patch"),
    );
    await copyFile(
      join(destination, "build.json"),
      join(staging, "build.json"),
    );
    await writeFile(
      join(staging, "receipt.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          version: pin.version,
          target,
          sourceSha256: pin.sourceSha256,
          wrapperSha256,
          binarySha256: await digest(join(staging, "fungi-apply-patch")),
          noticesSha256: await digest(join(staging, "build.json")),
        },
        null,
        2,
      ) + "\n",
      { mode: 0o600 },
    );
    await rename(staging, artifact);
    staging = undefined;
    return await restore("built");
  } finally {
    try {
      if (staging !== undefined)
        await rm(staging, { recursive: true, force: true });
    } finally {
      await release();
    }
  }
}
