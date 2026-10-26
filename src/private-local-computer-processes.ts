import {
  spawn,
  type ChildProcess,
  type StdioOptions,
} from "node:child_process";
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { defineIdFamily } from "@fungi.computer/cairn";
import { z } from "zod";
import {
  combinedArgvBytes,
  launchCwdSchema,
  launchStdinSchema,
  maximumLaunchTextLength,
} from "./private-local-exec-launch.js";
import { privateLocalExecEnvironment } from "./private-local-exec-environment.js";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";
import { Writable } from "node:stream";
import type { SandboxCommand } from "./private-local-containment.js";
import type { LocalSandboxLaunch } from "./private-invocation-computer.js";

/**
 * Background processes of the local Computer: the one owner of "a command that
 * outlives a single exec call".
 *
 * `exec` kills its whole process group when its call returns, so `nohup … &`
 * cannot survive it. A process started here instead belongs to one scope (a
 * Session, or the invocation when the host has no Sessions) of one host. It
 * runs in its own process group with stdout and stderr kept in one bounded
 * circular log under the project's `.fungi/processes/`, and it ends when it exits, when
 * `kill` is called, when its scope is disposed (Session deleted), or when the
 * host closes. The shell/exec surface owns start, poll, wait, list and kill.
 */

/** Running processes one scope (Session) may hold at once. */
const maximumRunningProcessesPerScope = 8;
/** Running processes one host may hold at once; mirrors the container Computer. */
const maximumRunningProcesses = 16;
/** Records, running or exited, one scope keeps; the oldest exited is evicted. */
const maximumProcessRecordsPerScope = 32;
/** Bytes of combined stdout and stderr one process log keeps. */
const maximumLogBytes = 8 * 1_024 * 1_024;
/** Bytes one read returns at most. */
const maximumReadBytes = 64 * 1_024;
const defaultReadBytes = 16 * 1_024;
/** One wait returns after at most this long; call it again to keep waiting. */
const maximumWaitMs = 60_000;
const defaultWaitMs = 10_000;
/** SIGTERM grace before SIGKILL when a process group is stopped. */
const terminationGraceMs = 2_000;

const localProcessIds = defineIdFamily({
  family: "local-computer-process",
  version: 1,
  kinds: { process: { prefix: "local_process" } },
});
const processIdSchema = z
  .string()
  .max(128)
  .refine((id) => localProcessIds.process.is(id), "Unknown process id");
const processStateSchema = z.enum(["running", "exited"]);
const processSchema = z.strictObject({
  id: processIdSchema,
  command: z.string(),
  cwd: z.string(),
  state: processStateSchema,
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  startedAt: z.number().int(),
  endedAt: z.number().int().nullable(),
  logPath: z.string(),
  logBytes: z.number().int().nonnegative(),
  logStartOffset: z.number().int().nonnegative(),
  logTruncated: z.boolean(),
});
/** One background process as the agent sees it. */
export type PrivateLocalProcess = z.output<typeof processSchema>;

/** The intentional shell form of background `start`. */
const shellStartInput = z.strictObject({
  operation: z.literal("start"),
  escape: z
    .strictObject({ justification: z.string().min(1).max(2048) })
    .optional(),
  command: z.string().min(1).max(maximumLaunchTextLength),
  stdin: launchStdinSchema.optional(),
  cwd: launchCwdSchema.optional(),
});
/** The direct form of background `start`: argv run with no shell interpretation. */
const directStartInput = z
  .strictObject({
    operation: z.literal("start"),
    escape: z
      .strictObject({ justification: z.string().min(1).max(2048) })
      .optional(),
    executable: z.string().min(1),
    args: z.array(z.string()).default([]),
    stdin: launchStdinSchema.optional(),
    cwd: launchCwdSchema.optional(),
  })
  .refine(
    (value) =>
      combinedArgvBytes(value.executable, value.args) <=
      maximumLaunchTextLength,
    {
      message: `Computer exec executable and args exceed ${String(maximumLaunchTextLength)} combined UTF-8 bytes`,
      path: ["args"],
    },
  );
const idInput = z.strictObject({ id: processIdSchema });
const readInput = z.strictObject({
  id: processIdSchema,
  offset: z.number().int().nonnegative().default(0),
  maxBytes: z
    .number()
    .int()
    .min(1)
    .max(maximumReadBytes)
    .default(defaultReadBytes),
});
const waitInput = z.strictObject({
  id: processIdSchema,
  timeoutMs: z.number().int().min(1).max(maximumWaitMs).default(defaultWaitMs),
});
const listOutput = z.strictObject({
  processes: z.array(processSchema).max(maximumProcessRecordsPerScope),
});
const readOutput = z.strictObject({
  process: processSchema,
  offset: z.number().int().nonnegative(),
  nextOffset: z.number().int().nonnegative(),
  text: z.string(),
  complete: z.boolean(),
});
const waitOutput = z.strictObject({
  process: processSchema,
  timedOut: z.boolean(),
});
const killOutput = z.strictObject({
  process: processSchema,
  signalled: z.boolean(),
});

/** No process with this id was started in this scope. */
class PrivateLocalProcessNotFoundError extends Error {
  constructor(id: string) {
    super(`Computer process not found: ${id}`);
    this.name = "PrivateLocalProcessNotFoundError";
  }
}

/** Every process slot of this scope or host is occupied. */
class PrivateLocalProcessLimitError extends Error {
  constructor(limit: number, owner: "Session" | "host") {
    super(
      `This ${owner} can run at most ${String(limit)} background processes at once; wait for or kill one with exec first`,
    );
    this.name = "PrivateLocalProcessLimitError";
  }
}

/** Signal a whole process group; false when no member could be signalled. */
function signalGroup(groupId: number, signal: NodeJS.Signals) {
  try {
    process.kill(-groupId, signal);
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === "ESRCH" || error.code === "EPERM")
    )
      return false;
    throw error;
  }
}

function groupAlive(groupId: number) {
  try {
    process.kill(-groupId, 0);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause) {
      if (cause.code === "ESRCH") return false;
      if (cause.code === "EPERM") return true;
    }
    throw cause;
  }
}

/**
 * One background `start` request, narrowed to what actually spawns a
 * process: a shell command line, or a direct executable with argv. Either
 * form may carry finite stdin, delivered once and closed before `start`
 * returns a process id.
 */
export type PrivateLocalProcessCommandSpec = Readonly<
  | {
      readonly kind: "shell";
      readonly command: string;
      readonly stdin?: string;
    }
  | {
      readonly kind: "direct";
      readonly executable: string;
      readonly args: readonly string[];
      readonly stdin?: string;
    }
>;

function toCommandSpec(
  request: z.output<typeof shellStartInput> | z.output<typeof directStartInput>,
): PrivateLocalProcessCommandSpec {
  if ("command" in request) {
    const spec = { kind: "shell" as const, command: request.command };
    return request.stdin === undefined
      ? spec
      : { ...spec, stdin: request.stdin };
  }
  const spec = {
    kind: "direct" as const,
    executable: request.executable,
    args: request.args,
  };
  return request.stdin === undefined ? spec : { ...spec, stdin: request.stdin };
}

/**
 * A one-line, human-readable label for a spec; never used for execution.
 * Each direct-form arg is JSON-quoted so `list`/`poll` output does not read
 * like a re-runnable shell line.
 */
function describeCommandSpec(spec: PrivateLocalProcessCommandSpec): string {
  return spec.kind === "shell"
    ? spec.command
    : [spec.executable, ...spec.args.map((arg) => JSON.stringify(arg))].join(
        " ",
      );
}

function isErrnoException(error: Error): error is NodeJS.ErrnoException {
  return "code" in error;
}

/** Drop a trailing partial UTF-8 sequence so a later read resumes on it. */
function completeUtf8Length(bytes: Uint8Array, length: number) {
  for (let back = 1; back <= Math.min(4, length); back += 1) {
    const byte = bytes[length - back] ?? 0;
    if ((byte & 0xc0) === 0x80) continue;
    if (byte < 0xc2 || byte > 0xf4) return length;
    const expected = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return back < expected ? length - back : length;
  }
  return length;
}

class ManagedProcess {
  readonly id: string = localProcessIds.process.generate();
  readonly startedAt = Date.now();
  readonly logPath: string;
  readonly closed: Promise<void>;
  #child: ChildProcess;
  #groupId: number | undefined;
  #fd: number | undefined;
  #logBytes = 0;
  #logTruncated = false;
  #exitCode: number | null = null;
  #signal: string | null = null;
  #endedAt: number | null = null;
  #leaderExited = false;

  readonly command: string;

  constructor(
    readonly spec: PrivateLocalProcessCommandSpec,
    readonly cwd: string,
    logDirectory: string,
    executionPath: string,
    home: string,
    launch?: SandboxCommand,
  ) {
    this.command = describeCommandSpec(spec);
    this.logPath = join(logDirectory, `${this.id}.log`);
    this.#fd = openSync(this.logPath, "wx+", 0o600);
    const closed = Promise.withResolvers<undefined>();
    this.closed = closed.promise;
    const env = privateLocalExecEnvironment(executionPath, {
      HOME: home,
      XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
      DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
    });
    if (launch !== undefined) {
      delete env.XDG_RUNTIME_DIR;
      delete env.DBUS_SESSION_BUS_ADDRESS;
      Object.assign(env, launch.environment);
    }
    try {
      // Its own process group, so neither exec's finalizer nor this host's
      // terminal signals reach it; kill() owns ending the whole group.
      const argv: [string, ...string[]] =
        spec.kind === "shell"
          ? ["sh", "-c", spec.command]
          : [spec.executable, ...spec.args];
      const stdio: StdioOptions = [
        spec.stdin === undefined ? "ignore" : "pipe",
        "pipe",
        "pipe",
      ];
      if (launch?.seccompFilter !== undefined) stdio.push("pipe");
      this.#child = spawn(
        launch?.executable ?? argv[0],
        launch?.args ?? argv.slice(1),
        {
          cwd,
          env,
          detached: true,
          stdio,
        },
      );
      if (launch?.seccompFilter !== undefined) {
        const filter = this.#child.stdio[3];
        if (!(filter instanceof Writable)) {
          this.#child.kill("SIGKILL");
          throw new Error("Local sandbox filter input fd3 is unavailable");
        }
        // A failed filter delivery cannot become a bare retry or an unhandled
        // stream error. The existing process owner records and reaps failure.
        filter.on("error", (error) => {
          this.#append(
            Buffer.from(`\n[fungi: sandbox filter failed: ${error.message}]\n`),
          );
          this.killNow();
        });
        filter.end(launch.seccompFilter);
      }
      // Finite stdin, delivered once and closed; never an interactive
      // protocol. `end()` writes the bytes and closes the write side. A
      // child that exits or closes its own stdin before the payload drains
      // (`true`, `head -c1`, an early exit) makes that write EPIPE; without
      // this listener the stream emits 'error' with no handler and crashes
      // the host process. There is no caller to reject here (`start` has
      // already returned a process id), so this only records what happened.
      if (spec.stdin !== undefined) {
        const stdin = spec.stdin;
        this.#child.stdin?.on("error", (error) => {
          const code = isErrnoException(error) ? error.code : undefined;
          this.#append(
            Buffer.from(
              code === "EPIPE"
                ? "\n[fungi: stdin not fully consumed]\n"
                : `\n[fungi: stdin failed: ${error.message}]\n`,
            ),
          );
        });
        this.#child.stdin?.end(Buffer.from(stdin, "utf8"));
      }
    } catch (cause) {
      closeSync(this.#fd);
      throw cause;
    }
    const pid = this.#child.pid;
    this.#groupId =
      pid !== undefined && Number.isSafeInteger(pid) && pid > 1
        ? pid
        : undefined;
    const append = (chunk: Buffer) => {
      this.#append(chunk);
    };
    this.#child.stdout?.on("data", append);
    this.#child.stderr?.on("data", append);
    this.#child.on("error", (error) => {
      this.#append(
        Buffer.from(`\n[fungi: process failed: ${error.message}]\n`),
      );
      this.#finish(closed.resolve);
    });
    this.#child.on("exit", (code, signal) => {
      this.#leaderExited = true;
      this.#exitCode = code;
      this.#signal = signal;
      // The command is finished; members it left in its group are not owned
      // by anyone else, so end them and release the log pipes.
      void this.#terminateGroup().then(() => {
        this.#child.stdout?.destroy();
        this.#child.stderr?.destroy();
      });
    });
    this.#child.on("close", () => {
      this.#finish(closed.resolve);
    });
  }

  get running() {
    return this.#endedAt === null;
  }

  #append(chunk: Uint8Array) {
    const fd = this.#fd;
    if (fd === undefined) return;
    // Circular storage retains the latest bytes without growing the log or
    // copying megabytes on every append. Offsets count all produced bytes.
    const skipped = Math.max(0, chunk.byteLength - maximumLogBytes);
    const kept = chunk.subarray(skipped);
    const position = (this.#logBytes + skipped) % maximumLogBytes;
    const first = Math.min(kept.byteLength, maximumLogBytes - position);
    writeSync(fd, kept, 0, first, position);
    if (first < kept.byteLength)
      writeSync(fd, kept, first, kept.byteLength - first, 0);
    this.#logBytes += chunk.byteLength;
    this.#logTruncated = this.#logBytes > maximumLogBytes;
  }

  /** Read atomically with appends, including a wrap in circular storage. */
  read(offset: number, maxBytes: number) {
    const end = this.#logBytes;
    let from = Math.max(
      Math.max(0, end - maximumLogBytes),
      Math.min(offset, end),
    );
    const length = Math.min(maxBytes, end - from);
    const bytes = new Uint8Array(length);
    const fd = this.#fd ?? openSync(this.logPath, "r");
    try {
      const position = from % maximumLogBytes;
      const first = Math.min(length, maximumLogBytes - position);
      if (first > 0) readSync(fd, bytes, 0, first, position);
      if (first < length) readSync(fd, bytes, first, length - first, 0);
    } finally {
      if (this.#fd === undefined) closeSync(fd);
    }
    // A tail or evicted cursor may start inside a UTF-8 sequence.
    let skipped = 0;
    while (skipped < length && ((bytes[skipped] ?? 0) & 0xc0) === 0x80)
      skipped += 1;
    from += skipped;
    const content = bytes.subarray(skipped);
    const snapshot = this.snapshot();
    // At the final byte of an exited command no continuation can arrive;
    // flush malformed/incomplete terminal bytes through the decoder instead.
    const kept =
      snapshot.state === "exited" && from + content.length === end
        ? content.length
        : completeUtf8Length(content, content.length);
    return readOutput.parse({
      process: snapshot,
      offset: from,
      nextOffset: from + kept,
      text: new TextDecoder().decode(content.subarray(0, kept)),
      complete: snapshot.state === "exited" && from + kept >= end,
    });
  }

  #finish(resolve: (value: undefined) => void) {
    if (this.#endedAt !== null) return;
    this.#endedAt = Date.now();
    if (this.#fd !== undefined) closeSync(this.#fd);
    this.#fd = undefined;
    resolve(undefined);
  }

  /** TERM the whole group, then KILL whatever ignores it past the grace. */
  async #terminateGroup() {
    const groupId = this.#groupId;
    if (groupId === undefined || !signalGroup(groupId, "SIGTERM")) return false;
    const deadline = Date.now() + terminationGraceMs;
    while (groupAlive(groupId) && Date.now() < deadline) await delay(20);
    if (groupAlive(groupId)) signalGroup(groupId, "SIGKILL");
    return true;
  }

  /** Stop this process and every member of its group; settles once it ended. */
  async kill() {
    if (!this.running) return false;
    const signalled = await this.#terminateGroup();
    // A group that escaped signalling still releases our pipes and log.
    if (this.#leaderExited || !signalled) {
      this.#child.stdout?.destroy();
      this.#child.stderr?.destroy();
    }
    await this.closed;
    return signalled;
  }

  /** Synchronous last resort while the host process itself exits. */
  killNow() {
    if (this.running && this.#groupId !== undefined)
      signalGroup(this.#groupId, "SIGKILL");
  }

  snapshot(): PrivateLocalProcess {
    return processSchema.parse({
      id: this.id,
      command: this.command,
      cwd: this.cwd,
      state: this.running ? "running" : "exited",
      exitCode: this.running ? null : this.#exitCode,
      signal: this.running ? null : this.#signal,
      startedAt: this.startedAt,
      endedAt: this.#endedAt,
      logPath: this.logPath,
      logBytes: this.#logBytes,
      logStartOffset: Math.max(0, this.#logBytes - maximumLogBytes),
      logTruncated: this.#logTruncated,
    });
  }
}

/** One Session's (or invocation's) view of the host's background processes. */
export type PrivateLocalProcessScope = Readonly<{
  start: (
    spec: PrivateLocalProcessCommandSpec,
    cwd: string,
    executionPath: string,
    sandbox?: LocalSandboxLaunch,
  ) => Promise<PrivateLocalProcess>;
  status: (id: string) => PrivateLocalProcess;
  list: () => readonly PrivateLocalProcess[];
  read: (
    id: string,
    offset: number,
    maxBytes: number,
  ) => Promise<z.output<typeof readOutput>>;
  wait: (
    id: string,
    timeoutMs: number,
    signal: AbortSignal,
  ) => Promise<z.output<typeof waitOutput>>;
  kill: (id: string) => Promise<z.output<typeof killOutput>>;
}>;

/** The host's one background-process owner. */
export type PrivateLocalComputerProcesses = Readonly<{
  scope: (key: string) => PrivateLocalProcessScope;
  /** Stop every process of one scope and remove its logs (Session ended). */
  disposeScope: (key: string) => Promise<void>;
  /** Whether any background process of any scope is still running. */
  running: () => boolean;
  /** Stop every process, remove every log, and refuse new starts. */
  close: () => Promise<void>;
}>;

/** Open the background-process owner for one invocation root. */
export function createPrivateLocalComputerProcesses(
  root: string,
  home: string = capturePrivateLocalConfigRoot().home,
): PrivateLocalComputerProcesses {
  const logDirectory = join(root, ".fungi", "processes");
  const scopes = new Map<string, Map<string, ManagedProcess>>();
  let closed = false;
  let exitHook = false;
  const all = () =>
    [...scopes.values()].flatMap((owned) => [...owned.values()]);
  const killAllNow = () => {
    for (const owned of all()) owned.killNow();
  };

  const dispose = async (owned: Map<string, ManagedProcess>) => {
    const records = [...owned.values()];
    owned.clear();
    await Promise.all(records.map((record) => record.kill()));
    await Promise.all(
      records.map((record) => rm(record.logPath, { force: true })),
    );
  };

  const scope = (key: string): PrivateLocalProcessScope => {
    const owned = () => {
      let selected = scopes.get(key);
      if (selected === undefined) {
        selected = new Map();
        scopes.set(key, selected);
      }
      return selected;
    };
    const find = (id: string) => {
      const record = scopes.get(key)?.get(id);
      if (record === undefined) throw new PrivateLocalProcessNotFoundError(id);
      return record;
    };
    return Object.freeze({
      start: async (spec, cwd, executionPath, sandbox) => {
        if (closed) throw new Error("Local Computer processes are closed");
        const records = owned();
        const running = [...records.values()].filter((r) => r.running).length;
        if (running >= maximumRunningProcessesPerScope)
          throw new PrivateLocalProcessLimitError(
            maximumRunningProcessesPerScope,
            "Session",
          );
        if (all().filter((r) => r.running).length >= maximumRunningProcesses)
          throw new PrivateLocalProcessLimitError(
            maximumRunningProcesses,
            "host",
          );
        if (records.size >= maximumProcessRecordsPerScope) {
          const oldest = [...records.values()].find((r) => !r.running);
          if (oldest !== undefined) {
            records.delete(oldest.id);
            await rm(oldest.logPath, { force: true });
          }
        }
        await mkdir(logDirectory, { recursive: true, mode: 0o700 });
        if (!exitHook) {
          // A host that exits without close still takes its process groups.
          process.on("exit", killAllNow);
          exitHook = true;
        }
        const argv: [string, ...string[]] =
          spec.kind === "shell"
            ? ["sh", "-c", spec.command]
            : [spec.executable, ...spec.args];
        const launch = sandbox?.(cwd, argv);
        const started = new ManagedProcess(
          spec,
          cwd,
          logDirectory,
          executionPath,
          home,
          launch,
        );
        records.set(started.id, started);
        return started.snapshot();
      },
      status: (id) => find(id).snapshot(),
      list: () =>
        [...(scopes.get(key)?.values() ?? [])].map((r) => r.snapshot()),
      read: (id, offset, maxBytes) =>
        Promise.resolve(find(id).read(offset, maxBytes)),
      wait: async (id, timeoutMs, signal) => {
        const record = find(id);
        const controller = new AbortController();
        const abandon = () => {
          controller.abort();
        };
        signal.addEventListener("abort", abandon, { once: true });
        try {
          const timedOut = await Promise.race([
            record.closed.then(() => false),
            delay(timeoutMs, true, { signal: controller.signal }),
          ]);
          return waitOutput.parse({ process: record.snapshot(), timedOut });
        } finally {
          signal.removeEventListener("abort", abandon);
          controller.abort();
        }
      },
      kill: async (id) => {
        const record = find(id);
        const signalled = await record.kill();
        return killOutput.parse({ process: record.snapshot(), signalled });
      },
    });
  };

  return Object.freeze({
    scope,
    disposeScope: async (key) => {
      const owned = scopes.get(key);
      scopes.delete(key);
      if (owned !== undefined) await dispose(owned);
    },
    running: () => all().some((record) => record.running),
    close: async () => {
      closed = true;
      const owned = [...scopes.values()];
      scopes.clear();
      try {
        await Promise.all(owned.map(dispose));
      } finally {
        process.off("exit", killAllNow);
        exitHook = false;
      }
    },
  });
}

/**
 * Background operations share the Computer's one shell/exec surface; a
 * plain (not discriminated) union, since `start`'s shell and direct branches
 * share the `operation:"start"` literal that `discriminatedUnion` requires
 * to be unique per branch. Both/neither of `command`/`executable` are still
 * refused, by the strict objects themselves.
 */
export const backgroundExecInput = z.union([
  shellStartInput,
  directStartInput,
  readInput.omit({ offset: true }).extend({
    operation: z.literal("poll"),
    // Omission reads the tail; a returned nextOffset resumes output explicitly.
    offset: z.number().int().nonnegative().optional(),
  }),
  waitInput.extend({
    operation: z.literal("wait"),
    offset: z.number().int().nonnegative().optional(),
    maxBytes: readInput.shape.maxBytes,
  }),
  idInput.extend({ operation: z.literal("kill") }),
  z.strictObject({ operation: z.literal("list") }),
]);
const backgroundResult = readOutput.extend({
  timedOut: z.boolean(),
  signalled: z.boolean().optional(),
  sandbox: z
    .strictObject({
      mode: z.enum(["full-access", "workspace", "read-only"]),
      likelyDenied: z.boolean(),
      ranOutsideSandbox: z.boolean(),
    })
    .optional(),
});
export const backgroundExecOutput = z.union([backgroundResult, listOutput]);

/** Reuse Session ownership and logs; a wait deadline never cancels the command. */
export async function callBackgroundExec(
  scope: PrivateLocalProcessScope,
  request: z.output<typeof backgroundExecInput>,
  resolveCwd: (requested: string | undefined) => Promise<string>,
  executionPath: string,
  signal: AbortSignal,
  sandbox?: LocalSandboxLaunch,
): Promise<z.output<typeof backgroundExecOutput>> {
  signal.throwIfAborted();
  if (request.operation === "list") return { processes: [...scope.list()] };
  let id: string;
  let timedOut = false;
  let signalled: boolean | undefined;
  switch (request.operation) {
    case "start": {
      const cwd = await resolveCwd(request.cwd);
      signal.throwIfAborted();
      id = (
        await scope.start(toCommandSpec(request), cwd, executionPath, sandbox)
      ).id;
      break;
    }
    case "wait":
      id = request.id;
      timedOut = (await scope.wait(id, request.timeoutMs, signal)).timedOut;
      break;
    case "kill":
      id = request.id;
      signalled = (await scope.kill(id)).signalled;
      break;
    case "poll":
      id = request.id;
      break;
  }
  const maxBytes = "maxBytes" in request ? request.maxBytes : defaultReadBytes;
  const offset = "offset" in request ? request.offset : undefined;
  const from = offset ?? Math.max(0, scope.status(id).logBytes - maxBytes);
  const output = await scope.read(id, from, maxBytes);
  const result: z.output<typeof backgroundResult> = { ...output, timedOut };
  if (signalled !== undefined) result.signalled = signalled;
  return backgroundResult.parse(result);
}
