import { isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
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
  if (within === ".fungi" || within.startsWith(`.fungi${sep}`))
    throw new Error("Agent folder cannot be inside protected project .fungi");
  if (!lstatSync(absolute).isDirectory())
    throw new Error("Agent folder must be a directory");
  return { folder: within.split(sep).join("/") || ".", absolute };
}

/** Containment authority, not an approval setting or an execution mode. */
export type LocalSandboxPolicy = Readonly<{
  projectRoot: string;
  writableRoot: string;
  /** Whole Git administration and Agent state, read-only in Workspace. */
  readOnly: readonly string[];
}>;

/** The host, never project configuration, chooses every writable cache grant. */
export type LinuxSandboxProfile = LocalSandboxPolicy &
  Readonly<{
    mode: "workspace" | "read-only";
    writable: readonly string[];
    hidden: readonly string[];
    temporaryDirectory: string;
    /** Host-selected cache carve-out to prepare before rendering bwrap mounts. */
    fungiCache: string | undefined;
    sshAgentSocket: string | undefined;
    sshAgentMask: string | undefined;
  }>;

function existingDirectory(path: string): string[] {
  if (!isAbsolute(path)) return [];
  try {
    return statSync(path).isDirectory() ? [realpathSync(path)] : [];
  } catch (cause) {
    if (unreadableEntry(cause)) return [];
    throw cause;
  }
}

function covers(root: string, path: string): boolean {
  return within(root, path);
}

export function linuxSandboxProfile(
  policy: LocalSandboxPolicy,
  mode: "workspace" | "read-only",
  temporaryDirectory: string,
  host: NodeJS.ProcessEnv,
  /** Pass the real passwd home in production; fixtures supply their own. */
  osHome: string,
  platform: "linux" | "darwin" = "linux",
): LinuxSandboxProfile {
  const home = host.HOME ?? osHome;
  if (!isAbsolute(home)) throw new Error("Sandbox HOME must be absolute");
  if (!isAbsolute(osHome)) throw new Error("Sandbox OS home must be absolute");
  const cache = host.XDG_CACHE_HOME ?? join(home, ".cache");
  const data = host.XDG_DATA_HOME ?? join(home, ".local", "share");
  const cargo = host.CARGO_HOME ?? join(home, ".cargo");
  const caches = [
    cache,
    join(home, ".npm"),
    join(host.PNPM_HOME ?? join(data, "pnpm"), "store"),
    join(home, ".bun", "install", "cache"),
    join(cargo, "registry"),
    join(cargo, "git"),
    host.GOMODCACHE ?? join(home, "go", "pkg", "mod"),
    host.GOCACHE ?? join(cache, "go-build"),
  ];
  const socket = host.SSH_AUTH_SOCK;
  const selectedSocket =
    socket &&
    isAbsolute(socket) &&
    statSync(socket, { throwIfNoEntry: false })?.isSocket()
      ? socket
      : undefined;
  const writableCaches = [...new Set(caches.flatMap(existingDirectory))].filter(
    (path) =>
      !covers(path, join(home, ".cargo", "bin")) &&
      !covers(path, join(home, ".local", "bin")),
  );
  const fungiCache = canonicalPath(join(cache, "fungi"));
  const protectedFungiCache =
    mode === "workspace" &&
    writableCaches.some((path) => covers(path, fungiCache))
      ? fungiCache
      : undefined;
  // A previous service can leave fallback Agent temp behind even when this
  // Agent has moved to XDG_RUNTIME_DIR. Never expose either host candidate.
  const fallbackTemporaryBases = [
    ...new Set(
      [home, osHome]
        .map((root) => join(root, ".cache", "fungi", "tmp"))
        .flatMap(existingDirectory),
    ),
  ];
  return {
    ...policy,
    readOnly:
      protectedFungiCache === undefined
        ? policy.readOnly
        : [...policy.readOnly, protectedFungiCache],
    mode,
    temporaryDirectory,
    fungiCache: protectedFungiCache,
    writable:
      mode === "workspace"
        ? [...new Set([policy.writableRoot, ...writableCaches])]
        : [],
    hidden: [
      join(home, ".config", "fungi"),
      join(home, ".fungi", "service"),
      // Linux mounts a private tmpfs over siblings after re-binding our temp.
      // Seatbelt's path denial would also hide the Agent's own fallback temp.
      ...(platform === "linux" ? fallbackTemporaryBases : []),
    ],
    sshAgentSocket: mode === "workspace" ? selectedSocket : undefined,
    sshAgentMask: mode === "read-only" ? selectedSocket : undefined,
  };
}

/** Private persistent Agent temp, not the staging directory or host /tmp. */
export function agentSandboxTemporaryDirectory(
  agentId: string,
  project: string,
): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(agentId))
    throw new Error("Invalid Local Agent ID for temporary directory");
  const home = userInfo().homedir;
  const runtime = process.env.XDG_RUNTIME_DIR;
  const base =
    runtime && isAbsolute(runtime)
      ? join(runtime, "fungi", "tmp")
      : join(home, ".cache", "fungi", "tmp");
  const projectRoot = realpathSync(project);
  if (
    [resolve(base), canonicalPath(base)].some(
      (path) => within(projectRoot, path) || inGitAdministration(path),
    )
  )
    throw new Error(
      "Agent temporary directory cannot live in the Agent project or Git administration",
    );
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const directory = join(base, agentId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (within(projectRoot, realpathSync(directory)))
    throw new Error(
      "Agent temporary directory resolved into the Agent project",
    );
  const metadata = lstatSync(directory);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0
  )
    throw new Error("Local Agent temporary directory must be private");
  return realpathSync(directory);
}

export class UnsafeNativePayload extends Error {
  override readonly name = "UnsafeNativePayload";
}

export class UnsafeHostCode extends Error {
  override readonly name = "UnsafeHostCode";
}

/** A symlinked Git marker cannot be protected by a bind on its logical name. */
export class UnsafeGitMarker extends Error {
  override readonly name = "UnsafeGitMarker";
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

// One bounded host Git query per writable folder, regardless of repository size.
const maximumGitOutputBytes = 16 * 1024;
const gitTimeoutMilliseconds = 30_000;

/** Host Git from absolute PATH entries; never a binary the Agent can write. */
function hostGit(
  project: string,
  path: string,
  strictPath: boolean,
): string | undefined {
  for (const directory of path.split(":")) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, "git");
    try {
      accessSync(candidate, constants.X_OK);
      const actual = realpathSync(candidate);
      if (!statSync(actual).isFile()) continue;
      // A grant must inspect the first executable on its command PATH. For
      // sandbox discovery, keep looking for a trusted Git instead.
      if (
        [candidate, actual].some(
          (location) =>
            within(project, location) || inGitAdministration(location),
        )
      ) {
        if (strictPath) return undefined;
        continue;
      }
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

/** Missing, denied or looping PATH entry; never a reason to grant a Git path. */
function unreadableEntry(cause: unknown): boolean {
  if (!(cause instanceof Error) || !("code" in cause)) return false;
  switch (cause.code) {
    case "ENOENT":
    case "ENOTDIR":
    case "ELOOP":
    case "EACCES":
    case "EISDIR":
      return true;
    default:
      return false;
  }
}

/** Git owns the representation of the selected folder's worktree and common dir. */
export function gitDirectories(project: string, root: string, path?: string) {
  const git = hostGit(
    project,
    path ?? process.env.PATH ?? "",
    path !== undefined,
  );
  if (git === undefined) return undefined;
  // Configuration may be Agent-authored: no fsmonitor process, untracked
  // cache, pager, inherited GIT_* override, or index write on the host.
  const result = spawnSync(
    git,
    [
      "--no-pager",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-C",
      root,
      "rev-parse",
      "--absolute-git-dir",
      "--git-common-dir",
    ],
    {
      cwd: root,
      env: gitEnvironment(),
      maxBuffer: maximumGitOutputBytes,
      timeout: gitTimeoutMilliseconds,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    !isUtf8(result.stdout)
  )
    return undefined;
  // A newline in a reported path is ambiguous in rev-parse's line protocol;
  // do not turn any partial answer into an external writable grant.
  const locations = result.stdout.toString("utf8").split("\n");
  if (locations.length !== 3 || locations[2] !== "") return undefined;
  const [gitDir, commonDir] = locations;
  if (gitDir === undefined || !isAbsolute(gitDir) || !commonDir)
    return undefined;
  try {
    const worktree = realpathSync(gitDir);
    const common = realpathSync(resolve(root, commonDir));
    if (!statSync(worktree).isDirectory() || !statSync(common).isDirectory())
      return undefined;
    return { common, worktree };
  } catch (cause) {
    if (unreadableEntry(cause)) return undefined;
    throw cause;
  }
}

/** Remote names from the protected common config only, never a racy worktree path. */
export function protectedGitRemoteNames(
  project: string,
  common: string,
  path: string,
): ReadonlySet<string> | undefined {
  const git = hostGit(project, path, true);
  if (git === undefined) return undefined;
  const config = join(common, "config");
  const entry = lstatSync(config, { throwIfNoEntry: false });
  if (entry === undefined || !entry.isFile() || entry.nlink !== 1)
    return undefined;
  // --file plus --no-includes excludes global and Agent-writable included
  // config. Git, not a handwritten config reader, decodes its own format.
  const result = spawnSync(
    git,
    [
      "config",
      "--no-includes",
      "--file",
      config,
      "--null",
      "--name-only",
      "--get-regexp",
      "^remote\\..*\\.url$",
    ],
    {
      cwd: project,
      env: gitEnvironment(),
      maxBuffer: maximumGitOutputBytes,
      timeout: gitTimeoutMilliseconds,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.error !== undefined || !isUtf8(result.stdout)) return undefined;
  if (result.status === 1 && result.stdout.length === 0) return new Set();
  if (result.status !== 0 || result.stdout.at(-1) !== 0) return undefined;
  const names = new Set<string>();
  for (const key of result.stdout.toString("utf8").slice(0, -1).split("\0")) {
    const name = /^remote\.([A-Za-z][A-Za-z0-9_.-]*)\.url$/u.exec(key)?.[1];
    if (name !== undefined) names.add(name);
  }
  return names;
}

/** Recompute for each command: the prior command may have initialized Git. */
export function sandboxPolicy(
  project: string,
  folder: string,
): LocalSandboxPolicy {
  const root = realpathSync(project);
  const writableRoot = realpathSync(folder);
  const remainder = relative(root, writableRoot);
  if (
    isAbsolute(remainder) ||
    remainder === ".." ||
    remainder.startsWith(`..${sep}`)
  )
    throw new Error("Sandbox folder resolves outside the project.");
  if (!lstatSync(writableRoot).isDirectory())
    throw new Error("Sandbox folder must be a directory.");
  // Do not create a marker on the host for an absent .git.
  const marker = join(writableRoot, ".git");
  const readOnly = [join(writableRoot, ".fungi")];
  const markerEntry = lstatSync(marker, { throwIfNoEntry: false });
  if (markerEntry === undefined)
    return { projectRoot: root, writableRoot, readOnly };
  if (markerEntry.isSymbolicLink())
    throw new UnsafeGitMarker(
      `Agent folder ${marker} is a symlink. Remove the .git symlink or select a different Agent folder before running sandboxed commands.`,
    );
  readOnly.push(marker);
  const git = gitDirectories(root, writableRoot);
  if (git !== undefined) readOnly.push(git.worktree, git.common);
  return { projectRoot: root, writableRoot, readOnly: [...new Set(readOnly)] };
}
