import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

import { ensurePrivateLocalGitExclude } from "../src/private-local-git-exclude.js";

const execFile = promisify(execFileCallback);

it("excludes project-local Fungi state through the shared Git common directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-git-exclude-"));
  const main = join(root, "main");
  const linked = join(root, "linked");
  try {
    await mkdir(main);
    await execFile("git", ["init", "-q", main]);
    await writeFile(join(main, "tracked.txt"), "fixture\n");
    await execFile("git", ["-C", main, "add", "tracked.txt"]);
    await execFile("git", [
      "-C",
      main,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "-qm",
      "fixture",
    ]);
    await execFile("git", [
      "-C",
      main,
      "worktree",
      "add",
      "-qb",
      "linked",
      linked,
    ]);
    await mkdir(join(linked, ".fungi"));
    await writeFile(join(linked, ".fungi", "agent.sqlite"), "fixture");
    expect(
      (await execFile("git", ["-C", linked, "status", "--short"])).stdout,
    ).toContain("?? .fungi/");

    await ensurePrivateLocalGitExclude(linked);
    await ensurePrivateLocalGitExclude(linked);
    const common = (
      await execFile("git", ["-C", linked, "rev-parse", "--git-common-dir"])
    ).stdout.trim();
    const exclude = await readFile(
      join(resolve(linked, common), "info", "exclude"),
      "utf8",
    );
    expect(
      exclude.split(/\r?\n/u).filter((line) => line === ".fungi/"),
    ).toHaveLength(1);
    expect(
      (await execFile("git", ["-C", linked, "status", "--short"])).stdout,
    ).toBe("");
    await expect(
      readFile(join(main, ".gitignore"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("leaves a non-Git project alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-non-git-exclude-"));
  try {
    await expect(ensurePrivateLocalGitExclude(root)).resolves.toBeUndefined();
    await expect(
      readFile(join(root, ".gitignore"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("does not append to another repository's exclude through a planted pointer", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-exclude-redirect-"));
  try {
    const agent = join(root, "agent");
    const victim = join(root, "victim");
    await mkdir(agent);
    await execFile("git", ["init", "-q", victim], {
      env: { ...process.env, HEAVY: "/nonexistent" },
    });
    const exclude = join(victim, ".git", "info", "exclude");
    const before = await readFile(exclude, "utf8");
    await writeFile(join(agent, ".git"), `gitdir: ${join(victim, ".git")}\n`);
    await ensurePrivateLocalGitExclude(agent);
    expect(await readFile(exclude, "utf8")).toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
