import { renameSync, symlinkSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalSkillSource } from "../src/local-skill-source.js";

/**
 * The skill reader runs on the host, unsandboxed, so it must keep what the
 * live sandbox hides from commands out of what it hands the model. These use
 * a dummy HOME whose `.config/fungi` stands in for Fungi's hidden records.
 */
const directories: string[] = [];
const signal = new AbortController().signal;

async function fixture(consulted: () => void = () => undefined) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skill-hidden-")));
  directories.push(root);
  const cwd = join(root, "project");
  const home = join(root, "home");
  const record = join(home, ".config", "fungi");
  await mkdir(join(cwd, ".git"), { recursive: true });
  await mkdir(record, { recursive: true });
  await writeFile(join(record, "token"), "dummy-hidden-credential");
  const hidden = [record, join(home, ".fungi", "service")];
  return {
    root,
    cwd,
    home,
    record,
    source: createLocalSkillSource({
      cwd,
      home,
      hidden: () => {
        consulted();
        return hidden;
      },
    }),
  };
}

async function skill(directory: string, name: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n---\n${name} body\n`,
  );
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Local SkillSource sandbox-hidden records", () => {
  it("refuses a supporting file whose folder is swapped for a hidden-record symlink after the containment check", async () => {
    // A read consults the hidden set twice: for its catalog, then after the
    // selected file's containment check and before open. The second call is
    // where a sandboxed command owning the project skill folder swaps it.
    let calls = 0;
    const swaps: (() => void)[] = [];
    const { cwd, record, source } = await fixture(() => {
      if (++calls === 2) swaps.shift()?.();
    });
    const directory = join(cwd, ".agents", "skills", "racer");
    await skill(directory, "racer");
    await mkdir(join(directory, "refs"));
    await writeFile(join(directory, "refs", "token"), "ordinary reference");
    swaps.push(() => {
      renameSync(join(directory, "refs"), join(directory, "refs-moved"));
      symlinkSync(record, join(directory, "refs"));
    });
    await expect(source.read("racer", "refs/token", signal)).rejects.toThrow(
      "Skill path changed while it was opened",
    );
    expect(calls).toBe(2);
  });

  it("ignores a project skill root that resolves outside the project", async () => {
    const { root, cwd, source } = await fixture();
    const outside = join(root, "outside");
    await skill(join(outside, "foreign"), "foreign");
    await mkdir(join(cwd, ".agents"));
    await symlink(outside, join(cwd, ".agents", "skills"));
    const catalog = await source.catalog(signal);
    expect(catalog.skills.map((item) => item.name)).not.toContain("foreign");
    expect(catalog.diagnostics).toContainEqual(
      expect.objectContaining({
        path: join(cwd, ".agents", "skills"),
        reason: "invalid",
      }),
    );
    await expect(source.read("foreign", undefined, signal)).rejects.toThrow(
      "Unknown or hidden skill",
    );
  });

  it("refuses skills inside, or roots covering, a sandbox-hidden record", async () => {
    const { home, record, source } = await fixture();
    await skill(join(record, "skills", "inside"), "inside");
    await skill(join(home, ".config", "nested", "covering"), "covering");
    await mkdir(join(home, ".fungi"));
    await writeFile(
      join(home, ".fungi", "settings.json"),
      JSON.stringify({
        skills: ["~/.config/fungi/skills", "~/.config"],
      }),
    );
    const catalog = await source.catalog(signal);
    expect(catalog.skills.map((item) => item.name)).toEqual([]);
    for (const path of [join(record, "skills"), join(home, ".config")])
      expect(catalog.diagnostics).toContainEqual(
        expect.objectContaining({ path, reason: "invalid" }),
      );
    await expect(source.read("inside", undefined, signal)).rejects.toThrow(
      "Unknown or hidden skill",
    );
  });
});
