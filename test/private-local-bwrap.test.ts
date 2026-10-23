import { createHash } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  localLinuxSandboxPayload,
  verifyLocalLinuxSandboxPayload,
} from "../src/private-local-bwrap.js";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
it("missing optional native package refuses without falling back to PATH", async () => {
  const executable = await fixture();
  await writeFile(join(dirname(executable), "bwrap"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  vi.stubEnv("FUNGI_BUNDLED_CLI", join(dirname(executable), "cli.cjs"));
  vi.stubEnv("PATH", dirname(executable));
  expect(() => localLinuxSandboxPayload()).toThrow(
    "optional dependencies enabled",
  );
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bwrap-digest-"));
  roots.push(root);
  const executable = join(root, "fungi-bwrap");
  // These are digest fixtures, not a bubblewrap implementation or isolation proof.
  const bytes = "#!/bin/sh\nexit 0\n";
  await writeFile(executable, bytes, { mode: 0o700 });
  await writeFile(
    `${executable}.sha256`,
    `${createHash("sha256").update(bytes).digest("hex")}\n`,
  );
  const filter = join(root, "fungi-seccomp.bpf");
  await writeFile(filter, "FILTER_DIGEST_FIXTURE");
  await writeFile(
    `${filter}.sha256`,
    `${createHash("sha256").update("FILTER_DIGEST_FIXTURE").digest("hex")}\n`,
  );
  return executable;
}

it("accepts matching executable bytes, then rejects a changed byte without caching", async () => {
  const executable = await fixture();
  expect(verifyLocalLinuxSandboxPayload(executable).executable).toBe(
    executable,
  );
  await writeFile(executable, "#!/bin/sh\nexit 1\n");
  expect(() => verifyLocalLinuxSandboxPayload(executable)).toThrow(
    "digest mismatch",
  );
});
it("requires the digest record and refuses malformed records", async () => {
  const executable = await fixture();
  await rm(`${executable}.sha256`);
  expect(() => verifyLocalLinuxSandboxPayload(executable)).toThrow(
    "digest is missing",
  );
  await writeFile(`${executable}.sha256`, "not a digest");
  expect(() => verifyLocalLinuxSandboxPayload(executable)).toThrow(
    "invalid SHA-256",
  );
});
it("refuses a missing binary and matching bytes without execute permission", async () => {
  const executable = await fixture();
  await chmod(executable, 0o600);
  expect(() => verifyLocalLinuxSandboxPayload(executable)).toThrow(
    "cannot be executed",
  );
  await rm(executable);
  expect(() => verifyLocalLinuxSandboxPayload(executable)).toThrow(
    "is missing",
  );
});

it("refuses missing or changed seccomp bytes with a typed artifact reason", async () => {
  const executable = await fixture();
  const filter = join(dirname(executable), "fungi-seccomp.bpf");
  await writeFile(filter, "changed filter");
  expect(() => verifyLocalLinuxSandboxPayload(executable)).toThrow(
    expect.objectContaining({
      name: "LocalBwrapUnavailable",
      reason: "digest-mismatch",
    }),
  );
  await rm(filter);
  expect(() => verifyLocalLinuxSandboxPayload(executable)).toThrow(
    expect.objectContaining({
      name: "LocalBwrapUnavailable",
      reason: "missing",
    }),
  );
});
