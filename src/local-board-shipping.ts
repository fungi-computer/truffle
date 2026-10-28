import { execFile } from "node:child_process";
import { open } from "node:fs/promises";
import { join } from "node:path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

/** What happened to a piece of work: it landed, shipped out, or is on its way. */
export const ShipKind = Schema.Literals([
  "landed",
  "released",
  "queued",
  "gating",
  "dropped",
]);
/** Display kind of one shipped item. */
export type ShipKind = typeof ShipKind.Type;

const text = Schema.String.check(Schema.isMaxLength(200));
/** One thing a shipping source saw since local midnight. */
export const ShipItem = Schema.Struct({
  /** Stable within its source. */
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  /** What happened to it. */
  kind: ShipKind,
  /** A one-line title, such as a commit subject or a released version. */
  title: text,
  /** The branch, tag or package it belongs to. */
  ref: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  ),
  /** When it happened. */
  at: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** A short note the source adds. */
  detail: Schema.optionalKey(text),
});
/** Decoded shipped item. */
export type ShipItem = typeof ShipItem.Type;

/** What one read of a shipping source found; a throw is a failed source instead. */
export type ShippingRead = Readonly<{
  /** `held` is paused on purpose, `stopped` is not running; neither is an error. */
  state: "ok" | "held" | "stopped";
  /** Why it is held or stopped, in a few words. */
  detail?: string;
  /** What the source saw since `sinceMs`, newest first. */
  items: readonly ShipItem[];
}>;

/**
 * Something that ships work: a branch, a package registry, a merge train. The
 * Board reads it on its own cadence and never trusts it to say "none" when it
 * could not look.
 */
export type ShippingSource = Readonly<{
  /** Stable identity of the source. */
  id: string;
  /** What the person calls the source. */
  label: string;
  /** How often the source is read again. */
  refreshMs: number;
  /** Read what shipped at or after `sinceMs` (local midnight); throw when it cannot be read. */
  read: (sinceMs: number, signal: AbortSignal) => Promise<ShippingRead>;
}>;

/** The sources the Board reads, resolved afresh each cycle so settings edits apply. */
export type ShippingSources = (
  signal: AbortSignal,
) => Promise<readonly ShippingSource[]>;

/** The most shipping sources one board reads. */
export const maximumShippingSources = 6;

const reference = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
);

/** Commits first-parent on `ref` since midnight; a protected branch's merges are its landings. */
const gitSourceConfig = Schema.Struct({
  /** Reads a Git history. */
  kind: Schema.Literal("git"),
  /** The branch, tag or `HEAD` whose first-parent history is read. */
  ref: reference,
  /** Whether those commits landed work or released it. */
  shows: Schema.Literals(["landed", "released"]),
});

/** Versions of these packages published today. */
const npmSourceConfig = Schema.Struct({
  /** Reads a package registry. */
  kind: Schema.Literal("npm"),
  /** Package names, as `npm view` takes them. */
  packages: Schema.Array(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(214)),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});

/** One configured shipping source; an unknown kind or key is refused. */
export const ShippingSourceConfig = Schema.Union([
  gitSourceConfig,
  npmSourceConfig,
]);
/** Decoded configured shipping source. */
export type ShippingSourceConfig = typeof ShippingSourceConfig.Type;

/** The `board` key of a `.fungi/settings.json`; excess keys are refused. */
export const BoardSettings = Schema.Struct({
  /** The sources the Board reads for what shipped today. */
  shipping: Schema.optionalKey(
    Schema.Array(ShippingSourceConfig).check(
      Schema.isMaxLength(maximumShippingSources),
    ),
  ),
});

const isKey = Schema.is(Schema.Union([Schema.String, Schema.Finite]));

/** The sources a settings `board` value names, or each refusal with its settings path. */
export function decodeBoardSettings(
  board: unknown,
): Result.Result<readonly ShippingSourceConfig[], readonly string[]> {
  const decoded = Schema.decodeUnknownResult(BoardSettings, {
    onExcessProperty: "error",
    errors: "all",
  })(board);
  if (Result.isSuccess(decoded))
    return Result.succeed(decoded.success.shipping ?? []);
  const format = SchemaIssue.makeFormatterStandardSchemaV1();
  return Result.fail(
    format(decoded.failure.issue).issues.map(
      ({ path, message }) =>
        (path ?? []).reduce<string>((where, part) => {
          // Settings are JSON, so every path segment is a name or an index.
          const key = isKey(part) ? String(part) : "?";
          return /^\d+$/u.test(key) ? `${where}[${key}]` : `${where}.${key}`;
        }, "board") + `: ${message}`,
    ),
  );
}

/** Run a program with these arguments and return what it wrote to stdout. */
export type ShippingExec = (
  file: string,
  args: readonly string[],
  options: Readonly<{ cwd: string; signal: AbortSignal }>,
) => Promise<string>;

/** A settings file larger than this is not read. */
const maximumSettingsBytes = 64 * 1024;
/** Git history is read at most this many commits deep; the board lists far fewer. */
const maximumCommits = 200;
const gitRefreshMs = 60_000;
const npmRefreshMs = 5 * 60_000;
/** How long the answer to "is this a work tree, and on which branch" is kept. */
const defaultBranchMs = 60_000;

/** The first line a program said, so a refusal reads as a reason and not as a command line. */
function reason(file: string, stderr: string, cause: Error): string {
  const line = stderr.split("\n").find((text) => text.trim() !== "");
  if ("code" in cause && cause.code === "ENOENT")
    return `${file} is not installed`;
  return `${file} failed${line === undefined ? "" : `: ${line.trim()}`}`;
}

/**
 * The tool's ordinary interface: its own argv, no shell, a bounded environment.
 * A program that is missing or refuses is an error with a short reason.
 */
export const execShipping: ShippingExec = (file, args, { cwd, signal }) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        cwd,
        signal,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          LC_ALL: "C",
          npm_config_update_notifier: "false",
          npm_config_fund: "false",
          npm_config_audit: "false",
        },
      },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout);
        else reject(new Error(reason(file, stderr, error)));
      },
    );
  });

const decodeItems = Schema.decodeUnknownSync(Schema.Array(ShipItem));

/**
 * Commits first-parent on `ref` since local midnight, from `git log`. A merge
 * shows the subject of the tip it merged, and any other commit its own, so a
 * merge queue's "Merge branch ..." lines read as the work that landed.
 */
export function gitSource(
  config: Extract<ShippingSourceConfig, { kind: "git" }>,
  options: Readonly<{ cwd: string; exec: ShippingExec; label?: string }>,
): ShippingSource {
  const { ref, shows } = config;
  return {
    id: `git:${ref}:${shows}`,
    label: options.label ?? ref,
    refreshMs: gitRefreshMs,
    read: async (sinceMs, signal) => {
      const run = (args: readonly string[]) =>
        options.exec("git", args, { cwd: options.cwd, signal });
      const log = await run([
        "log",
        "--first-parent",
        `--since=${new Date(sinceMs).toISOString()}`,
        `--max-count=${String(maximumCommits)}`,
        "--format=%H%x1f%ct%x1f%s%x1f%P%x1e",
        ref,
        "--",
      ]);
      const commits = records(log, 4).map(([hash, time, subject, parents]) => ({
        hash: hash ?? "",
        time: Number(time),
        subject: subject ?? "",
        merged: (parents ?? "").split(" ").filter((parent) => parent !== "")[1],
      }));
      const tips = [
        ...new Set(
          commits.flatMap(({ merged }) =>
            merged === undefined ? [] : [merged],
          ),
        ),
      ];
      const tipSubjects = new Map<string, string>();
      if (tips.length > 0) {
        const shown = await run([
          "log",
          "--no-walk=unsorted",
          "--format=%H%x1f%s%x1e",
          ...tips,
          "--",
        ]);
        for (const [hash, subject] of records(shown, 2))
          if (hash !== undefined) tipSubjects.set(hash, subject ?? "");
      }
      const items = decodeItems(
        commits.map(({ hash, time, subject, merged }) => ({
          id: hash.slice(0, 12),
          kind: shows,
          title: (merged === undefined
            ? subject
            : (tipSubjects.get(merged) ?? subject)
          ).slice(0, 200),
          ref,
          at: time * 1000,
        })),
      );
      return { state: "ok", items: items.filter((item) => item.at >= sinceMs) };
    },
  };
}

/** Split a program's `%x1e`-terminated, `%x1f`-separated records into fields. */
function records(
  output: string,
  fields: number,
): readonly (readonly string[])[] {
  return output
    .split("\x1e")
    .map((record) => record.replace(/^\n+/u, ""))
    .filter((record) => record !== "")
    .map((record) => record.split("\x1f", fields));
}

const publishTimes = Schema.Record(Schema.String, Schema.String);
const decodePublishTimes = Schema.decodeUnknownSync(publishTimes);
/** Keys of `npm view time` that are not versions. */
const notVersions = new Set(["created", "modified"]);

/** Versions of each package published since local midnight, from `npm view <package> time --json`. */
export function npmSource(
  config: Extract<ShippingSourceConfig, { kind: "npm" }>,
  options: Readonly<{ cwd: string; exec: ShippingExec }>,
): ShippingSource {
  const { packages } = config;
  return {
    id: `npm:${packages.join(",")}`,
    label: `npm: ${packages.join(", ")}`,
    refreshMs: npmRefreshMs,
    read: async (sinceMs, signal) => {
      const found: ShipItem[] = [];
      for (const name of packages) {
        const times = decodePublishTimes(
          JSON.parse(
            await options.exec("npm", ["view", name, "time", "--json"], {
              cwd: options.cwd,
              signal,
            }),
          ),
        );
        for (const [version, published] of Object.entries(times)) {
          const at = Date.parse(published);
          if (!notVersions.has(version) && at >= sinceMs)
            found.push({
              id: `${name}@${version}`,
              kind: "released",
              title: `${name} ${version}`,
              ref: name,
              at,
            });
        }
      }
      return {
        state: "ok",
        items: decodeItems(found.sort((left, right) => right.at - left.at)),
      };
    },
  };
}

/** A source that only says why the settings could not be used. */
function settingsProblem(file: string, message: string): ShippingSource {
  return {
    id: `settings:${file}`,
    label: "Board settings",
    refreshMs: gitRefreshMs,
    read: () => Promise.reject(new Error(`${file}: ${message}`)),
  };
}

type SettingsRead =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "sources"; sources: readonly ShippingSourceConfig[] }>
  | Readonly<{ kind: "refused"; problems: readonly string[] }>;

/** Read one settings file's `board` key; a missing file or key says nothing. */
async function readSettings(path: string): Promise<SettingsRead> {
  let text: string;
  try {
    const handle = await open(path, "r");
    try {
      const bytes = Buffer.alloc(maximumSettingsBytes + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > maximumSettingsBytes)
        return {
          kind: "refused",
          problems: ["the file is larger than 64 KiB"],
        };
      text = bytes.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return { kind: "none" };
    return {
      kind: "refused",
      problems: [cause instanceof Error ? cause.message : "could not be read"],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: "refused", problems: ["settings are not valid JSON"] };
  }
  const board = Schema.decodeUnknownOption(
    Schema.Struct({ board: Schema.optionalKey(Schema.Unknown) }),
  )(parsed);
  if (board._tag === "None" || board.value.board === undefined)
    return { kind: "none" };
  const decoded = decodeBoardSettings(board.value.board);
  return decoded._tag === "Success"
    ? { kind: "sources", sources: decoded.success }
    : { kind: "refused", problems: decoded.failure };
}

/**
 * The Board's shipping sources for this folder: `board.shipping` in the
 * folder's `.fungi/settings.json`, then the person's, read afresh each cycle so
 * an edit applies. A refused file is one failed source line naming its
 * path, never a silent default. With nothing configured, a Git work tree
 * shows its current branch as landed work, and a folder that is not one shows
 * no shipping at all.
 */
export function createLocalShippingSources(
  options: Readonly<{
    cwd: string;
    home: string;
    exec?: ShippingExec;
    now?: () => number;
  }>,
): ShippingSources {
  const exec = options.exec ?? execShipping;
  const now = options.now ?? Date.now;
  let branch: Readonly<{ at: number; name: string | null }> | undefined;
  /** The current branch when this folder is a Git work tree; asked at most once a minute. */
  async function currentBranch(signal: AbortSignal): Promise<string | null> {
    if (branch !== undefined && now() - branch.at < defaultBranchMs)
      return branch.name;
    let name: string | null;
    try {
      name = (
        await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: options.cwd,
          signal,
        })
      ).trim();
    } catch {
      // Not a work tree, or no Git: there is nothing to default to.
      name = null;
    }
    branch = { at: now(), name: name === "" ? null : name };
    return branch.name;
  }
  return async (signal): Promise<readonly ShippingSource[]> => {
    const files = [
      join(options.cwd, ".fungi/settings.json"),
      join(options.home, ".fungi/settings.json"),
    ];
    const configs: ShippingSourceConfig[] = [];
    const problems: ShippingSource[] = [];
    for (const file of files) {
      const read = await readSettings(file);
      if (read.kind === "sources") configs.push(...read.sources);
      else if (read.kind === "refused")
        problems.push(settingsProblem(file, read.problems.join("; ")));
    }
    const context = { cwd: options.cwd, exec };
    const sources = configs.map((config) =>
      config.kind === "git"
        ? gitSource(config, context)
        : npmSource(config, context),
    );
    if (sources.length === 0 && problems.length === 0) {
      const name = await currentBranch(signal);
      if (name !== null)
        sources.push(
          gitSource(
            { kind: "git", ref: "HEAD", shows: "landed" },
            { ...context, label: name },
          ),
        );
    }
    return [...sources, ...problems];
  };
}
