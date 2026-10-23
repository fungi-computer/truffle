import { open, opendir, realpath, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type {
  SkillCatalog,
  SkillDescription,
  SkillDiagnostic,
  SkillOrigin,
  SkillSource,
} from "@fungi.computer/shiitake-extensions/skills/source";

const maximumSkillCount = 64;
const maximumCatalogBytes = 16_000;
const maximumFileBytes = 128 * 1_024;
const maximumDirectoryEntries = 512;
const maximumSupportingDepth = 16;
const maximumDiscoveryDepth = 16;
const utf8 = new TextEncoder();
const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const frontmatterSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  "disable-model-invocation": z
    .unknown()
    .default(false)
    .transform((value) => value === true),
});
const fileSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (file) =>
      !isAbsolute(file) &&
      !file.includes("\\") &&
      !file.includes("\0") &&
      file
        .split("/")
        .every((part) => part !== "" && part !== "." && part !== ".."),
    "Skill file must remain a relative path inside its skill directory",
  );

function absent(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

function contained(root: string, path: string): string {
  const within = relative(root, path);
  if (
    isAbsolute(within) ||
    within === ".." ||
    within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
  )
    throw new Error("Skill path escapes its directory");
  return path;
}

function inside(root: string, path: string): string | undefined {
  const within = relative(root, path);
  return within === "" ||
    isAbsolute(within) ||
    within === ".." ||
    within.startsWith(`..${sep}`)
    ? undefined
    : within;
}

/** The model's view of a skill file: invocation-relative, `~/…`, else absolute. */
function displayLocation(
  location: string,
  roots: Readonly<{ cwd: string; home: string }>,
): string {
  const project = inside(roots.cwd, location);
  if (project !== undefined) return project;
  const personal = inside(roots.home, location);
  return personal === undefined ? location : join("~", personal);
}

async function readBounded(path: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const handle = await open(path, "r");
  try {
    if (!(await handle.stat()).isFile())
      throw new Error("Skill path is not a regular file");
    const bytes = Buffer.alloc(maximumFileBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      signal.throwIfAborted();
      const page = await handle.read(bytes, size, bytes.length - size, size);
      if (page.bytesRead === 0) break;
      size += page.bytesRead;
    }
    if (size > maximumFileBytes)
      throw new Error("Skill file exceeds the 128 KiB bound");
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes.subarray(0, size),
    );
  } finally {
    await handle.close();
  }
}

class SkillSourceError extends Error {}

function diagnostic(
  path: string,
  reason: SkillDiagnostic["reason"],
  message: string,
  cause: unknown = new Error(message),
): SkillDiagnostic {
  return { path, reason, message, cause };
}

function explanation(cause: unknown, fallback: string): string {
  return cause instanceof SkillSourceError ? cause.message : fallback;
}

function parseSkill(content: string, directory: string) {
  const normalized = content.replace(/\r\n?/gu, "\n");
  const match = /^---\n([\s\S]*?)\n---(?:\n|$)/u.exec(normalized);
  if (!match) throw new SkillSourceError("SKILL.md requires YAML frontmatter");
  let frontmatter: unknown;
  try {
    frontmatter = parseYaml(match[1] ?? "");
  } catch (cause) {
    throw new SkillSourceError("Skill frontmatter is not valid YAML", {
      cause,
    });
  }
  const result = frontmatterSchema.safeParse(frontmatter);
  if (!result.success)
    throw new SkillSourceError("Skill frontmatter has invalid field types", {
      cause: result.error,
    });
  const metadata = result.data;
  if (metadata.description === undefined || metadata.description.trim() === "")
    throw new SkillSourceError("description is required");
  const name =
    metadata.name === ""
      ? basename(directory)
      : (metadata.name ?? basename(directory));
  return {
    metadata: { ...metadata, name, description: metadata.description },
    body: normalized.slice(match[0].length),
  };
}

async function discoveryRoots(cwd: string): Promise<string[]> {
  const project = [join(cwd, ".fungi/skills")];
  let ancestor = cwd;
  for (;;) {
    project.push(join(ancestor, ".agents/skills"));
    try {
      await stat(join(ancestor, ".git"));
      break;
    } catch (cause) {
      if (!absent(cause)) throw cause;
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  return project;
}

async function configuredRoots(
  path: string,
  base: string,
  home: string,
  signal: AbortSignal,
  diagnostics: SkillDiagnostic[],
): Promise<string[]> {
  const settingsSchema = z.object({
    skills: z.array(z.string().trim().min(1)).max(64).default([]),
  });
  try {
    const settings = settingsSchema.parse(
      JSON.parse(await readBounded(path, signal)),
    );
    return settings.skills.map((folder) =>
      folder === "~"
        ? home
        : folder.startsWith("~/")
          ? resolve(home, folder.slice(2))
          : resolve(base, folder),
    );
  } catch (cause) {
    signal.throwIfAborted();
    if (!absent(cause))
      diagnostics.push(
        diagnostic(
          path,
          "invalid",
          "Local settings must be valid JSON with a skills list of extra folders",
          cause,
        ),
      );
    return [];
  }
}

/** One folder to search, labeled once with where it came from. */
type LabeledRoot = Readonly<{
  path: string;
  origin: SkillOrigin;
  /** A folder someone named (settings or an enabled extension) must exist. */
  named: boolean;
}>;

function describeOrigin(origin: SkillOrigin): string {
  return origin.kind === "extension"
    ? `extension ${origin.extensionId}`
    : origin.kind;
}

/** An enabled extension's skills folder, as the extension owner reports it. */
export type ExtensionSkillFolder = Readonly<{
  extensionId: string;
  directory: string;
}>;

/** Walk labeled roots in order; the first skill with a name wins. */
async function scanRoots(
  roots: readonly LabeledRoot[],
  displayRoots: Readonly<{ cwd: string; home: string }>,
  signal: AbortSignal,
  diagnostics: SkillDiagnostic[],
): Promise<SkillCatalog> {
  const skills: SkillDescription[] = [];
  const owners = new Map<string, SkillOrigin>();
  const paths = new Set<string>();
  const visitedRoots = new Set<string>();
  for (const { path, origin, named } of roots) {
    signal.throwIfAborted();
    let root: string;
    try {
      root = await realpath(path);
    } catch (cause) {
      signal.throwIfAborted();
      if (!absent(cause) || named)
        diagnostics.push({
          path,
          reason: "unavailable",
          message: "Skill root is unavailable",
          cause,
        });
      continue;
    }
    if (visitedRoots.has(root)) continue;
    visitedRoots.add(root);
    const visited = new Set<string>();
    let entries = 0;
    let found = 0;
    const before = diagnostics.length;
    const walk = async (directory: string, depth: number): Promise<void> => {
      signal.throwIfAborted();
      if (depth > maximumDiscoveryDepth) {
        diagnostics.push(
          diagnostic(
            directory,
            "bound",
            "Skill discovery exceeds its 16-level depth bound",
          ),
        );
        return;
      }
      if (visited.has(directory)) return;
      visited.add(directory);
      const skillPath = join(directory, "SKILL.md");
      let location: string | undefined;
      try {
        location = contained(directory, await realpath(skillPath));
      } catch (cause) {
        signal.throwIfAborted();
        if (!absent(cause)) {
          diagnostics.push({
            path: skillPath,
            reason: "invalid",
            message: "Skill file escapes its directory or cannot be read",
            cause,
          });
          return;
        }
      }
      if (location !== undefined) {
        found++;
        try {
          if (paths.has(location)) return;
          paths.add(location);
          const { metadata } = parseSkill(
            await readBounded(location, signal),
            directory,
          );
          if (
            !nameSchema.safeParse(metadata.name).success ||
            metadata.name !== basename(directory)
          )
            diagnostics.push(
              diagnostic(
                skillPath,
                "warning",
                "Skill name should match its directory, use lowercase letters, digits and single hyphens, and be at most 64 characters",
              ),
            );
          if (metadata.description.length > 1_024)
            diagnostics.push(
              diagnostic(
                skillPath,
                "warning",
                "Skill description exceeds the recommended 1024 characters",
              ),
            );
          const winner = owners.get(metadata.name);
          if (winner !== undefined) {
            diagnostics.push(
              diagnostic(
                skillPath,
                "collision",
                `${describeOrigin(winner)} skill ${metadata.name} wins over ${describeOrigin(origin)}`,
              ),
            );
            return;
          }
          owners.set(metadata.name, origin);
          if (metadata["disable-model-invocation"]) {
            diagnostics.push(
              diagnostic(
                skillPath,
                "skipped",
                "Skill disables model invocation",
              ),
            );
            return;
          }
          const skill = {
            name: metadata.name,
            description: metadata.description,
            location,
            displayLocation: displayLocation(location, displayRoots),
            origin,
          };
          if (
            skills.length >= maximumSkillCount ||
            utf8.encode(JSON.stringify([...skills, skill])).byteLength >
              maximumCatalogBytes
          ) {
            diagnostics.push(
              diagnostic(
                skillPath,
                "bound",
                "Skill catalog exceeds its 64-skill or 16 KB bound",
              ),
            );
            return;
          }
          skills.push(skill);
        } catch (cause) {
          signal.throwIfAborted();
          diagnostics.push({
            path: skillPath,
            reason: "invalid",
            message: explanation(cause, "Skill metadata or file is invalid"),
            cause,
          });
        }
        return;
      }
      const children: string[] = [];
      for await (const entry of await opendir(directory)) {
        signal.throwIfAborted();
        if (++entries > maximumDirectoryEntries)
          throw new SkillSourceError(
            "Skill discovery exceeds its 512-entry bound",
          );
        if (entry.name.startsWith(".") || entry.name === "node_modules") {
          if (entry.isDirectory() || entry.isSymbolicLink())
            diagnostics.push(
              diagnostic(
                join(directory, entry.name),
                "skipped",
                "Dot directories and node_modules are not searched",
              ),
            );
          continue;
        }
        children.push(entry.name);
      }
      for (const child of children.sort()) {
        const candidate = join(directory, child);
        try {
          const canonical = contained(root, await realpath(candidate));
          if ((await stat(canonical)).isDirectory())
            await walk(canonical, depth + 1);
        } catch (cause) {
          signal.throwIfAborted();
          if (cause instanceof SkillSourceError) throw cause;
          diagnostics.push(
            diagnostic(
              join(candidate, "SKILL.md"),
              "invalid",
              "Skill entry escapes its root or is unavailable",
              cause,
            ),
          );
        }
      }
    };
    try {
      await walk(root, 0);
      if (found === 0 && diagnostics.length === before)
        diagnostics.push(
          diagnostic(
            path,
            "empty",
            entries === 0
              ? "Skill root is empty"
              : "Skill root contains no SKILL.md files",
          ),
        );
    } catch (cause) {
      signal.throwIfAborted();
      diagnostics.push({
        path,
        reason: cause instanceof SkillSourceError ? "bound" : "unavailable",
        message: explanation(cause, "Skill root cannot be searched"),
        cause,
      });
    }
  }
  return { skills, diagnostics };
}

/** What an extension's skills folder offers, for the install prompt. */
export function describeExtensionSkills(
  folder: ExtensionSkillFolder,
  signal: AbortSignal,
): Promise<SkillCatalog> {
  // The install prompt lists names only, so display paths are never shown.
  return scanRoots(
    [
      {
        path: folder.directory,
        origin: { kind: "extension", extensionId: folder.extensionId },
        named: true,
      },
    ],
    { cwd: folder.directory, home: folder.directory },
    signal,
    [],
  );
}

/**
 * Discover skills without widening the invocation Files jail. Folders are
 * searched project first, then personal, then installed extensions' (lowest);
 * the first skill with a name wins, so your own skill beats an extension's.
 * `extensions` is already filtered by the extension owner's activation: a
 * folder that is not passed here contributes nothing. Local installed
 * extensions only; Hub-hosted extensions are not covered.
 */
export function createLocalSkillSource(
  options: Readonly<{
    cwd: string;
    home: string;
    extensions?: readonly ExtensionSkillFolder[];
  }>,
): SkillSource {
  const cwd = resolve(options.cwd);
  const home = resolve(options.home);
  // Skill files are canonical paths, so compare them with canonical roots.
  // A root that does not exist has no symlinks to resolve; any other failure
  // (permissions, loops) propagates to the caller.
  const canonical = async (path: string): Promise<string> => {
    try {
      return await realpath(path);
    } catch (cause) {
      if (absent(cause)) return path;
      throw cause;
    }
  };
  const catalog = async (signal: AbortSignal): Promise<SkillCatalog> => {
    const displayRoots = {
      cwd: await canonical(cwd),
      home: await canonical(home),
    };
    const diagnostics: SkillDiagnostic[] = [];
    const projectExtras = await configuredRoots(
      join(cwd, ".fungi/settings.json"),
      cwd,
      home,
      signal,
      diagnostics,
    );
    const personalExtras = await configuredRoots(
      join(home, ".fungi/settings.json"),
      join(home, ".fungi"),
      home,
      signal,
      diagnostics,
    );
    const project: SkillOrigin = { kind: "project" };
    const personal: SkillOrigin = { kind: "personal" };
    const roots: readonly LabeledRoot[] = [
      ...(await discoveryRoots(cwd)).map((path) => ({
        path,
        origin: project,
        named: false,
      })),
      ...projectExtras.map((path) => ({ path, origin: project, named: true })),
      ...[join(home, ".fungi/skills"), join(home, ".agents/skills")].map(
        (path) => ({ path, origin: personal, named: false }),
      ),
      ...personalExtras.map((path) => ({
        path,
        origin: personal,
        named: true,
      })),
      ...(options.extensions ?? []).map(({ extensionId, directory }) => ({
        path: directory,
        origin: { kind: "extension", extensionId } satisfies SkillOrigin,
        named: true,
      })),
    ];
    return scanRoots(roots, displayRoots, signal, diagnostics);
  };
  return {
    catalog,
    read: async (name, file, signal) => {
      z.string().min(1).parse(name);
      const found = (await catalog(signal)).skills.find(
        (skill) => skill.name === name,
      );
      if (!found) throw new Error(`Unknown or hidden skill: ${name}`);
      const baseDirectory = dirname(found.location);
      const selected = file === undefined ? "SKILL.md" : fileSchema.parse(file);
      const path = contained(
        baseDirectory,
        await realpath(join(baseDirectory, selected)),
      );
      const content = await readBounded(path, signal);
      if (selected !== "SKILL.md")
        return {
          name,
          file: selected,
          content,
          baseDirectory,
          supportingFiles: [],
        };
      const parsed = parseSkill(content, baseDirectory);
      if (parsed.metadata["disable-model-invocation"])
        throw new Error(`Hidden skill: ${name}`);
      const supportingFiles: string[] = [];
      let entries = 0;
      const walk = async (directory: string, depth: number): Promise<void> => {
        if (depth > maximumSupportingDepth)
          throw new Error("Skill supporting files exceed depth bound");
        for await (const entry of await opendir(directory)) {
          signal.throwIfAborted();
          if (++entries > maximumDirectoryEntries)
            throw new Error("Skill supporting files exceed entry bound");
          const path = contained(
            baseDirectory,
            await realpath(join(directory, entry.name)),
          );
          // Directory symlinks are not traversed; direct reads still enforce realpath containment.
          if (entry.isDirectory()) await walk(path, depth + 1);
          else if ((await stat(path)).isFile() && path !== found.location)
            supportingFiles.push(relative(baseDirectory, path));
        }
      };
      await walk(baseDirectory, 0);
      return {
        name,
        file: selected,
        content: parsed.body,
        baseDirectory,
        supportingFiles: supportingFiles.sort(),
      };
    },
  };
}
