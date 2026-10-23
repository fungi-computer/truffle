import { createHash } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Mycelium } from "@fungi.computer/mycelium";
import {
  defineExtension,
  ExtensionId,
  type ExtensionCapabilityV0,
  type ExtensionGrantV0,
  type RosteredExtensionV0,
} from "@fungi.computer/shiitake/extensions";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";
import {
  describeExtensionSkills,
  type ExtensionSkillFolder,
} from "./local-skill-source.js";

/**
 * Installed Local extensions. One owner holds the package bytes under
 * `~/.fungi/extensions`, and the activations its typed operations write. A
 * project's client part and program launchers, and an Agent's tools, are
 * separate activations keyed by canonical path. Nothing under a project or
 * Agent store authorizes anything: a copied folder starts disabled.
 *
 * A package may also ship a `skills` folder. Its skills are read in place
 * from the installed package (nothing is copied or symlinked) and only while
 * the Agent's activation opts in, so disabling or removing the extension ends
 * them. This covers Local installed extensions only; Hub-hosted extensions
 * are not covered.
 */

const capabilities = [
  "state",
  "attention",
  "settled",
  "send",
  "timers",
  "commands",
  "projection",
  "run_tools",
  "files",
  "prompt",
  "compaction_handoff",
] as const satisfies readonly ExtensionCapabilityV0[];
const decodeExtensionId = Schema.decodeUnknownSync(ExtensionId);
const identifier = z.string().regex(/^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$/u);
const revisionPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;

const manifestSchema = z.strictObject({
  id: z.string().transform((value) => decodeExtensionId(value)),
  capabilities: z.array(z.enum(capabilities)).max(10).default([]),
  /** Package-relative folder of skills, offered to an Agent that opts in. */
  skills: z.string().startsWith("./").max(1_024).optional(),
  terminals: z
    .array(
      z.strictObject({
        id: identifier.max(64),
        name: z.string().trim().min(1).max(64),
        description: z.string().max(200).default(""),
        /** Package-relative executable and its arguments. */
        command: z
          .array(z.string().min(1).max(1_024))
          .min(1)
          .max(32)
          .refine((command) => command[0]?.startsWith("./") === true, {
            message: "Terminal commands run a package-relative executable",
          }),
      }),
    )
    .max(8)
    .default([]),
});
const packageSchema = z.looseObject({
  name: z.string().min(1).max(214),
  version: z.string().min(1).max(64),
  /** Fungi entries are plain subpath exports. */
  exports: z.record(z.string(), z.string()).default({}),
  fungi: manifestSchema,
});
const terminalRecord = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  command: z.array(z.string()),
});
const revisionRecord = z.strictObject({
  name: z.string(),
  version: z.string(),
  source: z.string(),
  resolution: z.string(),
  commit: z.string().nullable(),
  directory: z.string(),
  capabilities: z.array(z.enum(capabilities)),
  terminals: z.array(terminalRecord),
  host: z.string().nullable(),
  client: z.string().nullable(),
  skills: z.string().nullable(),
});
const installedSchema = z.strictObject({
  extensions: z.record(
    z.string(),
    z.strictObject({
      current: z.string(),
      revisions: z.record(z.string(), revisionRecord),
    }),
  ),
});
const activationsSchema = z.strictObject({
  projects: z.record(z.string(), z.record(z.string(), z.string())),
  agents: z.record(
    z.string(),
    z.record(
      z.string(),
      z.strictObject({
        revision: z.string(),
        capabilities: z.array(z.enum(capabilities)),
        /** The opt-in to the revision's skills folder; separate from tools. */
        skills: z.boolean(),
      }),
    ),
  ),
});
const lockSchema = z.looseObject({
  packages: z.record(z.string(), z.array(z.unknown()).min(1)),
});
const hostModuleSchema = z.looseObject({
  default: z.custom<LocalExtensionFactoryV1>(
    (value) => Predicate.isFunction(value),
    { message: "An extension host entry exports a default factory" },
  ),
});
const rosteredSchema = z.looseObject({
  manifest: z.looseObject({
    id: z.string(),
    requests: z.array(z.enum(capabilities)),
  }),
});

type InstalledRevision = z.infer<typeof revisionRecord>;
type Installed = z.infer<typeof installedSchema>;
type Activations = z.infer<typeof activationsSchema>;

export type LocalExtensionFailureReason =
  | "install"
  | "manifest"
  | "artifact"
  | "not-installed"
  | "not-enabled"
  | "no-tools"
  | "no-skills"
  | "not-held"
  | "load";

/** A typed refusal from the extension owner; never reported as usable. */
export class LocalExtensionError extends Error {
  override readonly name = "LocalExtensionError";
  readonly reason: LocalExtensionFailureReason;
  constructor(
    reason: LocalExtensionFailureReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.reason = reason;
  }
}

/**
 * An Agent holds an extension when its store has granted tools, covering every
 * capability of the current revision. Opting into only the extension's skills
 * is not holding it: skills carry no authority to hand its tools on.
 */
function assertAgentHolds(
  held: Activations["agents"][string] | undefined,
  installed: Installed,
  ids: readonly string[],
) {
  const missing = ids.filter((id) => {
    const activation = held?.[id];
    if (activation === undefined || activation.capabilities.length === 0)
      return true;
    const entry = installed.extensions[id];
    const needed =
      (entry === undefined ? undefined : entry.revisions[entry.current])
        ?.capabilities ?? [];
    return !needed.every((capability) =>
      activation.capabilities.includes(capability),
    );
  });
  if (missing.length > 0)
    throw new LocalExtensionError(
      "not-held",
      `An Agent cannot give ${missing.join(", ")} to another Agent: it does not hold ${missing.length === 1 ? "it" : "them"} itself`,
    );
}

/**
 * The host port an installed extension's `./host` factory receives: the
 * host's own extension SDK instances and this project's private runtime
 * directory, which its terminal programs also receive.
 */
export type LocalExtensionHostV1 = Readonly<{
  runtimeDirectory: string;
  defineExtension: typeof defineExtension;
  Mycelium: typeof Mycelium;
  z: typeof z;
}>;

/** What an installed package's `./host` entry exports by default. */
export type LocalExtensionFactoryV1 = (
  host: LocalExtensionHostV1,
) => RosteredExtensionV0 | Promise<RosteredExtensionV0>;

/** What `add` reports: the summary plus the names of the skills it ships. */
export type LocalInstalledExtension = LocalExtensionSummary &
  Readonly<{ skills: readonly string[] }>;

export type LocalExtensionSummary = Readonly<{
  id: string;
  revision: string;
  version: string;
  source: string;
  commit: string | null;
  capabilities: readonly ExtensionCapabilityV0[];
  terminals: readonly string[];
}>;

/** One program a project-enabled extension may open in a terminal pane. */
export type LocalExtensionTerminal = Readonly<{
  extensionId: string;
  terminalId: string;
  name: string;
  description: string;
  /** Absolute executable followed by its arguments. */
  command: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}>;

export type LocalProjectExtensions = Readonly<{
  /** Absolute client entries for the ordinary client-extension loader. */
  clients: readonly string[];
  terminals: readonly LocalExtensionTerminal[];
  diagnostics: readonly Error[];
}>;

export type LocalAgentExtensions = Readonly<{
  roster: readonly RosteredExtensionV0[];
  grants: readonly ExtensionGrantV0[];
  /** Skills folders of extensions this Agent opted into, read in place. */
  skills: readonly ExtensionSkillFolder[];
  /** Extensions left out of this Agent's roster, and why. */
  diagnostics: readonly Readonly<{ extensionId: string; error: Error }>[];
}>;

export type LocalExtensionsOptions = Readonly<{
  /** The selected user home that owns `.fungi/extensions`. */
  home: string;
}>;

function failure(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function absent(cause: unknown) {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "ENOENT" || cause.code === "ENOTDIR")
  );
}

/** Open the one extension owner for a user home. */
export function localExtensions(options: LocalExtensionsOptions) {
  const root = join(resolve(options.home), ".fungi", "extensions");
  const installedPath = join(root, "installed.json");
  const activationsPath = join(root, "activations.json");

  async function readJson<T>(
    path: string,
    schema: z.ZodType<T>,
    empty: T,
    remedy: string,
  ): Promise<T> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (cause) {
      if (absent(cause)) return empty;
      throw cause;
    }
    const parsed = schema.safeParse(JSON.parse(text));
    if (!parsed.success)
      throw new LocalExtensionError(
        "install",
        `${path} is from an earlier extension format; ${remedy}`,
        { cause: parsed.error },
      );
    return parsed.data;
  }
  const readInstalled = () =>
    readJson(
      installedPath,
      installedSchema,
      { extensions: {} },
      "delete it and run `fungi extension add` again",
    );
  const readActivations = () =>
    readJson(
      activationsPath,
      activationsSchema,
      { projects: {}, agents: {} },
      "delete it, then re-enable your extensions",
    );

  /** Serialize owner writes across CLI and service processes. */
  async function update<T>(
    change: (installed: Installed, activations: Activations) => T,
  ): Promise<T> {
    await mkdir(root, { recursive: true, mode: 0o700 });
    const release = await lockfile.lock(root, {
      realpath: false,
      lockfilePath: join(root, ".owner.lock"),
      stale: 30_000,
      update: 10_000,
      retries: { retries: 20, factor: 1.2, minTimeout: 25, maxTimeout: 100 },
    });
    try {
      const installed = await readInstalled();
      const activations = await readActivations();
      const result = change(installed, activations);
      const options = { encoding: "utf8", fsync: true, mode: 0o600 } as const;
      await writeFileAtomic(
        installedPath,
        `${JSON.stringify(installed, null, 2)}\n`,
        options,
      );
      await writeFileAtomic(
        activationsPath,
        `${JSON.stringify(activations, null, 2)}\n`,
        options,
      );
      return result;
    } finally {
      await release();
    }
  }

  function currentRevision(installed: Installed, id: string) {
    const entry = installed.extensions[id];
    const revision =
      entry === undefined ? undefined : entry.revisions[entry.current];
    if (entry === undefined || revision === undefined)
      throw new LocalExtensionError(
        "not-installed",
        `Extension ${id} is not installed`,
      );
    return { revision: entry.current, record: revision };
  }

  /** A 0700 directory shared by one project's programs and Agent tools. */
  async function runtimeDirectory(projectRoot: string, id: string) {
    const project = createHash("sha256")
      .update(await realpath(projectRoot))
      .digest("hex")
      .slice(0, 16);
    const directory = join(root, "run", project, id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  /** A declared `./host` or `./client` export must exist in the installed package. */
  async function declaredEntry(
    directory: string,
    exports: Readonly<Record<string, string>>,
    subpath: "./host" | "./client",
  ) {
    const target = exports[subpath];
    if (target === undefined) return null;
    const path = resolve(directory, target);
    if (!path.startsWith(`${directory}${sep}`))
      throw new LocalExtensionError(
        "manifest",
        `${subpath} must point inside its package`,
      );
    try {
      await access(path, constants.R_OK);
    } catch (cause) {
      throw new LocalExtensionError(
        "artifact",
        `The package declares ${subpath} but ${target} is not built`,
        { cause },
      );
    }
    return path;
  }

  /** A declared skills folder must be a directory inside the package. */
  async function declaredSkills(
    directory: string,
    declared: string | undefined,
  ) {
    if (declared === undefined) return null;
    const path = resolve(directory, declared);
    if (!path.startsWith(`${directory}${sep}`))
      throw new LocalExtensionError(
        "manifest",
        "skills must point inside its package",
      );
    try {
      const real = await realpath(path);
      if (!real.startsWith(`${await realpath(directory)}${sep}`))
        throw new LocalExtensionError(
          "manifest",
          "skills must point inside its package",
        );
      if (!(await stat(real)).isDirectory())
        throw new LocalExtensionError(
          "artifact",
          `The package declares skills but ${declared} is not a directory`,
        );
    } catch (cause) {
      if (cause instanceof LocalExtensionError) throw cause;
      throw new LocalExtensionError(
        "artifact",
        `The package declares skills but ${declared} is not in the installed package`,
        { cause },
      );
    }
    return path;
  }

  return {
    root,

    /**
     * Install a package with the shipped Bun package manager (lifecycle
     * scripts disabled) and record the exact resolved revision. A Git source
     * is pinned to the commit Bun's lockfile resolved; updating is another
     * explicit `add`. Missing declared artifacts are a refusal.
     */
    async add(source: string): Promise<LocalInstalledExtension> {
      await mkdir(join(root, "staging"), { recursive: true, mode: 0o700 });
      const staging = await mkdtemp(join(root, "staging", "install-"));
      try {
        await writeFile(
          join(staging, "package.json"),
          `${JSON.stringify({ private: true })}\n`,
        );
        const child = Bun.spawn(
          [process.execPath, "add", "--ignore-scripts", source],
          {
            cwd: staging,
            // A private cache resolves the named ref afresh instead of a
            // cached checkout of an earlier commit.
            env: {
              ...process.env,
              BUN_BE_BUN: "1",
              BUN_INSTALL_CACHE_DIR: join(staging, ".install-cache"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [status, stderr] = await Promise.all([
          child.exited,
          new Response(child.stderr).text(),
        ]);
        if (status !== 0)
          throw new LocalExtensionError(
            "install",
            `Could not install ${source}: ${stderr.trim().slice(0, 2_000)}`,
          );
        const lock = lockSchema.parse(
          Bun.JSONC.parse(await readFile(join(staging, "bun.lock"), "utf8")),
        );
        const dependencies = Object.keys(
          z
            .looseObject({ dependencies: z.record(z.string(), z.string()) })
            .parse(
              JSON.parse(await readFile(join(staging, "package.json"), "utf8")),
            ).dependencies,
        );
        const name = dependencies[0];
        if (name === undefined || dependencies.length !== 1)
          throw new LocalExtensionError(
            "install",
            `${source} did not install exactly one package`,
          );
        const directory = join(staging, "node_modules", ...name.split("/"));
        const pkg = packageSchema.safeParse(
          JSON.parse(await readFile(join(directory, "package.json"), "utf8")),
        );
        if (!pkg.success)
          throw new LocalExtensionError(
            "manifest",
            `${source} does not declare a Fungi extension in package.json "fungi"`,
            { cause: pkg.error },
          );
        const selected = { name, directory, pkg: pkg.data };
        const entry = lock.packages[selected.name] ?? [];
        const resolution = z.string().parse(entry[0]);
        const pinned = z.string().safeParse(entry[2]);
        const git = /#([0-9a-f]{40})$/u.exec(resolution);
        const commit = git?.[1] ?? null;
        const manifest = selected.pkg.fungi;
        const host = await declaredEntry(
          selected.directory,
          selected.pkg.exports,
          "./host",
        );
        const client = await declaredEntry(
          selected.directory,
          selected.pkg.exports,
          "./client",
        );
        const skills = await declaredSkills(
          selected.directory,
          manifest.skills,
        );
        const skillNames =
          skills === null
            ? []
            : (
                await describeExtensionSkills(
                  { extensionId: manifest.id, directory: skills },
                  AbortSignal.timeout(10_000),
                )
              ).skills.map((skill) => skill.name);
        if (skills !== null && skillNames.length === 0)
          throw new LocalExtensionError(
            "artifact",
            `${manifest.id} declares skills but ${manifest.skills ?? ""} contains none`,
          );
        if (manifest.capabilities.length > 0 && host === null)
          throw new LocalExtensionError(
            "artifact",
            `${manifest.id} declares Agent capabilities but its package exports no ./host entry`,
          );
        for (const terminal of manifest.terminals) {
          const executable = resolve(
            selected.directory,
            terminal.command[0] ?? "",
          );
          if (!executable.startsWith(`${selected.directory}${sep}`))
            throw new LocalExtensionError(
              "manifest",
              `Terminal ${terminal.id} must run a file inside its package`,
            );
          try {
            await access(executable, constants.X_OK);
          } catch (cause) {
            throw new LocalExtensionError(
              "artifact",
              `Terminal ${terminal.id} program ${terminal.command[0] ?? ""} is not an executable file in the installed package`,
              { cause },
            );
          }
        }
        const revision =
          commit ??
          (pinned.success
            ? `${selected.pkg.version}-${createHash("sha256").update(pinned.data).digest("hex").slice(0, 12)}`
            : selected.pkg.version);
        if (!revisionPattern.test(revision))
          throw new LocalExtensionError(
            "manifest",
            "Installed revision is not representable",
          );
        const target = join(root, "packages", manifest.id, revision);
        const packageDirectory = join(
          target,
          "node_modules",
          ...selected.name.split("/"),
        );
        const record: InstalledRevision = {
          name: selected.name,
          version: selected.pkg.version,
          source,
          resolution,
          commit,
          directory: packageDirectory,
          capabilities: manifest.capabilities,
          terminals: manifest.terminals,
          host:
            host === null
              ? null
              : join(target, host.slice(staging.length + sep.length)),
          client:
            client === null
              ? null
              : join(target, client.slice(staging.length + sep.length)),
          skills:
            skills === null
              ? null
              : join(target, skills.slice(staging.length + sep.length)),
        };
        await update((installed) => {
          const existing = installed.extensions[manifest.id];
          installed.extensions[manifest.id] = {
            current: revision,
            revisions: { ...existing?.revisions, [revision]: record },
          };
        });
        await mkdir(join(root, "packages", manifest.id), { recursive: true });
        await rm(target, { recursive: true, force: true });
        await rename(staging, target);
        return {
          id: manifest.id,
          revision,
          version: record.version,
          source,
          commit,
          capabilities: record.capabilities,
          terminals: record.terminals.map((terminal) => terminal.id),
          skills: skillNames,
        };
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },

    /** Remove the package and every activation that references it. */
    async remove(id: string): Promise<boolean> {
      const removed = await update((installed, activations) => {
        if (installed.extensions[id] === undefined) return false;
        Reflect.deleteProperty(installed.extensions, id);
        for (const project of Object.values(activations.projects))
          Reflect.deleteProperty(project, id);
        for (const agent of Object.values(activations.agents))
          Reflect.deleteProperty(agent, id);
        return true;
      });
      // Loaded code and running programs keep their open files until their
      // own owners end; new owners can no longer select this package.
      await rm(join(root, "packages", id), { recursive: true, force: true });
      return removed;
    },

    async list(): Promise<readonly LocalExtensionSummary[]> {
      const installed = await readInstalled();
      return Object.entries(installed.extensions).flatMap(([id, entry]) => {
        const record = entry.revisions[entry.current];
        return record === undefined
          ? []
          : [
              {
                id,
                revision: entry.current,
                version: record.version,
                source: record.source,
                commit: record.commit,
                capabilities: record.capabilities,
                terminals: record.terminals.map((terminal) => terminal.id),
              },
            ];
      });
    },

    /** Enable the current revision's client part and programs for a project. */
    async enableProject(projectRoot: string, id: string) {
      const project = await realpath(projectRoot);
      return update((installed, activations) => {
        const { revision } = currentRevision(installed, id);
        activations.projects[project] = {
          ...activations.projects[project],
          [id]: revision,
        };
        return revision;
      });
    },

    async disableProject(projectRoot: string, id: string) {
      const project = await realpath(projectRoot);
      return update((_installed, activations) => {
        const enabled = activations.projects[project];
        if (enabled?.[id] === undefined) return false;
        Reflect.deleteProperty(enabled, id);
        return true;
      });
    },

    /**
     * The one check that an Agent holds an extension: refuses with
     * `not-held`, naming every id it lacks. Callers needing a whole request
     * judged before any effect call this first; `enableAgent` applies it too.
     */
    async assertHeldByAgent(
      agentStoreDirectory: string,
      ids: readonly string[],
    ) {
      const store = await realpath(agentStoreDirectory);
      const [installed, activations] = await Promise.all([
        readInstalled(),
        readActivations(),
      ]);
      assertAgentHolds(activations.agents[store], installed, ids);
    },

    /**
     * Grant one Agent store the current revision's declared capabilities.
     * Running work keeps its captured roster; the Agent applies this when it
     * next opens. A human (the CLI) names no requester. When an Agent asks, it
     * must hold the extension itself.
     */
    async enableAgent(
      storeDirectory: string,
      id: string,
      requester?: Readonly<{ agentStoreDirectory: string }>,
    ) {
      const store = await realpath(storeDirectory);
      const requesterStore =
        requester === undefined
          ? undefined
          : await realpath(requester.agentStoreDirectory);
      return update((installed, activations) => {
        if (requesterStore !== undefined)
          assertAgentHolds(activations.agents[requesterStore], installed, [id]);
        const { revision, record } = currentRevision(installed, id);
        if (record.host === null || record.capabilities.length === 0)
          throw new LocalExtensionError(
            "no-tools",
            `Extension ${id} declares no Agent capabilities`,
          );
        const skills =
          activations.agents[store]?.[id]?.skills === true &&
          record.skills !== null;
        activations.agents[store] = {
          ...activations.agents[store],
          [id]: { revision, capabilities: record.capabilities, skills },
        };
        return { revision, capabilities: record.capabilities, skills };
      });
    },

    /**
     * Opt one Agent store into the skills the extension ships, without
     * granting any tools. An existing activation keeps its revision and its
     * capabilities; a new one carries none.
     */
    async enableAgentSkills(storeDirectory: string, id: string) {
      const store = await realpath(storeDirectory);
      return update((installed, activations) => {
        const current = currentRevision(installed, id);
        const prior = activations.agents[store]?.[id];
        const revision = prior?.revision ?? current.revision;
        const record = installed.extensions[id]?.revisions[revision];
        if (!record?.skills)
          throw new LocalExtensionError(
            "no-skills",
            `Extension ${id}@${revision} ships no skills`,
          );
        activations.agents[store] = {
          ...activations.agents[store],
          [id]: {
            revision,
            capabilities: prior?.capabilities ?? [],
            skills: true,
          },
        };
        return revision;
      });
    },

    /**
     * Turn only the skills off. Tools stay granted; an activation left with
     * neither is removed.
     */
    async disableAgentSkills(storeDirectory: string, id: string) {
      const store = await realpath(storeDirectory);
      return update((_installed, activations) => {
        const enabled = activations.agents[store];
        const activation = enabled?.[id];
        if (enabled === undefined || activation?.skills !== true) return false;
        if (activation.capabilities.length === 0)
          Reflect.deleteProperty(enabled, id);
        else enabled[id] = { ...activation, skills: false };
        return true;
      });
    },

    async disableAgent(storeDirectory: string, id: string) {
      const store = await realpath(storeDirectory);
      return update((_installed, activations) => {
        const enabled = activations.agents[store];
        if (enabled?.[id] === undefined) return false;
        Reflect.deleteProperty(enabled, id);
        return true;
      });
    },

    /** The project's enabled client entries and program launchers. */
    async project(projectRoot: string): Promise<LocalProjectExtensions> {
      const project = await realpath(projectRoot);
      const [installed, activations] = await Promise.all([
        readInstalled(),
        readActivations(),
      ]);
      const clients: string[] = [];
      const terminals: LocalExtensionTerminal[] = [];
      const diagnostics: Error[] = [];
      for (const [id, revision] of Object.entries(
        activations.projects[project] ?? {},
      )) {
        const record = installed.extensions[id]?.revisions[revision];
        if (record === undefined) {
          diagnostics.push(
            new LocalExtensionError(
              "not-installed",
              `Extension ${id}@${revision} is enabled but not installed`,
            ),
          );
          continue;
        }
        if (record.client !== null) clients.push(record.client);
        const runtime = await runtimeDirectory(project, id);
        for (const terminal of record.terminals)
          terminals.push({
            extensionId: id,
            terminalId: terminal.id,
            name: terminal.name,
            description: terminal.description,
            command: [
              resolve(record.directory, terminal.command[0] ?? ""),
              ...terminal.command.slice(1),
            ],
            cwd: project,
            env: {
              FUNGI_EXTENSION_ID: id,
              FUNGI_PROJECT_ROOT: project,
              FUNGI_EXTENSION_RUNTIME_DIR: runtime,
            },
          });
      }
      return { clients, terminals, diagnostics };
    },

    /** Capture validated records so one reload cannot mix file generations. */
    async captureAgent() {
      const [installed, activations] = await Promise.all([
        readInstalled(),
        readActivations(),
      ]);
      return (storeDirectory: string, projectRoot: string) =>
        loadAgent(installed, activations, storeDirectory, projectRoot);
    },
    async agent(storeDirectory: string, projectRoot: string) {
      return loadAgent(
        await readInstalled(),
        await readActivations(),
        storeDirectory,
        projectRoot,
      );
    },
  };

  async function loadAgent(
    installed: z.infer<typeof installedSchema>,
    activations: z.infer<typeof activationsSchema>,
    storeDirectory: string,
    projectRoot: string,
  ): Promise<LocalAgentExtensions> {
    const store = await realpath(storeDirectory);
    const roster: RosteredExtensionV0[] = [];
    const grants: ExtensionGrantV0[] = [];
    const skills: ExtensionSkillFolder[] = [];
    const diagnostics: { extensionId: string; error: Error }[] = [];
    for (const [id, activation] of Object.entries(
      activations.agents[store] ?? {},
    )) {
      const record = installed.extensions[id]?.revisions[activation.revision];
      try {
        if (record === undefined)
          throw new LocalExtensionError(
            "not-installed",
            `Extension ${id}@${activation.revision} is enabled but not installed`,
          );
        if (activation.skills && record.skills !== null)
          skills.push({ extensionId: id, directory: record.skills });
        // A skills-only activation grants no tools and loads no host code.
        if (activation.capabilities.length === 0) continue;
        if (record.host === null)
          throw new LocalExtensionError(
            "not-installed",
            `Extension ${id}@${activation.revision} is enabled but its host entry is not installed`,
          );
        const module = hostModuleSchema.parse(
          await import(pathToFileURL(record.host).href),
        );
        const extension = await module.default({
          runtimeDirectory: await runtimeDirectory(projectRoot, id),
          defineExtension,
          Mycelium,
          z,
        });
        const parsed = rosteredSchema.parse(extension);
        if (parsed.manifest.id !== id)
          throw new LocalExtensionError(
            "load",
            `Extension ${id} host returned ${parsed.manifest.id}`,
          );
        const requested = new Set(parsed.manifest.requests);
        roster.push(
          z
            .custom<RosteredExtensionV0>(
              (value) => rosteredSchema.safeParse(value).success,
            )
            .parse(extension),
        );
        grants.push({
          id: decodeExtensionId(id),
          capabilities: activation.capabilities.filter((capability) =>
            requested.has(capability),
          ),
        });
      } catch (cause) {
        diagnostics.push({
          extensionId: id,
          error:
            cause instanceof LocalExtensionError
              ? cause
              : new LocalExtensionError(
                  "load",
                  `Extension ${id} could not load`,
                  { cause: failure(cause) },
                ),
        });
      }
    }
    // Same skill name in two extensions: the lower extension id wins, always.
    skills.sort((a, b) => a.extensionId.localeCompare(b.extensionId));
    return { roster, grants, skills, diagnostics };
  }
}

export type LocalExtensions = ReturnType<typeof localExtensions>;
