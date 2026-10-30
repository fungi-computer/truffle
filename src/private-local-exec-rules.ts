import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { correlationKey, defineIdFamily } from "@fungi.computer/cairn";
import { z } from "zod";
import type { ParseEntry } from "shell-quote";

function fungiWord(word: ParseEntry | undefined): boolean {
  const parsed = z.string().safeParse(word);
  return parsed.success && basename(parsed.data) === "fungi";
}

/**
 * Conservative literal risk, not CLI parsing or executable identity. Global
 * options can occur among positionals. Shell tokens may disclose risk, but
 * only actual direct argv ever reaches the reusable-grant matcher.
 */
export function hasExtensionInstallRisk(
  words: readonly ParseEntry[],
  form: "direct" | "shell",
): boolean {
  const executable =
    form === "direct"
      ? fungiWord(words[0])
        ? 0
        : -1
      : words.findIndex(fungiWord);
  if (executable < 0) return false;
  const extension = words.findIndex(
    (word, index) => index > executable && word === "extension",
  );
  return (
    extension >= 0 &&
    words.some((word, index) => index > extension && word === "add")
  );
}

const prefixSchema = z.array(z.string().min(1).max(4096)).min(1).max(32);
const projectRuleIds = defineIdFamily({
  family: "local-exec-rules",
  version: 1,
  kinds: { rule: { prefix: "local_exec_rule" } },
});
const projectRuleSchema = z.strictObject({
  id: projectRuleIds.rule.schema,
  prefix: prefixSchema,
});
const projectRulesSchema = z.strictObject({
  version: z.literal(2),
  rules: z.array(projectRuleSchema).max(256),
});
// Only these built-ins and these exact options can inherit a Git grant.
// In particular, new Git options are refused until reviewed here.
type GitOptionProfile = Readonly<{
  flags: readonly string[];
  values: readonly string[];
}>;
const gitOptions = {
  add: {
    flags: [
      "--",
      "-A",
      "--all",
      "-u",
      "--update",
      "-p",
      "--patch",
      "-n",
      "--dry-run",
    ],
    values: [],
  },
  branch: {
    flags: [
      "--",
      "-a",
      "--all",
      "-d",
      "-D",
      "--delete",
      "-r",
      "--remotes",
      "--list",
      "--show-current",
      "-v",
    ],
    values: ["-m", "-M"],
  },
  checkout: {
    flags: ["--", "-f", "--force", "--detach"],
    values: ["-b", "-B"],
  },
  commit: {
    flags: [
      "--",
      "-a",
      "--all",
      "--amend",
      "--no-edit",
      "--allow-empty",
      "-s",
      "--signoff",
    ],
    values: ["-m", "--message", "-am"],
  },
  diff: {
    flags: [
      "--",
      "--stat",
      "--cached",
      "--staged",
      "--name-only",
      "--name-status",
      "--quiet",
      "--check",
    ],
    values: [],
  },
  fetch: {
    flags: [
      "--",
      "--all",
      "--prune",
      "-p",
      "--tags",
      "-t",
      "-q",
      "--quiet",
      "-v",
      "--verbose",
      "-n",
      "--dry-run",
    ],
    values: [],
  },
  log: {
    flags: [
      "--",
      "--oneline",
      "--all",
      "--decorate",
      "--no-decorate",
      "--stat",
      "--name-only",
      "--graph",
      "-1",
      "-2",
      "-5",
      "-10",
    ],
    values: [],
  },
  merge: {
    flags: [
      "--",
      "--abort",
      "--continue",
      "--no-ff",
      "--ff-only",
      "--squash",
      "--no-commit",
    ],
    values: [],
  },
  pull: {
    flags: [
      "--",
      "--ff-only",
      "--no-rebase",
      "--no-commit",
      "--no-edit",
      "-q",
      "--quiet",
      "-v",
      "--verbose",
    ],
    values: [],
  },
  push: {
    flags: [
      "--",
      "-u",
      "--set-upstream",
      "--all",
      "--tags",
      "--delete",
      "-d",
      "--force-with-lease",
      "--dry-run",
      "-n",
      "--follow-tags",
    ],
    values: [],
  },
  remote: { flags: ["-v", "--verbose"], values: [] },
  reset: {
    flags: ["--", "--soft", "--mixed", "--hard", "--keep", "-q", "--quiet"],
    values: [],
  },
  restore: { flags: ["--", "--staged", "--worktree"], values: [] },
  "rev-parse": {
    flags: [
      "--",
      "--verify",
      "--short",
      "--abbrev-ref",
      "--is-inside-work-tree",
      "--show-toplevel",
      "--git-dir",
      "--absolute-git-dir",
      "--show-prefix",
    ],
    values: [],
  },
  show: {
    flags: ["--", "--stat", "--oneline", "--name-only", "-1"],
    values: [],
  },
  stash: {
    flags: [
      "--",
      "-u",
      "--include-untracked",
      "-a",
      "--all",
      "-k",
      "--keep-index",
      "-p",
      "--patch",
    ],
    values: ["-m", "--message"],
  },
  status: {
    flags: [
      "--",
      "-s",
      "--short",
      "-b",
      "--branch",
      "--porcelain",
      "--ignored",
    ],
    values: [],
  },
  switch: { flags: ["--", "--detach"], values: ["-c", "-C"] },
  tag: {
    flags: ["--", "-l", "--list", "-d", "--delete", "-a", "--annotate"],
    values: ["-m", "--message"],
  },
} satisfies Readonly<Record<string, GitOptionProfile>>;
// Git aliases may run shell commands; never grant a global option or alias.
const gitProfiles = new Map<string, GitOptionProfile>(
  Object.entries(gitOptions),
);
const gitBuiltins = new Set(gitProfiles.keys());
const shellExecutables = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
const commandWrappers = new Set([
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
]);

function unsafeExecutable(executable: string): boolean {
  const name = basename(executable).toLowerCase();
  return (
    shellExecutables.has(name) ||
    commandWrappers.has(name) ||
    (name === "git" && executable !== "git") ||
    (name === "fungi" && executable !== "fungi")
  );
}

function validPrefix(prefix: readonly string[]) {
  return (
    prefix[0] !== undefined &&
    !prefix[0].startsWith(".") &&
    !prefix[0].includes("/") &&
    !prefix[0].includes("\\") &&
    !unsafeExecutable(prefix[0]) &&
    !(
      basename(prefix[0]) === "fungi" &&
      (prefix.length === 1 || prefix[1] === "extension")
    ) &&
    (basename(prefix[0]) !== "git" ||
      (prefix[0] === "git" &&
        prefix.length === 2 &&
        gitBuiltins.has(prefix[1] ?? "")))
  );
}

/** Offer only direct commands that this same matcher can authorize. */
export function rulePrefix(
  argv: readonly string[],
  configuredRemotes?: ReadonlySet<string>,
): string[] | undefined {
  if (
    argv.length === 0 ||
    argv[0]?.startsWith(".") ||
    argv[0]?.includes("/") ||
    argv[0]?.includes("\\") ||
    unsafeExecutable(argv[0] ?? "")
  )
    return undefined;
  if (basename(argv[0] ?? "") === "git") {
    const prefix = argv.slice(0, 2);
    return validPrefix(prefix) && safeGitCommand(argv, configuredRemotes)
      ? prefix
      : undefined;
  }
  if (hasExtensionInstallRisk(argv, "direct")) return undefined;
  const parsed = prefixSchema.safeParse(argv.slice(0, 2));
  return parsed.success && validPrefix(parsed.data) ? parsed.data : undefined;
}

/** Text for the same Git option profile that gates matching, not a second list. */
export function gitRuleCoverage(subcommand: string): string {
  const profile = gitProfiles.get(subcommand);
  if (profile === undefined) throw new Error("No reusable Git option profile");
  const flags = profile.flags.filter((flag) => flag !== "--").join(", ");
  const values = profile.values.map((option) => `${option} VALUE`).join(", ");
  const remote =
    subcommand === "push" ||
    subcommand === "fetch" ||
    subcommand === "pull" ||
    subcommand === "remote"
      ? " Remote operands must be configured names or permitted explicit URLs."
      : "";
  return `Direct argv git ${subcommand} for Workspace Agents in this protected project repository. Only these options are reusable: ${flags || "none"}${values ? `; ${values}` : ""}; -- and permitted operands.${remote} Shell commands and unlisted Git options still ask.`;
}

function safeRemote(
  remote: string | undefined,
  configuredRemotes?: ReadonlySet<string>,
): boolean {
  if (remote === undefined) return true;
  if (/^(https?|ssh|git):\/\//u.test(remote)) return true;
  // A bare token is also a relative path. Only the protected repository's
  // configured remote names can authorize it, regardless of filesystem state.
  return (
    /^[A-Za-z][A-Za-z0-9_.-]*$/u.test(remote) &&
    configuredRemotes?.has(remote) === true
  );
}

/** A Git prefix never authorizes options outside the reviewed subcommand profile. */
function safeGitCommand(
  argv: readonly string[],
  configuredRemotes?: ReadonlySet<string>,
): boolean {
  if (argv[0] !== "git") return false;
  const subcommand = argv[1];
  const profile = gitProfiles.get(subcommand ?? "");
  if (profile === undefined) return false;
  const operands: string[] = [];
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === undefined) return false;
    if (arg === "--") {
      operands.push(...argv.slice(index + 1));
      break;
    }
    if (arg.startsWith("-") && arg !== "-") {
      if (profile.flags.some((option) => option === arg)) continue;
      if (!profile.values.some((option) => option === arg)) return false;
      // A missing value must not turn a following option into an operand.
      if (argv[index + 1] === undefined || argv[index + 1]?.startsWith("-"))
        return false;
      index++;
    } else {
      operands.push(arg);
    }
  }
  if (subcommand === "remote") {
    if (operands.length === 0) return true;
    if (
      operands.length > 2 ||
      (operands[0] !== "show" && operands[0] !== "get-url")
    )
      return false;
    return safeRemote(operands[1], configuredRemotes);
  }
  if (subcommand === "push" || subcommand === "fetch" || subcommand === "pull")
    return safeRemote(operands[0], configuredRemotes);
  return true;
}

function projectFile(project: string) {
  const directory = join(project, ".fungi");
  const marker = lstatSync(directory, { throwIfNoEntry: false });
  if (marker !== undefined && !marker.isDirectory())
    throw new Error("Project .fungi must be a real directory");
  return { directory, file: join(directory, "exec-rules.json") };
}

function readProject(project: string) {
  const file = join(project, ".fungi", "exec-rules.json");
  try {
    return readProjectFile(project);
  } catch (cause) {
    throw new Error(
      `Invalid ${file}; delete it and reapprove Always-allow rules`,
      { cause },
    );
  }
}

function readProjectFile(project: string) {
  const { file } = projectFile(project);
  const entry = lstatSync(file, { throwIfNoEntry: false });
  if (entry === undefined) return { version: 2, rules: [] } as const;
  if (!entry.isFile() || entry.nlink !== 1)
    throw new Error("Project exec rules must be an independent regular file");
  const stored = projectRulesSchema.parse(
    JSON.parse(readFileSync(file, "utf8")),
  );
  if (stored.rules.some((rule) => !validPrefix(rule.prefix)))
    throw new Error("Project exec rules contain an unsafe prefix");
  return stored;
}

/** Fail closed on contention instead of overwriting another process's grant. */
function lockedUpdate(project: string, update: () => void) {
  const { directory } = projectFile(project);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, "exec-rules.lock");
  mkdirSync(lock, { mode: 0o700 });
  try {
    update();
  } finally {
    rmdirSync(lock);
  }
}

function writeProject(
  project: string,
  rules: readonly z.infer<typeof projectRuleSchema>[],
) {
  const content = projectRulesSchema.parse({ version: 2, rules });
  const { directory, file } = projectFile(project);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, "exec-rules-" + correlationKey() + ".tmp");
  writeFileSync(temp, JSON.stringify(content), { flag: "wx", mode: 0o600 });
  renameSync(temp, file);
}

/** One host-owned project file; every Agent in the project sees the same rules. */
export function localExecRules(project: string) {
  const list = () => readProject(project).rules.map((rule) => rule.prefix);
  const add = (prefix: readonly string[]) => {
    const parsed = prefixSchema.parse(prefix);
    if (!validPrefix(parsed)) throw new Error("Unsafe Always-allow prefix");
    let ruleId: z.infer<typeof projectRuleSchema>["id"] | undefined;
    lockedUpdate(project, () => {
      const existing = readProject(project).rules;
      ruleId = existing.find(
        (rule) => JSON.stringify(rule.prefix) === JSON.stringify(parsed),
      )?.id;
      if (ruleId === undefined) {
        ruleId = projectRuleIds.rule.generate();
        writeProject(project, [...existing, { id: ruleId, prefix: parsed }]);
      }
    });
    if (ruleId === undefined) throw new Error("Exec rule was not persisted");
    return ruleId;
  };
  const remove = (prefix: readonly string[]) => {
    const parsed = prefixSchema.parse(prefix);
    lockedUpdate(project, () => {
      writeProject(
        project,
        readProject(project).rules.filter(
          (rule) => JSON.stringify(rule.prefix) !== JSON.stringify(parsed),
        ),
      );
    });
  };
  const match = (
    argv: readonly string[],
    configuredRemotes?: ReadonlySet<string>,
  ) => {
    if (
      unsafeExecutable(argv[0] ?? "") ||
      hasExtensionInstallRisk(argv, "direct")
    )
      return undefined;
    if (argv[0] === "git" && !safeGitCommand(argv, configuredRemotes))
      return undefined;
    const matched = readProject(project).rules.find((rule) =>
      rule.prefix.every((part, index) => argv[index] === part),
    );
    // The stored Cairn id identifies the rule without exposing its prefix.
    return matched === undefined ? undefined : { ruleId: matched.id };
  };
  const matches = (
    argv: readonly string[],
    configuredRemotes?: ReadonlySet<string>,
  ) => match(argv, configuredRemotes) !== undefined;
  return { list, add, remove, match, matches };
}

/** Human CLI management only; no model-facing capability exposes this writer. */
export function manageLocalExecRules(
  project: string,
  action: "list" | "remove",
  prefix?: readonly string[],
): readonly (readonly string[])[] {
  const rules = localExecRules(project);
  if (action === "remove") {
    if (prefix === undefined) throw new Error("A prefix is required");
    rules.remove(prefix);
  }
  return rules.list();
}
