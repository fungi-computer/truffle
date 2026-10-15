import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalSkillSource } from "../src/local-skill-source.js";

const directories: string[] = [];
const signal = new AbortController().signal;
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "local-skills-"));
  directories.push(root);
  const project = join(root, "project");
  const cwd = join(project, "child");
  const home = join(root, "home");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(cwd);
  await mkdir(home);
  return {
    root,
    project,
    cwd,
    home,
    source: createLocalSkillSource({ cwd, home }),
  };
}
async function skill(
  root: string,
  path: string,
  name: string,
  description: string,
  extra = "",
) {
  const directory = join(root, path, name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n${extra}---\n${description} body\n`,
  );
  return directory;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("Local SkillSource", () => {
  it("discovers Claude's nested synced layout only through the local settings opt-in", async () => {
    const { home, source } = await fixture();
    const nested = await skill(
      home,
      ".claude/skills/synced/source-target",
      "nested",
      "Synced skill",
    );
    await skill(
      nested,
      "references",
      "child",
      "Supporting skill is not discovered",
    );
    expect((await source.catalog(signal)).skills).toEqual([]);
    await mkdir(join(home, ".fungi"));
    await writeFile(
      join(home, ".fungi/settings.json"),
      JSON.stringify({ skills: ["~/.claude/skills"] }),
    );
    expect((await source.catalog(signal)).skills).toEqual([
      {
        name: "nested",
        description: "Synced skill",
        location: join(nested, "SKILL.md"),
      },
    ]);
    expect((await source.read("nested", undefined, signal)).content).toBe(
      "Synced skill body\n",
    );
  });

  it("discovers project and personal roots with project-first precedence and independent collisions", async () => {
    const { root, project, cwd, home, source } = await fixture();
    await skill(cwd, ".fungi/skills", "shared", "Fungi project wins");
    await skill(cwd, ".agents/skills", "shared", "Agents project loses");
    await skill(project, ".agents/skills", "ancestor", "Git ancestor");
    await skill(root, ".agents/skills", "outside", "Above git root");
    await skill(home, ".fungi/skills", "shared", "Personal loses");
    await skill(home, ".agents/skills", "personal", "Personal Agents");
    await skill(home, ".fungi/skills", "personal", "Personal Fungi wins");
    await skill(cwd, ".fungi/skills", "compat", "Project Fungi wins");
    await skill(home, ".fungi/skills", "compat", "Personal loses to project");
    await skill(cwd, ".pi/skills", "pi-project", "Project Pi");
    await skill(home, ".pi/skills", "pi-home", "Personal Pi");
    await skill(home, ".pi/agent/skills", "pi-agent", "Personal Pi agent");
    await skill(home, ".claude/skills", "claude-home", "Personal Claude");
    const catalog = await source.catalog(signal);
    expect(catalog.skills.find((s) => s.name === "shared")?.description).toBe(
      "Fungi project wins",
    );
    expect(catalog.skills.find((s) => s.name === "personal")?.description).toBe(
      "Personal Fungi wins",
    );
    expect(catalog.skills.find((s) => s.name === "compat")?.description).toBe(
      "Project Fungi wins",
    );
    expect(catalog.skills.map((s) => s.name)).toEqual(
      expect.arrayContaining(["ancestor"]),
    );
    expect(catalog.skills.map((s) => s.name)).not.toContain("outside");
    for (const excluded of ["pi-project", "pi-home", "pi-agent", "claude-home"])
      expect(catalog.skills.map((s) => s.name)).not.toContain(excluded);
    expect(
      catalog.diagnostics.filter((d) => d.reason === "collision"),
    ).toHaveLength(4);
    expect(catalog.diagnostics.every((d) => d.cause instanceof Error)).toBe(
      true,
    );
  });

  it("keeps names that violate the skill rules available, with warnings", async () => {
    const { cwd, source } = await fixture();
    const directory = await skill(
      cwd,
      ".agents/skills",
      "folder",
      "Usable description",
    );
    await writeFile(
      join(directory, "SKILL.md"),
      "---\nname: Bad--Name\ndescription: Usable description\n---\nLoadable body\n",
    );
    const catalog = await source.catalog(signal);
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["Bad--Name"]);
    expect(catalog.diagnostics).toContainEqual(
      expect.objectContaining({
        path: join(directory, "SKILL.md"),
        reason: "warning",
      }),
    );
    expect((await source.read("Bad--Name", undefined, signal)).content).toBe(
      "Loadable body\n",
    );
  });

  it("uses Pi's literal true flag for model invocation and reports hidden skills", async () => {
    const { cwd, source } = await fixture();
    await skill(
      cwd,
      ".fungi/skills",
      "quoted",
      "Still visible",
      "disable-model-invocation: 'false'\n",
    );
    const hidden = await skill(
      cwd,
      ".fungi/skills",
      "hidden",
      "Human only",
      "disable-model-invocation: true\n",
    );
    const catalog = await source.catalog(signal);
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["quoted"]);
    expect(catalog.diagnostics).toContainEqual(
      expect.objectContaining({
        path: join(hidden, "SKILL.md"),
        reason: "skipped",
        message: "Skill disables model invocation",
      }),
    );
  });

  it("preserves directory-default names and reports malformed UTF-8", async () => {
    const { cwd, source } = await fixture();
    const valid = await skill(cwd, ".agents/skills", "derived", "Default name");
    await writeFile(
      join(valid, "SKILL.md"),
      "---\ndescription: Default name\n---\nUnicode body: café\n",
    );
    const invalid = await skill(
      cwd,
      ".agents/skills",
      "invalid",
      "Invalid encoding",
    );
    await writeFile(
      join(invalid, "SKILL.md"),
      Buffer.concat([
        Buffer.from("---\nname: invalid\ndescription: Invalid encoding\n---\n"),
        Buffer.from([0xc3, 0x28]),
      ]),
    );
    await writeFile(join(valid, "bad.txt"), Buffer.from([0xff]));
    const catalog = await source.catalog(signal);
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["derived"]);
    expect(catalog.diagnostics).toContainEqual(
      expect.objectContaining({
        path: join(invalid, "SKILL.md"),
        reason: "invalid",
      }),
    );
    expect(
      catalog.diagnostics.find(
        (diagnostic) => diagnostic.path === join(invalid, "SKILL.md"),
      )?.cause,
    ).toBeInstanceOf(TypeError);
    expect((await source.read("derived", undefined, signal)).content).toBe(
      "Unicode body: café\n",
    );
    await expect(source.read("derived", "bad.txt", signal)).rejects.toThrow(
      TypeError,
    );
  });

  it("skips malformed frontmatter and escaped roots while loading healthy skills", async () => {
    const { cwd, home, source } = await fixture();
    const good = await skill(cwd, ".agents/skills", "good", "Valid skill");
    const bad = await skill(cwd, ".agents/skills", "bad", "7");
    const foreign = await skill(
      home,
      "foreign",
      "escaped",
      "Outside discovery root",
    );
    await symlink(foreign, join(cwd, ".agents/skills/escaped"));
    const catalog = await source.catalog(signal);
    expect(catalog.skills.map((s) => s.name)).toEqual(["good"]);
    expect(catalog.diagnostics.map((d) => d.path)).toContain(
      join(bad, "SKILL.md"),
    );
    expect(catalog.diagnostics).toHaveLength(2);
    await mkdir(join(good, "references"));
    await writeFile(join(good, "references/example.md"), "reference text");
    expect(await source.read("good", undefined, signal)).toEqual({
      name: "good",
      file: "SKILL.md",
      content: "Valid skill body\n",
      baseDirectory: good,
      supportingFiles: ["references/example.md"],
    });
    expect(
      (await source.read("good", "references/example.md", signal)).content,
    ).toBe("reference text");
    await symlink(join(foreign, "SKILL.md"), join(good, "escape.md"));
    await expect(source.read("good", "escape.md", signal)).rejects.toThrow(
      "escapes",
    );
    for (const file of [
      "../escaped/SKILL.md",
      "/etc/passwd",
      "references\\example.md",
      "a\0b",
    ])
      await expect(source.read("good", file, signal)).rejects.toThrow(
        "relative path",
      );
  });

  it("deduplicates canonical roots and keeps hidden project names hidden", async () => {
    const { cwd, home, source } = await fixture();
    await skill(
      cwd,
      ".fungi/skills",
      "hidden",
      "Hidden project",
      "disable-model-invocation: true\n",
    );
    await skill(home, ".agents/skills", "hidden", "Visible personal");
    await skill(cwd, ".fungi/skills", "visible", "Visible project");
    await mkdir(join(cwd, ".agents"));
    await symlink(join(cwd, ".fungi/skills"), join(cwd, ".agents/skills"));
    const catalog = await source.catalog(signal);
    expect(catalog.skills.map((s) => s.name)).toEqual(["visible"]);
    expect(
      catalog.diagnostics.filter((d) => d.reason === "collision"),
    ).toHaveLength(1);
    await expect(source.read("hidden", undefined, signal)).rejects.toThrow(
      "hidden",
    );
  });

  it("reports oversized skill files and metadata without exceeding catalog bounds", async () => {
    const { cwd, source } = await fixture();
    const oversized = await skill(
      cwd,
      ".agents/skills",
      "oversized",
      "Too big",
    );
    await writeFile(join(oversized, "SKILL.md"), "x".repeat(128 * 1_024 + 1));
    for (let n = 0; n < 65; n++)
      await skill(cwd, ".agents/skills", `skill-${String(n)}`, "Description");
    const catalog = await source.catalog(signal);
    expect(catalog.skills).toHaveLength(64);
    expect(catalog.diagnostics.map((d) => d.reason)).toEqual(
      expect.arrayContaining(["invalid", "bound"]),
    );
    expect(
      Buffer.byteLength(JSON.stringify(catalog.skills)),
    ).toBeLessThanOrEqual(16_000);
  });

  it("returns an empty catalog and respects cancellation", async () => {
    const { source } = await fixture();
    expect(await source.catalog(signal)).toEqual({
      skills: [],
      diagnostics: [],
    });
    await expect(
      source.catalog(AbortSignal.abort(new Error("Canceled skill scan"))),
    ).rejects.toThrow("Canceled skill scan");
  });

  it("reports an empty root separately from entries rejected for a missing description", async () => {
    const { cwd, source } = await fixture();
    const root = join(cwd, ".fungi/skills");
    await mkdir(root, { recursive: true });
    expect((await source.catalog(signal)).diagnostics).toContainEqual(
      expect.objectContaining({
        path: root,
        reason: "empty",
        message: "Skill root is empty",
      }),
    );
    const bad = await skill(cwd, ".fungi/skills", "blank", "'  '");
    const rejected = await source.catalog(signal);
    expect(rejected.skills).toEqual([]);
    expect(rejected.diagnostics).toContainEqual(
      expect.objectContaining({
        path: join(bad, "SKILL.md"),
        reason: "invalid",
        message: "description is required",
      }),
    );
    expect(
      rejected.diagnostics.some((diagnostic) => diagnostic.reason === "empty"),
    ).toBe(false);
  });

  it("keeps nested discovery bounded and contained while ignoring dot directories and dependencies", async () => {
    const { cwd, home, source } = await fixture();
    const root = join(cwd, ".fungi/skills");
    await skill(cwd, ".fungi/skills", "good", "Visible sibling");
    await skill(root, ".hidden", "hidden", "Dot directory");
    await skill(root, "node_modules", "dependency", "Dependency skill");
    await skill(
      root,
      Array.from({ length: 17 }, () => "deep").join("/"),
      "too-deep",
      "Beyond bound",
    );
    const outside = await skill(home, "foreign", "outside", "Outside root");
    await mkdir(join(root, "synced"));
    await symlink(outside, join(root, "synced/escape"));
    await symlink(root, join(root, "synced/cycle"));
    const catalog = await source.catalog(signal);
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(catalog.diagnostics).toContainEqual(
      expect.objectContaining({
        path: join(root, "synced/escape/SKILL.md"),
        reason: "invalid",
      }),
    );
    expect(catalog.diagnostics).toContainEqual(
      expect.objectContaining({
        reason: "bound",
        message: "Skill discovery exceeds its 16-level depth bound",
      }),
    );
    for (const path of [join(root, ".hidden"), join(root, "node_modules")])
      expect(catalog.diagnostics).toContainEqual(
        expect.objectContaining({ path, reason: "skipped" }),
      );
  });

  it("loads extra project folders relative to the project and diagnoses unavailable or invalid settings", async () => {
    const { cwd, home, source } = await fixture();
    const project = await skill(cwd, "extras", "shared", "Project extra wins");
    await skill(home, ".agents/skills", "shared", "Personal loses");
    await mkdir(join(cwd, ".fungi"));
    await writeFile(
      join(cwd, ".fungi/settings.json"),
      JSON.stringify({ skills: ["extras", "missing"] }),
    );
    const catalog = await source.catalog(signal);
    expect(catalog.skills[0]?.location).toBe(join(project, "SKILL.md"));
    expect(catalog.diagnostics).toContainEqual(
      expect.objectContaining({
        path: join(cwd, "missing"),
        reason: "unavailable",
      }),
    );
    await writeFile(
      join(cwd, ".fungi/settings.json"),
      JSON.stringify({ skills: 1 }),
    );
    expect((await source.catalog(signal)).diagnostics).toContainEqual(
      expect.objectContaining({
        path: join(cwd, ".fungi/settings.json"),
        reason: "invalid",
        message:
          "Local settings must be valid JSON with a skills list of extra folders",
      }),
    );
  });
});
