import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  localExecRules,
  manageLocalExecRules,
  rulePrefix,
} from "../src/private-local-exec-rules.js";
import { localExecEscapeReview } from "../src/private-local-exec-review.js";

const roots: string[] = [];
async function project() {
  const root = await mkdtemp(join(tmpdir(), "fungi-rule-review-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

it("rejects relative git and Git subcommands that alter config or run arbitrary code", async () => {
  const rules = localExecRules(await project());
  for (const sub of ["config", "init", "rebase"]) {
    expect(rulePrefix(["git", sub])).toBeUndefined();
    expect(() => {
      rules.add(["git", sub]);
    }).toThrow();
  }
  expect(rulePrefix(["./git", "push"])).toBeUndefined();
  expect(() => {
    rules.add(["./git", "push"]);
  }).toThrow();
});

it.each(["scripts/build", "tools\\build", "/tmp/build"])(
  "does not offer, store or match path-valued executables: %s",
  async (executable) => {
    const rules = localExecRules(await project());
    expect(rulePrefix([executable, "test"])).toBeUndefined();
    expect(() => {
      rules.add([executable, "test"]);
    }).toThrow("Unsafe Always-allow prefix");
    expect(rules.matches([executable, "test"])).toBe(false);
  },
);

it.each([
  "GIT",
  "Git",
  "env",
  "nice",
  "nohup",
  "timeout",
  "xargs",
  "sudo",
  "doas",
  "command",
  "exec",
  "stdbuf",
  "time",
  "setsid",
  "chroot",
  "flock",
  "busybox",
])(
  "refuses case-variant Git and command wrapper %s grants",
  async (executable) => {
    const rules = localExecRules(await project());
    expect(rulePrefix([executable, "git", "push"])).toBeUndefined();
    expect(() => {
      rules.add([executable, "git"]);
    }).toThrow("Unsafe Always-allow prefix");
    expect(rules.matches([executable, "git", "push"])).toBe(false);
  },
);

it("Git rules exclude executable, output, and local-path remote options", async () => {
  const rules = localExecRules(await project());
  for (const sub of ["push", "fetch", "pull", "diff", "log", "show", "commit"])
    rules.add(["git", sub]);
  for (const argv of [
    ["git", "push", "--receive-pack=sh", "origin"],
    ["git", "fetch", "--upload-pack=sh", "origin"],
    ["git", "pull", "--upload-pack=sh", "origin"],
    ["git", "diff", "--ext-diff"],
    ["git", "log", "--output=/tmp/escape"],
    ["git", "show", "-o", "/tmp/escape"],
    ["git", "commit", "--template=/tmp/escape"],
    ["git", "commit", "--config-env=foo=BAR"],
    ["git", "push", "./bare"],
    ["git", "push", "file:///tmp/bare"],
    ["git", "fetch", "../bare"],
    ["git", "pull", "/tmp/bare"],
  ])
    expect(rules.matches(argv), argv.join(" ")).toBe(false);
});

it("a push grant never accepts --repo=./bare --all without a card", async () => {
  const root = await project();
  await mkdir(join(root, "bare"));
  const rules = localExecRules(root);
  rules.add(["git", "push"]);
  expect(rules.matches(["git", "push", "--repo=./bare", "--all"])).toBe(false);
});

it("a Git grant allows only reviewed options for its exact subcommand", async () => {
  const root = await project();
  const rules = localExecRules(root);
  for (const sub of ["push", "fetch", "pull", "log", "remote", "commit"])
    rules.add(["git", sub]);
  for (const argv of [
    ["git", "push", "--repo", "./bare", "--all"],
    ["git", "push", "--repo=ssh://example.test/repo", "--all"],
    ["git", "push", "--unreviewed-option", "origin"],
    ["git", "fetch", "--unreviewed-option", "origin"],
    ["git", "pull", "--unreviewed-option", "origin"],
    ["git", "log", "--unreviewed-option"],
    ["git", "commit", "--unreviewed-option"],
    ["git", "remote", "add", "attacker", "./bare"],
  ])
    expect(rules.matches(argv), argv.join(" ")).toBe(false);
  expect(
    rules.matches(["git", "push", "-u", "origin", "main"], new Set(["origin"])),
  ).toBe(true);
  expect(rules.matches(["git", "push", "--all"])).toBe(true);
  expect(rules.matches(["git", "commit", "-m", "ship"])).toBe(true);
  expect(rules.matches(["git", "remote", "-v"])).toBe(true);
});

it("remote inspection grants never accept local paths or mutate remote URLs", async () => {
  const root = await project();
  await mkdir(join(root, "bare"));
  const rules = localExecRules(root);
  rules.add(["git", "remote"]);
  expect(rules.matches(["git", "remote", "show", "./bare"])).toBe(false);
  expect(rules.matches(["git", "remote", "get-url", "bare"])).toBe(false);
  expect(rules.matches(["git", "remote", "add", "origin", "./bare"])).toBe(
    false,
  );
  expect(
    rules.matches(["git", "remote", "show", "origin"], new Set(["origin"])),
  ).toBe(true);
});

it.each(["push", "fetch", "pull"])(
  "git %s never grants an unconfigured bare remote even while the path is absent",
  async (subcommand) => {
    const root = await project();
    const rules = localExecRules(root);
    rules.add(["git", subcommand]);
    expect(rules.matches(["git", subcommand, "bare"])).toBe(false);
    expect(rules.matches(["git", subcommand, "--", "bare"])).toBe(false);
  },
);

it("configured names and scheme URLs remain grantable after --", async () => {
  const rules = localExecRules(await project());
  for (const subcommand of ["push", "fetch", "pull"]) {
    rules.add(["git", subcommand]);
    expect(
      rules.matches(["git", subcommand, "--", "origin"], new Set(["origin"])),
    ).toBe(true);
    expect(
      rules.matches(["git", subcommand, "--", "ssh://example.test/repo"]),
    ).toBe(true);
  }
});

it.each(["commit", "push", "merge", "diff"])(
  "the git %s grant review discloses writable project hook files",
  (subcommand) => {
    const review = localExecEscapeReview(
      {
        executable: "git",
        args: [subcommand],
        escape: { justification: "Git metadata is read-only" },
      },
      "/project/fungi",
    );
    expect(review.prefix).toEqual(["git", subcommand]);
    expect(review.warning).toContain("run code as you");
    expect(review.warning).toContain("create missing hook files");
    expect(review.warning).toContain("configured fsmonitor path");
    if (subcommand === "push")
      expect(review.warning).toContain("delete remote branches");
  },
);

it("the Git option profile needs no suppression cast", async () => {
  const source = await readFile(
    new URL("../src/private-local-exec-rules.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toContain("as keyof typeof gitOptions");
  expect(source).not.toContain("SAFETY: gitBuiltins");
});

it("Git grants contain no unreachable rebase option branch", async () => {
  const source = await readFile(
    new URL("../src/private-local-exec-rules.ts", import.meta.url),
    "utf8",
  );
  expect(source).not.toContain('subcommand === "rebase"');
});

it("refuses a bare local directory even when its name looks like a remote", async () => {
  const root = await project();
  await mkdir(join(root, "bare"));
  const rules = localExecRules(root);
  rules.add(["git", "push"]);
  expect(rules.matches(["git", "push", "bare"])).toBe(false);
});

it("old or corrupt project files name the replacement action", async () => {
  const root = await project();
  await mkdir(join(root, ".fungi"));
  for (const contents of ['{"version":1,"prefixes":[["git"]]}', "{bad json"]) {
    await writeFile(join(root, ".fungi", "exec-rules.json"), contents);
    expect(() => manageLocalExecRules(root, "list")).toThrow(
      /exec-rules\.json.*delete it and reapprove/u,
    );
  }
});

it("two writers cannot silently overwrite each other", async () => {
  const root = await project();
  const rules = localExecRules(root);
  rules.add(["pnpm", "install"]);
  await mkdir(join(root, ".fungi", "exec-rules.lock"));
  expect(() => {
    rules.add(["pnpm", "test"]);
  }).toThrow();
  expect(rules.list()).toEqual([["pnpm", "install"]]);
});
