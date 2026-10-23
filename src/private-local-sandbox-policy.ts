import { lstatSync, readdirSync, realpathSync } from "node:fs";
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
  writableRoot: string;
  readOnly: readonly string[];
  immovable: readonly string[];
}>;

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

function gitProtection(root: string, directoryLimit: number) {
  type Kind = "tree" | "modules" | "worktrees" | "git";
  const pending: { path: string; kind: Kind }[] = [
    { path: root, kind: "tree" },
  ];
  const readOnly: string[] = [];
  const immovable: string[] = [];
  let discoveredDirectories = 1; // The writable root itself.
  for (
    let directory = pending.pop();
    directory !== undefined;
    directory = pending.pop()
  ) {
    const entries = readdirSync(directory.path, { withFileTypes: true });
    const has = (name: string) => entries.some((entry) => entry.name === name);
    const git =
      directory.kind === "git" ||
      basename(directory.path) === ".git" ||
      (has("HEAD") && (has("objects") || has("commondir"))) ||
      (directory.kind === "modules" &&
        (has("HEAD") || has("config") || has("hooks")));
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
      readOnly.push(
        join(directory.path, "hooks"),
        join(directory.path, "config"),
        join(directory.path, "config.worktree"),
      );
    }
    for (const entry of entries) {
      const path = join(directory.path, entry.name);
      if (entry.name === ".git" && !entry.isDirectory()) readOnly.push(path); // Never parse a Git pointer or grant an external dir.
      if (!entry.isDirectory()) continue; // No symlink cycles or outside walks.
      discoveredDirectories += 1;
      if (discoveredDirectories > directoryLimit)
        throw new Error(
          `Sandbox Git discovery exceeds ${String(directoryLimit)} directories`,
        );
      let kind: Kind = "tree";
      if (git && entry.name === "modules") kind = "modules";
      else if (git && entry.name === "worktrees") kind = "worktrees";
      else if (!git && directory.kind === "modules") kind = "modules";
      else if (!git && directory.kind === "worktrees") kind = "git";
      pending.push({ path, kind });
    }
  }
  return { readOnly, immovable };
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
  const git = gitProtection(writableRoot, limit);
  return {
    writableRoot,
    readOnly: [join(writableRoot, ".fungi"), ...git.readOnly],
    immovable: git.immovable,
  };
}
