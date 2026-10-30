import { execFile as execFileCallback } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";
import {
  localExecRules,
  manageLocalExecRules,
  rulePrefix,
} from "../src/private-local-exec-rules.js";
import {
  createPrivateInvocationComputer,
  dispatchApprovedLocalExec,
  shellOutput,
} from "../src/private-invocation-computer.js";
import { createPrivateLocalComputerProcesses } from "../src/private-local-computer-processes.js";
import {
  resolveAgentFolder,
  gitDirectories,
  protectedGitRemoteNames,
  sandboxPolicy,
} from "../src/private-local-sandbox-policy.js";

const execFile = promisify(execFileCallback);
const cleanups: (() => Promise<void>)[] = [];
it("Git discovery uses the first executable on the command PATH, not a later safe Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-git-path-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await execFile("git", ["init", "-q", root]);
  const earlier = join(root, "bin");
  await mkdir(earlier);
  await symlink("/usr/bin/git", join(earlier, "git"));
  expect(
    gitDirectories(root, root, `${earlier}:/usr/bin:/bin`),
  ).toBeUndefined();
  expect(gitDirectories(root, root, "/usr/bin:/bin")?.common).toBe(
    join(root, ".git"),
  );
});
it.runIf(process.platform === "linux")(
  "reads configured names only from protected common Git config, not included worktree files",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-rule-config-remotes-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await execFile("git", ["init", "-q", root]);
    await execFile("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "https://example.test/repository",
    ]);
    await writeFile(
      join(root, "untrusted.conf"),
      '[remote "attacker"]\n\turl = ./bare\n',
    );
    await execFile("git", [
      "-C",
      root,
      "config",
      "--local",
      "include.path",
      "../untrusted.conf",
    ]);
    const git = gitDirectories(root, root, "/usr/bin:/bin");
    if (git === undefined) throw new Error("Protected repository not found");
    const names = protectedGitRemoteNames(root, git.common, "/usr/bin:/bin");
    expect(names).toEqual(new Set(["origin"]));
    const rules = localExecRules(root);
    rules.add(["git", "push"]);
    expect(rules.matches(["git", "push", "origin", "main"], names)).toBe(true);
    expect(rules.matches(["git", "push", "attacker", "main"], names)).toBe(
      false,
    );
  },
);
it.each([
  ["git", "-c", "core.sshCommand=curl evil", "fetch"],
  ["git", "-c", "alias.x=!sh -c id", "x"],
  ["git", "-C", "/other/repo", "status"],
  ["git", "--exec-path=/tmp/evil", "status"],
])("does not derive a misleading git option prefix from %j", (...argv) => {
  expect(rulePrefix(argv)).toBeUndefined();
});
it("also refuses a git global option when the binary uses an absolute path", () => {
  expect(
    rulePrefix(["/usr/bin/git", "-c", "alias.x=!sh -c id", "x"]),
  ).toBeUndefined();
});
it.each(["config", "init", "rebase"])(
  "never offers or stores a grant for git %s",
  (subcommand) => {
    expect(rulePrefix(["git", subcommand])).toBeUndefined();
    const root = join(tmpdir(), "nonexistent-rule-test");
    expect(() => {
      localExecRules(root).add(["git", subcommand]);
    }).toThrow("Unsafe Always-allow prefix");
  },
);
it("an Agent-written ./git binary cannot inherit a Git grant", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-rule-relative-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const rules = localExecRules(root);
  rules.add(["git", "status"]);
  expect(rulePrefix(["./git", "status"])).toBeUndefined();
  expect(rules.matches(["./git", "status"])).toBe(false);
  expect(() => {
    rules.add(["./git", "status"]);
  }).toThrow();
});
it.each([
  ["push", "--receive-pack=sh", "origin"],
  ["push", "--receive-pack", "sh", "origin"],
  ["fetch", "--upload-pack=sh", "origin"],
  ["pull", "--upload-pack", "sh", "origin"],
  ["log", "--output=/tmp/escape"],
  ["show", "-o", "/tmp/escape"],
  ["diff", "-o/tmp/escape"],
  ["diff", "--ext-diff"],
  ["commit", "--template=/tmp/escape"],
  ["commit", "--config-env=foo=BAR"],
  ["push", "./bare"],
  ["push", "/tmp/bare"],
  ["fetch", "../bare"],
  ["pull", "./bare"],
])("a Git grant refuses unsafe argv %j", async (...args) => {
  const root = await mkdtemp(join(tmpdir(), "fungi-rule-options-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const [subcommand] = args;
  const rules = localExecRules(root);
  rules.add(["git", subcommand]);
  expect(rules.matches(["git", ...args])).toBe(false);
});
it("a Git remote may be a named remote or a URL with a scheme", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-rule-remotes-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const rules = localExecRules(root);
  rules.add(["git", "push"]);
  expect(
    rules.matches(["git", "push", "-u", "origin", "main"], new Set(["origin"])),
  ).toBe(true);
  expect(rules.matches(["git", "push", "https://example.test/repo"])).toBe(
    true,
  );
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("narrow git grants cannot be widened by options, aliases or arbitrary git commands", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-rule-narrow-"));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const rules = localExecRules(root);
  rules.add(["git", "push"]);
  for (const argv of [
    ["git", "-c", "core.sshCommand=sh -c id", "push"],
    ["git", "-c", "alias.x=!sh -c id", "x"],
    ["git", "-C", "/other/repo", "push"],
    ["git", "--exec-path=/tmp/evil", "push"],
    ["git", "--exec-path", "/tmp/evil", "push"],
  ])
    expect(rules.matches(argv)).toBe(false);
  expect(() => {
    rules.add(["git"]);
  }).toThrow();
  expect(() => {
    rules.add(["git", "x"]);
  }).toThrow();
  expect(() => {
    rules.add(["/usr/bin/git"]);
  }).toThrow();
  expect(() => {
    rules.add(["/usr/bin/git", "x"]);
  }).toThrow();
  expect(rulePrefix(["git", "x"])).toBeUndefined();
  expect(
    rules.matches(["git", "push", "origin", "main"], new Set(["origin"])),
  ).toBe(true);
});

it("one project store shares non-Git grants across Agents without creating a SQLite table", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-rule-shared-"));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  localExecRules(root).add(["pnpm", "install"]);
  const stored = z
    .strictObject({
      version: z.literal(2),
      rules: z.array(
        z.strictObject({
          id: z.string().regex(/^local_exec_rule_[a-z0-9]{21}$/u),
          prefix: z.array(z.string()),
        }),
      ),
    })
    .parse(
      JSON.parse(
        await readFile(join(root, ".fungi", "exec-rules.json"), "utf8"),
      ),
    );
  expect(stored.rules).toHaveLength(1);
  const reader = localExecRules(root);
  expect(reader.match(["pnpm", "install", "--frozen-lockfile"])?.ruleId).toBe(
    stored.rules[0]?.id,
  );
  reader.add(["pnpm", "install"]);
  expect(reader.match(["pnpm", "install"])?.ruleId).toBe(stored.rules[0]?.id);
  expect(reader.matches(["pnpm", "install"])).toBe(true);
  expect(manageLocalExecRules(root, "list")).toEqual([["pnpm", "install"]]);
});

it("extension installs never offer a persistent prefix", () => {
  expect(rulePrefix(["fungi", "extension", "add", "./plugin"])).toBeUndefined();
  expect(
    rulePrefix(["/usr/bin/fungi", "extension", "add", "./plugin"]),
  ).toBeUndefined();
});

it("a project-directory Fungi grant cannot cover an extension install", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-rule-extension-cwd-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const rules = localExecRules(root);
  rules.add(["fungi", "-C"]);
  expect(
    rules.match([
      "fungi",
      "-C",
      root,
      "sessions",
      "status",
      "--last",
      "--json",
    ]),
  ).toBeDefined();
  const install = ["fungi", "-C", root, "extension", "add", "./ext"];
  expect(rules.match(install)).toBeUndefined();
  expect(rulePrefix(install)).toBeUndefined();
  expect(manageLocalExecRules(root, "list")).toEqual([["fungi", "-C"]]);
});

it("a human's project git prefix applies to a second Agent, not another project; removing it restores the ask", async () => {
  const a = await mkdtemp(join(tmpdir(), "fungi-rule-a-"));
  const b = await mkdtemp(join(tmpdir(), "fungi-rule-b-"));
  cleanups.push(async () => {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  });
  const rulesA = localExecRules(a);
  const rulesA2 = localExecRules(a);
  const rulesB = localExecRules(b);
  expect(rulesA.matches(["git", "push", "-u", "origin", "b"])).toBe(false);
  rulesA.add(["git", "push"]);
  expect(
    rulesA2.matches(["git", "push", "-u", "origin", "b"], new Set(["origin"])),
  ).toBe(true);
  expect(rulesA2.matches(["git", "commit", "-m", "x"])).toBe(false);
  expect(rulesB.matches(["git", "push", "-u", "origin", "b"])).toBe(false);
  expect(rulesA.matches(["sh", "-c", "git push; touch ~/x"])).toBe(false);
  expect(rulePrefix(["sh", "-c", "git push; touch ~/x"])).toBeUndefined();
  expect(() => {
    rulesA.add(["sh"]);
  }).toThrow();
  expect(
    await readFile(join(a, ".fungi", "exec-rules.json"), "utf8"),
  ).toContain('"git"');
  expect(manageLocalExecRules(a, "remove", ["git", "push"])).toEqual([]);
  expect(rulesA2.matches(["git", "commit", "-m", "x"])).toBe(false);
  expect(sandboxPolicy(a, a).readOnly).toContain(join(a, ".fungi"));
  expect(() => resolveAgentFolder(a, ".fungi")).toThrow("protected");
});

it("non-Git project rules are listed and removed without an Agent selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-rule-agents-"));
  cleanups.push(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const rules = localExecRules(root);
  rules.add(["pnpm", "install"]);
  expect(manageLocalExecRules(root, "list")).toEqual([["pnpm", "install"]]);
  expect(manageLocalExecRules(root, "remove", ["pnpm", "install"])).toEqual([]);
  expect(rules.matches(["pnpm", "install"])).toBe(false);
});

it("a narrow grant runs push and commit without a card; removal asks again", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-rule-git-"));
  const remote = await mkdtemp(join(tmpdir(), "fungi-rule-remote-"));
  const processes = createPrivateLocalComputerProcesses(root);
  cleanups.push(async () => {
    await processes.close();
    await rm(root, { recursive: true, force: true });
    await rm(remote, { recursive: true, force: true });
  });
  await execFile("git", ["init", "-q", root]);
  await execFile("git", ["init", "-q", "--bare", remote]);
  await execFile("git", ["-C", root, "config", "user.name", "Test"]);
  await execFile("git", [
    "-C",
    root,
    "config",
    "user.email",
    "test@example.invalid",
  ]);
  await execFile("git", ["-C", root, "remote", "add", "origin", remote]);
  await execFile("git", ["-C", root, "checkout", "-qb", "b"]);
  await writeFile(join(root, "tracked"), "payload");
  await execFile("git", ["-C", root, "add", "tracked"]);
  await mkdir(join(root, ".fungi"), { recursive: true });
  const rules = localExecRules(root);
  rules.add(["git", "push"]);
  const git = gitDirectories(root, root, "/usr/bin:/bin");
  if (git === undefined) throw new Error("Protected repository not found");
  const configuredRemotes = protectedGitRemoteNames(
    root,
    git.common,
    "/usr/bin:/bin",
  );
  if (configuredRemotes === undefined)
    throw new Error("Protected remote names unavailable");
  const ordinal = 0;
  let cards = 0;
  const computer = await createPrivateInvocationComputer(
    root,
    "/usr/bin:/bin",
    undefined,
    root,
    () => {
      throw new Error("Matching rules must not enter the sandbox");
    },
    () => "workspace",
    () => {
      cards += 1;
      return Promise.resolve({
        kind: "pending_approval",
        recordId: "after-removal",
        description: {
          title: "computer.exec",
          inputBytes: 1,
          inputSha256: "a".repeat(64),
        },
      });
    },
    async ({ request, cwd, mode, executionPath }) => {
      if (
        !("executable" in request) ||
        !rules.matches([request.executable, ...request.args], configuredRemotes)
      )
        return undefined;
      expect(mode).toBe("workspace");
      return shellOutput.parse(
        await dispatchApprovedLocalExec(
          request,
          cwd,
          executionPath,
          root,
          processes.scope("main"),
          mode,
        ),
      );
    },
  );
  rules.add(["git", "commit"]);
  for (const args of [
    ["commit", "-m", "through-rule"],
    ["push", "-u", "origin", "b"],
  ]) {
    expect(
      await computer.call(
        "exec",
        { executable: "git", args },
        {
          executionId: String(ordinal),
          deadlineAt: null,
          signal: new AbortController().signal,
        },
      ),
    ).toMatchObject({
      status: "completed",
      sandbox: { mode: "workspace", ranOutsideSandbox: true },
    });
  }
  expect(cards).toBe(0);
  expect(
    (
      await execFile("git", ["-C", root, "log", "-1", "--format=%s"])
    ).stdout.trim(),
  ).toBe("through-rule");
  expect(
    (
      await execFile("git", ["--git-dir", remote, "log", "b", "--format=%s"])
    ).stdout.trim(),
  ).toBe("through-rule");
  rules.remove(["git", "push"]);
  expect(
    await computer.call(
      "exec",
      {
        executable: "git",
        args: ["push", "-u", "origin", "b"],
        escape: { justification: "rule removed" },
      },
      {
        executionId: "third",
        deadlineAt: null,
        signal: new AbortController().signal,
      },
    ),
  ).toMatchObject({ kind: "pending_approval" });
  expect(cards).toBe(1);
});

it("an obsolete or broad pre-release rules file fails closed instead of granting Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-rule-old-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".fungi"));
  await writeFile(
    join(root, ".fungi", "exec-rules.json"),
    JSON.stringify({ version: 1, prefixes: [["git"]] }),
  );
  expect(() => localExecRules(root).matches(["git", "push"])).toThrow(
    /exec-rules\.json.*delete it and reapprove/u,
  );
  expect(() => manageLocalExecRules(root, "list")).toThrow(
    /exec-rules\.json.*delete it and reapprove/u,
  );
  expect(() => manageLocalExecRules(root, "remove", ["git", "push"])).toThrow(
    /exec-rules\.json.*delete it and reapprove/u,
  );
  await writeFile(join(root, ".fungi", "exec-rules.json"), "{bad json");
  expect(() => localExecRules(root).matches(["git", "push"])).toThrow(
    /exec-rules\.json.*delete it and reapprove/u,
  );
});

it("a held writer lock refuses a concurrent grant without losing the first", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-rule-lock-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const rules = localExecRules(root);
  rules.add(["pnpm", "install"]);
  await mkdir(join(root, ".fungi", "exec-rules.lock"));
  expect(() => {
    rules.add(["pnpm", "test"]);
  }).toThrow();
  expect(rules.list()).toEqual([["pnpm", "install"]]);
});
