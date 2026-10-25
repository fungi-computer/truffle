import { createHash } from "node:crypto";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  localLinuxSandboxPayload,
  verifyLocalLinuxSandboxPayload,
} from "../src/private-local-bwrap.js";
import { sandboxPolicy } from "../src/private-local-sandbox-policy.js";

const original = "#!/bin/sh\nexit 0\n";
const filterBytes = "FILTER_DIGEST_FIXTURE";
const expected = {
  bwrap: createHash("sha256").update(original).digest("hex"),
  seccomp: createHash("sha256").update(filterBytes).digest("hex"),
};
const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bwrap-digest-"));
  roots.push(root);
  const project = join(root, "project");
  const bin = join(root, "install");
  await mkdir(join(project, "docs"), { recursive: true });
  await mkdir(bin);
  const executable = join(bin, "fungi-bwrap");
  await writeFile(executable, original, { mode: 0o700 });
  await writeFile(join(bin, "fungi-seccomp.bpf"), filterBytes);
  return { root, project, executable, bin };
}

function policy(project: string) {
  return sandboxPolicy(project, join(project, "docs"));
}

it("missing optional package refuses without a PATH fallback", async () => {
  const { executable, project, bin } = await fixture();
  await writeFile(join(bin, "bwrap"), original, { mode: 0o700 });
  vi.stubEnv("FUNGI_BUNDLED_CLI", join(bin, "cli.cjs"));
  vi.stubEnv("PATH", bin);
  expect(() => localLinuxSandboxPayload(policy(project))).toThrow(
    "optional dependencies enabled",
  );
  expect(executable).toContain("fungi-bwrap");
});

it("uses built digests rather than sidecars and returns exactly verified bytes", async () => {
  const { executable, project } = await fixture();
  expect(
    verifyLocalLinuxSandboxPayload(executable, policy(project), expected)
      .executableBytes,
  ).toEqual(Buffer.from(original));
  await writeFile(executable, "#!/bin/sh\nexit 1\n");
  expect(() =>
    verifyLocalLinuxSandboxPayload(executable, policy(project), expected),
  ).toThrow("digest mismatch");
});

it("rejects a launcher in a sibling Agent folder, even if selected folder is docs", async () => {
  const { executable, project } = await fixture();
  const sibling = join(project, "other-agent");
  await mkdir(sibling);
  await link(executable, join(sibling, "fungi-bwrap"));
  expect(() =>
    verifyLocalLinuxSandboxPayload(
      join(sibling, "fungi-bwrap"),
      policy(project),
      expected,
    ),
  ).toThrow(/Agent project/);
});

it("rejects host launcher and its old sidecar rewritten through Agent hardlinks before any execution", async () => {
  const { executable, project } = await fixture();
  const agent = join(project, "docs");
  const attackerBinary = join(agent, "fungi-bwrap");
  const attackerDigest = join(agent, "fungi-bwrap.sha256");
  await link(executable, attackerBinary);
  await writeFile(`${executable}.sha256`, expected.bwrap);
  await link(`${executable}.sha256`, attackerDigest);
  const altered = "BENIGN_CHANGED_BYTES_NEVER_EXECUTED";
  await writeFile(attackerBinary, altered);
  await writeFile(
    attackerDigest,
    createHash("sha256").update(altered).digest("hex"),
  );
  expect(() =>
    verifyLocalLinuxSandboxPayload(executable, policy(project), expected),
  ).toThrow(/digest mismatch/);
});

it("refuses symlinked filter inside project and inside external Git administration", async () => {
  const { executable, project, bin, root } = await fixture();
  const filter = join(bin, "fungi-seccomp.bpf");
  await rm(filter);
  await writeFile(join(project, "docs", "filter"), filterBytes);
  await symlink(join(project, "docs", "filter"), filter);
  expect(() =>
    verifyLocalLinuxSandboxPayload(executable, policy(project), expected),
  ).toThrow(/Agent project/);
  await rm(filter);
  const admin = join(root, "bare-repository");
  await mkdir(join(admin, "objects"), { recursive: true });
  await writeFile(join(admin, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(admin, "filter"), filterBytes);
  await symlink(join(admin, "filter"), filter);
  expect(() =>
    verifyLocalLinuxSandboxPayload(executable, policy(project), expected),
  ).toThrow(/Git-admin/);
});

it("uses readable installed bytes without their execute bit, but refuses missing artifacts", async () => {
  const { executable, project, bin } = await fixture();
  await chmod(executable, 0o600);
  expect(
    verifyLocalLinuxSandboxPayload(executable, policy(project), expected)
      .executableBytes,
  ).toEqual(Buffer.from(original));
  await rm(executable);
  expect(() =>
    verifyLocalLinuxSandboxPayload(executable, policy(project), expected),
  ).toThrow("is missing");
  await writeFile(executable, original, { mode: 0o700 });
  await rm(join(bin, "fungi-seccomp.bpf"));
  expect(() =>
    verifyLocalLinuxSandboxPayload(executable, policy(project), expected),
  ).toThrow("is missing");
});

it("refuses changed filter bytes with typed artifact reason", async () => {
  const { executable, project, bin } = await fixture();
  await writeFile(join(bin, "fungi-seccomp.bpf"), "changed filter");
  expect(() =>
    verifyLocalLinuxSandboxPayload(executable, policy(project), expected),
  ).toThrow(
    expect.objectContaining({
      name: "LocalBwrapUnavailable",
      reason: "digest-mismatch",
    }),
  );
});
