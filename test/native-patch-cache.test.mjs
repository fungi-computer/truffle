import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ensureNativePatchArtifact } from "../scripts/native-patch-cache.mjs";

const fixtures = [];
afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "native-patch-cache-"));
  fixtures.push(root);
  const wrapper = join(root, "main.rs");
  await writeFile(wrapper, "pinned wrapper");
  return {
    cacheRoot: join(root, "cache"),
    root,
    wrapper,
    pin: { version: "rust-v0.154.0", sourceSha256: "a".repeat(64) },
    target: "linux-x64",
  };
}
async function compiler(destination, target) {
  await mkdir(destination, { recursive: true });
  await writeFile(
    join(destination, "fungi-apply-patch"),
    "native patch fixture\n",
  );
  await writeFile(
    join(destination, "build.json"),
    JSON.stringify({
      platform: target,
      packages: [{ name: "codex-apply-patch", texts: ["upstream license"] }],
    }),
  );
}
it("builds a pin/target once and restores binary plus notices into a different update checkout", async () => {
  const options = await fixture();
  const first = join(options.root, "checkout-a/native/bin");
  const second = join(options.root, "checkout-b/native/bin");
  await ensureNativePatchArtifact({
    ...options,
    destination: first,
    build: () => compiler(first, options.target),
  });
  const hit = await ensureNativePatchArtifact({
    ...options,
    destination: second,
    build: () => {
      throw new Error("A cached native artifact must not compile again");
    },
  });
  expect(hit.kind).toBe("hit");
  expect(await readFile(join(second, "fungi-apply-patch"), "utf8")).toBe(
    "native patch fixture\n",
  );
  expect(await readFile(join(second, "build.json"), "utf8")).toBe(
    await readFile(join(first, "build.json"), "utf8"),
  );
});
it("serializes concurrent cache misses so only one compiler runs", async () => {
  const options = await fixture();
  let builds = 0;
  await Promise.all(
    ["first", "second"].map((name) => {
      const destination = join(options.root, name);
      return ensureNativePatchArtifact({
        ...options,
        destination,
        build: async () => {
          builds++;
          await compiler(destination, options.target);
        },
      });
    }),
  );
  expect(builds).toBe(1);
});
it("builds a new pin or target without reusing another key", async () => {
  const options = await fixture();
  let builds = 0;
  for (const [version, target] of [
    ["rust-v0.154.0", "linux-x64"],
    ["rust-v0.155.0", "linux-x64"],
    ["rust-v0.154.0", "darwin-arm64"],
  ]) {
    const destination = join(options.root, version, target);
    await ensureNativePatchArtifact({
      ...options,
      pin: { ...options.pin, version },
      target,
      destination,
      build: async () => {
        builds++;
        await compiler(destination, target);
      },
    });
  }
  expect(builds).toBe(3);
});
it("refuses a corrupt binary or changed wrapper instead of silently reusing or rebuilding it", async () => {
  const options = await fixture();
  const destination = join(options.root, "native/bin");
  const built = await ensureNativePatchArtifact({
    ...options,
    destination,
    build: () => compiler(destination, options.target),
  });
  const reuse = () =>
    ensureNativePatchArtifact({
      ...options,
      destination,
      build: () => {
        throw new Error("Corrupt artifacts must be refused");
      },
    });
  await writeFile(join(built.artifact, "fungi-apply-patch"), "corrupted");
  await expect(reuse()).rejects.toThrow("checksum");
  await writeFile(
    join(built.artifact, "fungi-apply-patch"),
    "native patch fixture\n",
  );
  await writeFile(options.wrapper, "changed wrapper");
  await expect(reuse()).rejects.toThrow("does not match");
});
