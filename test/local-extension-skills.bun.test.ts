import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalExtensionError,
  localExtensions,
  type LocalExtensions,
} from "../src/local-extensions.js";
import { createLocalSkillSource } from "../src/local-skill-source.js";

/**
 * Installed extensions bring skills: read in place from the package, only
 * while an Agent opts in. Local installed extensions only.
 */

let scratch: string;
let home: string;
let project: string;
let agent: string;
let owner: LocalExtensions;
const signal = new AbortController().signal;

function git(cwd: string, ...args: string[]) {
  return execFileSync(
    "git",
    ["-c", "user.email=fixture@fungi.test", "-c", "user.name=Fixture", ...args],
    { cwd, encoding: "utf8" },
  ).trim();
}

/** A disposable Git source: write the package, commit it, serve it bare. */
async function publish(
  id: string,
  fungi: Readonly<{ skills?: string; capabilities?: readonly string[] }>,
  prepare: (work: string) => void | Promise<void>,
  exports: Readonly<Record<string, string>> = {},
) {
  const work = join(scratch, `${id}-source`);
  const bare = join(scratch, `${id}.git`);
  await mkdir(work, { recursive: true });
  await writeFile(
    join(work, "package.json"),
    `${JSON.stringify({ name: `fungi-${id}`, version: "1.0.0", private: true, type: "module", exports, fungi: { id, ...fungi } })}\n`,
  );
  await prepare(work);
  git(scratch, "init", "-q", "--bare", "-b", "main", bare);
  git(work, "init", "-q", "-b", "main");
  git(work, "add", "-A");
  git(work, "commit", "-qm", id);
  git(work, "push", "-q", bare, "HEAD:main");
  return `git+file://${bare}#main`;
}

async function skillFile(work: string, name: string) {
  const directory = join(work, "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} from the package\n---\nBody of ${name}\n`,
  );
}

async function names(
  skills: Awaited<ReturnType<LocalExtensions["agent"]>>["skills"],
) {
  const source = createLocalSkillSource({
    cwd: project,
    home,
    extensions: skills,
  });
  return (await source.catalog(signal)).skills.map((skill) => skill.name);
}

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "fungi-ext-skills-")));
  home = join(scratch, "home");
  project = join(scratch, "project");
  agent = join(project, ".fungi", "agents", "local_store");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(agent, { recursive: true }),
    // Skill discovery stops at a repository marker, not at mkdtemp's root.
    // Keep a repo-local TMPDIR from contributing the checkout's own skills.
    mkdir(join(project, ".git"), { recursive: true }),
  ]);
  const ambient = join(scratch, ".agents", "skills", "ambient-fixture");
  await mkdir(ambient, { recursive: true });
  await writeFile(
    join(ambient, "SKILL.md"),
    "---\nname: ambient-fixture\ndescription: Must not enter the fixture project\n---\nOutside the test project.\n",
  );
  owner = localExtensions({ home });
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

test("a skills-only extension with no ./host is optional, then switches off and uninstalls with the extension", async () => {
  const source = await publish(
    "acme-tools",
    { skills: "./skills" },
    async (work) => {
      await skillFile(work, "greeter");
      await skillFile(work, "closer");
    },
  );
  const installed = await owner.add(source);
  expect([...installed.skills].sort()).toEqual(["closer", "greeter"]);
  expect(installed.capabilities).toEqual([]);

  // Optional: installed, but no Agent opted in.
  expect((await owner.agent(agent, project)).skills).toEqual([]);
  expect(await names((await owner.agent(agent, project)).skills)).toEqual([]);

  // Turning it on contributes the folder, read in place from the package.
  await owner.enableAgentSkills(agent, "acme-tools");
  const on = await owner.agent(agent, project);
  expect(on.diagnostics).toEqual([]);
  expect(on.roster).toEqual([]);
  expect(on.skills).toHaveLength(1);
  expect(on.skills[0]?.extensionId).toBe("acme-tools");
  expect(
    on.skills[0]?.directory.startsWith(
      join(owner.root, "packages", "acme-tools"),
    ),
  ).toBe(true);
  expect((await names(on.skills)).sort()).toEqual(["closer", "greeter"]);

  // Switching the skills off removes them.
  expect(await owner.disableAgentSkills(agent, "acme-tools")).toBe(true);
  expect((await owner.agent(agent, project)).skills).toEqual([]);

  // Disabling the extension for the Agent removes them too.
  await owner.enableAgentSkills(agent, "acme-tools");
  expect(await owner.disableAgent(agent, "acme-tools")).toBe(true);
  expect((await owner.agent(agent, project)).skills).toEqual([]);

  // Uninstalling removes them, with no dangling folder.
  await owner.enableAgentSkills(agent, "acme-tools");
  const [folder] = (await owner.agent(agent, project)).skills;
  expect(await owner.remove("acme-tools")).toBe(true);
  expect((await owner.agent(agent, project)).skills).toEqual([]);
  expect(
    await access(folder?.directory ?? "").catch((cause: unknown) => cause),
  ).toBeInstanceOf(Error);
});

test("skills source reads from its selected home after ambient HOME changes", async () => {
  const ambientHome = join(scratch, "other-home");
  await mkdir(join(ambientHome, ".agents", "skills", "ambient"), {
    recursive: true,
  });
  await writeFile(
    join(ambientHome, ".agents", "skills", "ambient", "SKILL.md"),
    "---\nname: ambient\ndescription: Ambient home\n---\nAmbient body\n",
  );
  const previous = process.env.HOME;
  try {
    process.env.HOME = ambientHome;
    const source = createLocalSkillSource({ cwd: project, home });
    expect(
      (await source.catalog(signal)).skills.map((skill) => skill.name),
    ).not.toContain("ambient");
    const selected = join(home, ".agents", "skills", "selected");
    await mkdir(selected, { recursive: true });
    await writeFile(
      join(selected, "SKILL.md"),
      "---\nname: selected\ndescription: Selected home\n---\nSelected body\n",
    );
    expect((await source.read("selected", undefined, signal)).content).toBe(
      "Selected body\n",
    );
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
});

test("an extension that ships no skills refuses the skills opt-in", async () => {
  const source = await publish("plain", {}, () => undefined);
  await owner.add(source);
  const refusal = await owner
    .enableAgentSkills(agent, "plain")
    .catch((cause: unknown) => cause);
  expect(refusal).toBeInstanceOf(LocalExtensionError);
  expect(refusal).toMatchObject({ reason: "no-skills" });
  await owner.remove("plain");
});

test("Install-path containment: a skills path that escapes the package is refused at install", async () => {
  const dotdot = await publish(
    "escape-dotdot",
    { skills: "./../elsewhere" },
    () => undefined,
  );
  const refusal = await owner.add(dotdot).catch((cause: unknown) => cause);
  expect(refusal).toBeInstanceOf(LocalExtensionError);
  expect(refusal).toMatchObject({ reason: "manifest" });

  const outside = join(scratch, "outside-skills");
  await mkdir(join(outside, "stolen"), { recursive: true });
  await writeFile(
    join(outside, "stolen", "SKILL.md"),
    "---\nname: stolen\ndescription: not yours\n---\nsecret\n",
  );
  const linked = await publish(
    "escape-link",
    { skills: "./skills" },
    async (work) => {
      await symlink(outside, join(work, "skills"));
    },
  );
  // Bun may drop or keep the link; either way the package is refused.
  const linkedRefusal = await owner
    .add(linked)
    .catch((cause: unknown) => cause);
  expect(linkedRefusal).toBeInstanceOf(LocalExtensionError);
  expect(await owner.list()).toEqual([]);
});

test("Opting into an extension's skills is not holding its tools: a skills-only Agent cannot give the tools to another Agent", async () => {
  const source = await publish(
    "toolbox",
    { skills: "./skills", capabilities: ["run_tools"] },
    async (work) => {
      await skillFile(work, "helper");
      await copyFile(
        join(import.meta.dir, "fixtures", "extension-counter", "host.mjs"),
        join(work, "host.mjs"),
      );
    },
    { "./host": "./host.mjs" },
  );
  await owner.add(source);
  const target = join(project, ".fungi", "agents", "local_store_target");
  await mkdir(target, { recursive: true });

  // The requester opted into the skills only; it holds no tools.
  await owner.enableAgentSkills(agent, "toolbox");
  const refusal = await owner
    .enableAgent(target, "toolbox", { agentStoreDirectory: agent })
    .catch((cause: unknown) => cause);
  expect(refusal).toBeInstanceOf(LocalExtensionError);
  expect(refusal).toMatchObject({ reason: "not-held" });
  const ceiling = await owner
    .assertHeldByAgent(agent, ["toolbox"])
    .catch((cause: unknown) => cause);
  expect(ceiling).toMatchObject({ reason: "not-held" });
  expect((await owner.agent(target, project)).roster).toEqual([]);

  // Once it holds the tools too, it can pass them down.
  await owner.enableAgent(agent, "toolbox");
  await owner.assertHeldByAgent(agent, ["toolbox"]);
  await owner.enableAgent(target, "toolbox", { agentStoreDirectory: agent });
  await owner.remove("toolbox");
});

test("An activations record from before the skills field says to delete it and re-enable", async () => {
  const old = await mkdtemp(join(scratch, "old-activations-"));
  const directory = join(old, ".fungi", "extensions");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "activations.json");
  await writeFile(
    path,
    JSON.stringify({
      projects: {},
      agents: {
        store: { old: { revision: "r1", capabilities: ["run_tools"] } },
      },
    }),
  );
  const refusal = await localExtensions({ home: old })
    .assertHeldByAgent(agent, ["old"])
    .catch((cause: unknown) => cause);
  expect(refusal).toBeInstanceOf(LocalExtensionError);
  expect(refusal instanceof Error && refusal.message).toContain(
    `${path} is from an earlier extension format; delete it, then re-enable your extensions`,
  );
});
