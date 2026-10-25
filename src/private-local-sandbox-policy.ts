import { isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { userInfo } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from "node:path";
import { z } from "zod";

/** Retained POSIX folder grammar; no separate safe/YOLO representation. */
export const localAgentFolderSchema = z
  .string()
  .min(1)
  .refine(
    (value) =>
      !posix.isAbsolute(value) &&
      !value.includes("\\") &&
      !value.includes("\0") &&
      !value.split("/").includes(".."),
    "Agent folder must be a project-relative POSIX path without '..'",
  )
  .transform((value) => posix.normalize(value));

/** Resolve stored folder authority before opening work, not after acquisition. */
export function resolveAgentFolder(project: string, folder: string) {
  const root = realpathSync(project);
  const absolute = realpathSync(
    resolve(root, localAgentFolderSchema.parse(folder)),
  );
  const within = relative(root, absolute);
  if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
    throw new Error("Agent folder resolves outside the project");
  if (!lstatSync(absolute).isDirectory())
    throw new Error("Agent folder must be a directory");
  return { folder: within.split(sep).join("/") || ".", absolute };
}

/** Containment authority, not an approval setting or an execution mode. */
export type LocalSandboxPolicy = Readonly<{
  projectRoot: string;
  writableRoot: string;
  readOnly: readonly string[];
  immovable: readonly string[];
}>;

export class UnsafeNativePayload extends Error {
  override readonly name = "UnsafeNativePayload";
}

export class UnsafeHostCode extends Error {
  override readonly name = "UnsafeHostCode";
}

function within(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return (
    !isAbsolute(remainder) &&
    remainder !== ".." &&
    !remainder.startsWith(`..${sep}`)
  );
}

function inGitAdministration(path: string): boolean {
  for (let directory = dirname(path); ; directory = dirname(directory)) {
    if (
      basename(directory) === ".git" ||
      (lstatSync(join(directory, "HEAD"), {
        throwIfNoEntry: false,
      })?.isFile() &&
        (lstatSync(join(directory, "objects"), {
          throwIfNoEntry: false,
        })?.isDirectory() ||
          lstatSync(join(directory, "commondir"), {
            throwIfNoEntry: false,
          })?.isFile()))
    )
      return true;
    if (directory === dirname(directory)) return false;
  }
}

/**
 * Packed CLI identity is supplied by the Node bin wrapper, which loaded both
 * paths before spawning Bun. This is an admission check, not an integrity
 * check on JS that might already have been rewritten.
 */
export function assertHostCodeOutsideAgent(
  project: string,
  cli: string,
  launcher: string,
): void {
  const root = realpathSync(project);
  const paths = [
    cli,
    launcher,
    dirname(cli),
    dirname(dirname(cli)),
    dirname(launcher),
    dirname(dirname(launcher)),
  ];
  for (const path of paths) {
    try {
      const logical = resolve(path);
      const actual = realpathSync(logical);
      if (
        [logical, actual].some(
          (candidate) =>
            within(root, candidate) || inGitAdministration(candidate),
        )
      )
        throw new UnsafeHostCode(
          "Fungi host JavaScript is inside the Agent project or Git administration; install Fungi outside the project.",
        );
    } catch (cause) {
      if (cause instanceof UnsafeHostCode) throw cause;
      throw new UnsafeHostCode(
        "Fungi host JavaScript location cannot be verified; reinstall Fungi outside the project.",
        { cause },
      );
    }
  }
  for (const path of [cli, launcher]) {
    try {
      const file = statSync(path);
      if (!file.isFile() || file.nlink > 1)
        throw new UnsafeHostCode(
          "Fungi host JavaScript is not an independent file (hardlinked or not regular); use a copying install outside the project (pnpm package-import-method=copy or npm global).",
        );
    } catch (cause) {
      if (cause instanceof UnsafeHostCode) throw cause;
      throw new UnsafeHostCode(
        "Fungi host JavaScript cannot be inspected; reinstall Fungi using a copying install outside the project.",
        { cause },
      );
    }
  }
}

/** Refuse both logical and resolved native source locations in the whole
 * Agent project or Git administration before verifying source bytes. */
export function assertHostOwnedNativeFile(project: string, path: string): void {
  const logical = resolve(path);
  const actual = realpathSync(logical);
  const gitAdmin = (candidate: string) => inGitAdministration(candidate);
  if (
    [logical, actual].some(
      (candidate) => within(project, candidate) || gitAdmin(candidate),
    )
  )
    throw new UnsafeNativePayload(
      "Packaged native payload is inside the Agent project or a Git-admin folder; reinstall Fungi outside the project.",
    );
}

function sweepErrorCode(
  cause: unknown,
): "ENOENT" | "ESRCH" | "EPERM" | undefined {
  if (!(cause instanceof Error) || !("code" in cause)) return undefined;
  switch (cause.code) {
    case "ENOENT":
    case "ESRCH":
    case "EPERM":
      return cause.code;
    default:
      return undefined;
  }
}

/** Host liveness check for private PID-named run reclamation. */
export type NativeRunLivenessProbe = (pid: number) => void;

const probeNativeRunLiveness: NativeRunLivenessProbe = (pid) => {
  process.kill(pid, 0);
};

/** Reclamation may fail independently of private-run admission. */
function sweepPrivateNativeRuns(
  root: string,
  uid: number,
  probe: NativeRunLivenessProbe,
): void {
  try {
    for (const name of readdirSync(root)) {
      const match = /^run-([1-9]\d*)-([A-Za-z0-9]{6})$/.exec(name);
      if (match === null) continue;
      const stale = join(root, name);
      try {
        const entry = lstatSync(stale);
        if (
          !entry.isDirectory() ||
          entry.uid !== uid ||
          (entry.mode & 0o077) !== 0
        )
          continue;
        try {
          probe(Number(match[1]));
        } catch (cause) {
          if (sweepErrorCode(cause) === "ESRCH")
            rmSync(stale, { recursive: true, force: true });
          else if (sweepErrorCode(cause) !== "EPERM") throw cause;
        }
      } catch (cause) {
        if (sweepErrorCode(cause) !== "ENOENT")
          console.warn("Native stale-run sweep could not inspect entry", cause);
      }
    }
  } catch (cause) {
    console.warn("Native stale-run sweep could not list runs", cause);
  }
}

/** New private inode, never a link or bind of an installed payload. */
export function privateNativeDirectory(
  project: string,
  probe: NativeRunLivenessProbe = probeNativeRunLiveness,
): string {
  const uid = process.getuid?.();
  if (uid === undefined)
    throw new UnsafeNativePayload(
      "Host native staging requires a POSIX user identity.",
    );
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base = runtime ?? join(userInfo().homedir, ".local", "state");
  if (runtime !== undefined) {
    if (!isAbsolute(runtime))
      throw new UnsafeNativePayload("XDG_RUNTIME_DIR must be absolute.");
    const directory = lstatSync(runtime, { throwIfNoEntry: false });
    if (
      directory === undefined ||
      !directory.isDirectory() ||
      directory.uid !== uid ||
      (directory.mode & 0o077) !== 0
    )
      throw new UnsafeNativePayload(
        "XDG_RUNTIME_DIR must be a private directory owned by this user.",
      );
  }
  const root = join(base, "fungi", "native");
  const resolvedProject = realpathSync(project);
  if (within(resolvedProject, resolve(root)) || inGitAdministration(root))
    throw new UnsafeNativePayload(
      "Host native staging cannot live inside the Agent project or Git administration.",
    );
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const actual = realpathSync(root);
  if (within(resolvedProject, actual) || inGitAdministration(actual))
    throw new UnsafeNativePayload(
      "Host native staging resolves inside the Agent project or Git administration.",
    );
  const metadata = lstatSync(actual);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== uid ||
    (metadata.mode & 0o077) !== 0
  )
    throw new UnsafeNativePayload(
      "Host native staging root must be private and owned by this user.",
    );
  sweepPrivateNativeRuns(actual, uid, probe);
  return mkdtempSync(join(actual, `run-${String(process.pid)}-`));
}

export function stageNativeBytes(
  directory: string,
  label: string,
  bytes: Uint8Array,
): string {
  const target = join(mkdtempSync(join(directory, "payload-")), label);
  writeFileSync(target, bytes, { flag: "wx", mode: 0o500 });
  return target;
}

/** Missing reserved names resolve through their nearest existing ancestor. */
function canonicalPath(path: string): string {
  if (lstatSync(path, { throwIfNoEntry: false }) !== undefined)
    return realpathSync(path);
  return join(canonicalPath(dirname(path)), basename(path));
}

/** One logical/resolved authority for Files, bwrap and Seatbelt. */
export function protectedSandboxPaths(paths: readonly string[]): string[] {
  return [
    ...new Set(
      paths.flatMap((path) => {
        if (!isAbsolute(path))
          throw new Error("Sandbox protected paths must be absolute");
        const logical = resolve(path);
        return [logical, canonicalPath(logical)];
      }),
    ),
  ];
}

// A project tree is untrusted input. Refuse incomplete discovery rather than
// silently protecting only a prefix or allowing a bare command to bypass it.
// Bound directory traversal, not ordinary dependency-file payloads.
const maximumDiscoveryDirectories = 100_000;
const discoveryDirectoryLimit = z
  .number()
  .int()
  .min(1)
  .max(maximumDiscoveryDirectories);
// Each work tree costs four short Git processes; bound the process count too.
const maximumGitWorkTrees = 256;
const maximumGitOutputBytes = 256 * 1024 * 1024;
const gitTimeoutMilliseconds = 30_000;

/** Host Git from absolute PATH entries; never a binary the Agent can write. */
function hostGit(project: string): string | undefined {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, "git");
    try {
      accessSync(candidate, constants.X_OK);
      const actual = realpathSync(candidate);
      if (
        statSync(actual).isFile() &&
        ![candidate, actual].some(
          (path) => within(project, path) || inGitAdministration(path),
        )
      )
        return candidate;
    } catch (cause) {
      // No usable Git on this PATH entry; any other fault refuses discovery.
      if (!unreadableEntry(cause)) throw cause;
    }
  }
  return undefined;
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env))
    if (!name.startsWith("GIT_")) environment[name] = value;
  return { ...environment, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}

/** Missing, non-directory or looping entries; never other faults. */
function absentEntry(cause: unknown): boolean {
  if (!(cause instanceof Error) || !("code" in cause)) return false;
  switch (cause.code) {
    case "ENOENT":
    case "ENOTDIR":
    case "ELOOP":
      return true;
    default:
      return false;
  }
}

/**
 * Absent or permission-denied. Only for choices where denial is safe (skip a
 * PATH entry, protect more); never where it would drop protection, since an
 * Agent can `chmod 000` a directory inside its folder.
 */
function unreadableEntry(cause: unknown): boolean {
  return (
    absentEntry(cause) ||
    (cause instanceof Error && "code" in cause && cause.code === "EACCES")
  );
}

// `git ls-files --stage`: <mode> SP <object> SP <stage> TAB <path>.
const stagedEntry = /^([0-7]{6}) [0-9a-f]{40,64} [0-3]\t(.+)$/su;

/**
 * Git's own names for one work tree: its administration directories, the
 * nested repositories it reports (gitlinks, untracked repositories, registered
 * worktrees) and bare-repository candidates among its non-ignored files.
 * Ignored payload is never listed. Undefined when Git cannot answer, so the
 * caller falls back to the complete budgeted walk.
 */
function gitWorkTreeView(git: string, workTree: string) {
  const run = (args: readonly string[], separator: 0 | 10) => {
    // Repository configuration may be Agent-authored: no fsmonitor command,
    // no Agent-forged untracked cache, no pager, no index writes.
    const result = spawnSync(
      git,
      [
        "--no-pager",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        ...args,
      ],
      {
        cwd: workTree,
        env: gitEnvironment(),
        maxBuffer: maximumGitOutputBytes,
        timeout: gitTimeoutMilliseconds,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    if (result.error !== undefined || result.status !== 0) return undefined;
    // Raw bytes: a name that is not UTF-8 cannot be protected by a string
    // path, so the whole view is refused instead of silently dropping it.
    const records: string[] = [];
    for (let start = 0; start < result.stdout.length;) {
      const end = result.stdout.indexOf(separator, start);
      const stop = end === -1 ? result.stdout.length : end;
      const record = result.stdout.subarray(start, stop);
      if (!isUtf8(record)) return undefined;
      records.push(record.toString("utf8"));
      start = stop + 1;
    }
    return records;
  };
  // Newline-separated; a path containing a newline fails the count check.
  const location = run(
    [
      "rev-parse",
      "--is-inside-work-tree",
      "--absolute-git-dir",
      "--git-common-dir",
    ],
    10,
  );
  if (location?.length !== 3) return undefined;
  const [inside, gitDirectory = "", commonDirectory = ""] = location;
  if (inside !== "true") return undefined;
  const staged = run(["ls-files", "-z", "--stage"], 0);
  const others = run(["ls-files", "-z", "--others", "--exclude-standard"], 0);
  const worktrees = run(["worktree", "list", "--porcelain", "-z"], 0);
  if (staged === undefined || others === undefined || worktrees === undefined)
    return undefined;
  const repositories: string[] = [];
  const bare: string[] = [];
  const files = (path: string) => {
    if (basename(path) === "HEAD") bare.push(dirname(resolve(workTree, path)));
  };
  for (const record of staged) {
    if (record === "") continue;
    const entry = stagedEntry.exec(record);
    if (entry === null) return undefined;
    const [, mode = "", path = ""] = entry;
    if (mode === "160000") repositories.push(resolve(workTree, path));
    else files(path);
  }
  for (const path of others) {
    if (path === "") continue;
    // Git reports a nested repository as its directory with a trailing slash.
    if (path.endsWith("/")) repositories.push(resolve(workTree, path));
    else files(path);
  }
  for (const field of worktrees)
    if (field.startsWith("worktree ")) repositories.push(field.slice(9));
  return {
    administration: [gitDirectory, resolve(workTree, commonDirectory)],
    repositories,
    bare,
  };
}

/** Git's commondir rule, compared only; never a grant or a walk. */
function sharesCommonDirectory(gitDirectory: string): boolean {
  try {
    const target = readFileSync(
      join(gitDirectory, "commondir"),
      "utf8",
    ).replace(/[\r\n]+$/u, "");
    return (
      target !== "" &&
      realpathSync(resolve(gitDirectory, target)) !== realpathSync(gitDirectory)
    );
  } catch (cause) {
    // Unreadable or dangling: protect it as its own common directory.
    if (unreadableEntry(cause)) return false;
    throw cause;
  }
}

/**
 * Discovery follows Git. Inside a work tree, Git names its administration and
 * nested repositories; ignored payload (dependency stores, tool output) is
 * not searched. Outside any work tree, or when Git cannot answer, a complete
 * walk with the directory budget finds repositories. Git administration is
 * always walked completely and never pruned.
 */
function gitProtection(project: string, root: string, directoryLimit: number) {
  type Kind = "work-tree" | "walk" | "tree" | "modules" | "worktrees" | "git";
  const pending: { path: string; kind: Kind }[] = [
    { path: root, kind: "work-tree" },
  ];
  const readOnly: string[] = [];
  const immovable: string[] = [];
  const named = new Set<string>();
  const executable = hostGit(project);
  let discoveredDirectories = 1; // The writable root itself.
  let workTrees = 0;
  const queue = (path: string, kind: Kind) => {
    discoveredDirectories += 1;
    if (discoveredDirectories > directoryLimit)
      throw new Error(
        `Sandbox Git discovery exceeds ${String(directoryLimit)} directories`,
      );
    pending.push({ path, kind });
  };
  // Git-reported names are data: accept only real directories reached without
  // a symlink, inside the writable root, once. Never bind or prepare outside.
  const contained = (path: string) => {
    if (path === root || !within(root, path)) return false;
    try {
      return realpathSync(path) === path && lstatSync(path).isDirectory();
    } catch (cause) {
      // A reported name that no longer exists names nothing to protect. A
      // denied one may hide a repository: rethrow EACCES so discovery refuses.
      if (absentEntry(cause)) return false;
      throw cause;
    }
  };
  const name = (path: string, kind: "work-tree" | "git") => {
    const key = `${kind}\0${path}`;
    if (named.has(key) || !contained(path)) return;
    named.add(key);
    queue(path, kind);
  };
  const inspect = (path: string) => lstatSync(path, { throwIfNoEntry: false });
  /** False when Git cannot answer; the caller walks the directory instead. */
  const askGit = (workTree: string) => {
    workTrees += 1;
    if (workTrees > maximumGitWorkTrees)
      throw new Error(
        `Sandbox Git discovery exceeds ${String(maximumGitWorkTrees)} work trees`,
      );
    const view =
      executable === undefined
        ? undefined
        : gitWorkTreeView(executable, workTree);
    if (view === undefined) return false;
    const marker = inspect(join(workTree, ".git"));
    if (marker?.isDirectory()) name(join(workTree, ".git"), "git");
    else if (marker !== undefined) readOnly.push(join(workTree, ".git")); // Never parse a Git pointer.
    for (const path of view.administration) name(path, "git");
    // Validate each Git-reported name before inspecting anything under it.
    for (const path of view.repositories) {
      if (!contained(path)) continue;
      const nested = inspect(join(path, ".git"));
      if (nested?.isDirectory()) name(path, "work-tree");
      else if (nested !== undefined) readOnly.push(join(path, ".git"));
    }
    for (const path of view.bare)
      if (
        contained(path) &&
        inspect(join(path, "HEAD"))?.isFile() &&
        (inspect(join(path, "objects"))?.isDirectory() ||
          inspect(join(path, "commondir"))?.isFile())
      )
        name(path, "git");
    return true;
  };
  for (
    let directory = pending.pop();
    directory !== undefined;
    directory = pending.pop()
  ) {
    if (directory.kind === "work-tree") {
      if (!askGit(directory.path))
        pending.push({ path: directory.path, kind: "walk" });
      continue;
    }
    const entries = readdirSync(directory.path, { withFileTypes: true });
    const has = (name: string) => entries.some((entry) => entry.name === name);
    const git =
      directory.kind === "git" ||
      basename(directory.path) === ".git" ||
      (has("HEAD") && (has("objects") || has("commondir"))) ||
      (directory.kind === "modules" &&
        (has("HEAD") || has("config") || has("hooks")));
    // Outside administration, a directory holding a `.git` directory is a
    // work tree whose contents Git names. A `walk` is the selected root
    // outside any work tree, or a work tree Git could not answer for.
    if (
      directory.kind === "tree" &&
      !git &&
      entries.some((entry) => entry.name === ".git" && entry.isDirectory()) &&
      askGit(directory.path)
    )
      continue;
    // A nested Git-file checkout is a repository boundary, not another copy of
    // the selected project's payload to walk. The normal root scan owns common
    // administration; never follow the pointer. Never prune the selected root or
    // directories already recognized as Git administration.
    if (
      directory.path !== root &&
      !git &&
      entries.some((entry) => entry.name === ".git" && entry.isFile())
    ) {
      readOnly.push(join(directory.path, ".git"));
      continue;
    }
    if (git) {
      immovable.push(directory.path);
      // A read-only commondir naming another directory makes hooks and config
      // common paths that Git never reads here; protect them only where this
      // directory is its own common directory (bwrap caps its argv at 9,000).
      if (!has("commondir") || !sharesCommonDirectory(directory.path))
        readOnly.push(
          join(directory.path, "hooks"),
          join(directory.path, "config"),
        );
      readOnly.push(
        join(directory.path, "config.worktree"),
        // Redirects config and hooks to another common directory.
        join(directory.path, "commondir"),
      );
    }
    for (const entry of entries) {
      const path = join(directory.path, entry.name);
      if (entry.name === ".git" && !entry.isDirectory()) readOnly.push(path); // Never parse a Git pointer or grant an external dir.
      if (!entry.isDirectory()) continue; // No symlink cycles or outside walks.
      let kind: Kind = "tree";
      if (git && entry.name === "modules") kind = "modules";
      else if (git && entry.name === "worktrees") kind = "worktrees";
      else if (!git && directory.kind === "modules") kind = "modules";
      else if (!git && directory.kind === "worktrees") kind = "git";
      queue(path, kind);
    }
  }
  return {
    readOnly: [...new Set(readOnly)],
    immovable: [...new Set(immovable)],
  };
}

/**
 * Recompute for every command: the previous command may have initialized Git.
 * An internal caller may tighten the directory budget, never widen the ceiling.
 */
export function sandboxPolicy(
  project: string,
  folder: string,
  directoryLimit = maximumDiscoveryDirectories,
): LocalSandboxPolicy {
  const limit = discoveryDirectoryLimit.parse(directoryLimit);
  const root = realpathSync(project);
  const writableRoot = realpathSync(folder);
  const within = relative(root, writableRoot);
  if (isAbsolute(within) || within === ".." || within.startsWith(`..${sep}`))
    throw new Error("Sandbox folder resolves outside the project.");
  if (!lstatSync(writableRoot).isDirectory())
    throw new Error("Sandbox folder must be a directory.");
  const git = gitProtection(root, writableRoot, limit);
  return {
    projectRoot: root,
    writableRoot,
    readOnly: [join(writableRoot, ".fungi"), ...git.readOnly],
    immovable: git.immovable,
  };
}
