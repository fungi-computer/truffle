import { realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import process from "node:process";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { isPlatformError, type PlatformError } from "effect/PlatformError";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type { KnapsackComputer } from "@fungi.computer/knapsack";
import {
  CapabilityFailed,
  type InvocationContext,
} from "@fungi.computer/mycelium";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { z } from "zod";
import {
  backgroundExecInput,
  backgroundExecOutput,
  callBackgroundExec,
  type PrivateLocalProcessScope,
} from "./private-local-computer-processes.js";
import {
  capturePrivateLocalExecPath,
  parsePrivateLocalExecPath,
} from "./private-local-exec-path.js";
import {
  combinedArgvBytes,
  launchCwdSchema,
  launchStdinSchema,
  maximumLaunchTextLength,
} from "./private-local-exec-launch.js";
import { privateLocalExecEnvironment } from "./private-local-exec-environment.js";
import { capturePrivateLocalConfigRoot } from "./private-local-config-root.js";
import type { SandboxCommand } from "./private-local-containment.js";

/** A bare fallback for the native Files engine still names only staged bytes. */
export type BareNativeCommand = SandboxCommand & Readonly<{ bareNative: true }>;

/** Only Files supplies a helper; generic exec can still fall back to its argv. */
export type LocalSandboxLaunch = {
  (
    cwd: string,
    argv: readonly [string, ...string[]],
  ): SandboxCommand | undefined;
  (
    cwd: string,
    argv: readonly [string, ...string[]],
    readOnlyHelperFile: string,
  ): SandboxCommand | BareNativeCommand;
};

const maximumStreamBytes = 64 * 1_024;
/** Room inside the stream cap for the visible truncation marker. */
const truncationMarkerReserveBytes = 256;
const keptStreamBytes = maximumStreamBytes - truncationMarkerReserveBytes;
const defaultCommandTimeoutMs = 180_000;
/**
 * Keep in sync with the invocation deadline `private-local-runtime-host.ts`
 * sets as `execution.timeoutMs` (~line 705): one Mycelium `execute` call,
 * covering sandbox setup, every command it runs, and teardown.
 */
const invocationDeadlineMs = 900_000;
/**
 * Reserved outside any one command for sandbox boot, forage round-trips,
 * JSON marshaling, and process teardown. One command's budget stays below
 * the invocation budget; multiple commands still share that invocation's
 * deadline.
 */
const invocationSetupTeardownMarginMs = 120_000;
const maximumCommandTimeoutMs =
  invocationDeadlineMs - invocationSetupTeardownMarginMs;
const jsonValueSchema = z.json();
const capabilityNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z][A-Za-z0-9_]*$/);
const runCommonFields = {
  operation: z.literal("run").default("run"),
  cwd: launchCwdSchema.optional(),
  // Accepted up to the full invocation deadline and silently clamped to
  // maximumCommandTimeoutMs (see runCommandAtInvocationBoundary); rejecting
  // outright here would just trade one confusing failure for another.
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .max(invocationDeadlineMs)
    .default(defaultCommandTimeoutMs),
};
/** The intentional shell form: one interpreted command line. */
const shellRunInput = z.strictObject({
  ...runCommonFields,
  command: z.string().min(1).max(maximumLaunchTextLength),
  stdin: launchStdinSchema.optional(),
});
/** The direct form: argv run with no shell interpretation. */
const directRunInput = z
  .strictObject({
    ...runCommonFields,
    executable: z.string().min(1),
    args: z.array(z.string()).default([]),
    stdin: launchStdinSchema.optional(),
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
/**
 * `command` (shell) and `executable`/`args` (direct) are mutually exclusive:
 * each branch is a strict object, so supplying both or neither fails every
 * branch and the union is refused.
 */
const execInput = z.union([shellRunInput, directRunInput]);
const execTruncation = z.strictObject({
  stream: z.enum(["stdout", "stderr"]),
  keptBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().positive(),
});
const commandOutputFields = {
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.union([z.literal(false), z.array(execTruncation).min(1)]),
};
const execOutput = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.enum(["completed", "failed"]),
    ...commandOutputFields,
  }),
  z.strictObject({
    status: z.literal("deadline_exceeded"),
    timeoutMs: z.number().int().positive(),
    elapsedMs: z.number().nonnegative(),
    message: z.string(),
    ...commandOutputFields,
  }),
]);
const shellInput = z.union([execInput, backgroundExecInput]);
const shellOutput = z.union([execOutput, backgroundExecOutput]);

function computerCapabilities(
  root: string,
  processes: PrivateLocalProcessScope | undefined,
) {
  return jsonValueSchema.parse([
    {
      id: "exec",
      name: "exec",
      kind: "runtime",
      // A filesystem path has no place in the bounded discovery summary.
      // Publish the exact root in the input schema, without truncating it.
      description: `Shell, terminal, git, builds. cwd uses the root in the input schema. ~/$HOME use home. Or {executable,args}; stdin once, closed. exec kills its group at call end; nohup/& die. timeoutMs default ${String(defaultCommandTimeoutMs)}, max ${String(maximumCommandTimeoutMs)} ms; invocation ${String(invocationDeadlineMs)} ms; deadline returns partial output. Streams keep 64 KiB, then a [stdout|stderr truncated] line; redirect to a file or head/tail.${processes === undefined ? "" : ' Jobs: {operation:"start",command} or executable+args returns process.id; poll/wait: state, exitCode, tail. wait <=60000 ms; timedOut: wait expired. Cancelled wait keeps jobs. maxBytes <=64 KiB, offset/nextOffset; keeps last 8 MiB (logStartOffset). kill stops group; list: Session jobs. Delete/close stop jobs. Use wait, not sleep.'}`,
      parameters: structuredClone(
        z.toJSONSchema(
          (processes === undefined ? execInput : shellInput).describe(
            `Computer root: ${root}. cwd must be absolute and remain inside this root; omission starts at the root.`,
          ),
          { io: "input" },
        ),
      ),
      output: structuredClone(
        z.toJSONSchema(processes === undefined ? execOutput : shellOutput),
      ),
    },
  ]);
}

/** A one-line, shell-safe label for error messages; never the full command. */
function shortCommandLabel(command: string): string {
  const oneLine = command.replace(/\s+/gu, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

/** Plain, actionable sentence for a command that hit its (possibly clamped) timeout. */
function commandTimeoutMessage(input: {
  readonly command: string;
  readonly timeoutMs: number;
  readonly requestedMs: number;
}): string {
  const clampNote =
    input.timeoutMs < input.requestedMs
      ? ` (clamped from the requested ${String(input.requestedMs)} ms so the command leaves ${String(invocationSetupTeardownMarginMs)} ms of headroom under the ${String(invocationDeadlineMs)} ms invocation deadline)`
      : "";
  return `Command exceeded timeoutMs=${String(input.timeoutMs)} ms${clampNote}. Command: ${shortCommandLabel(input.command)}. Rerun with a larger timeoutMs, up to ${String(maximumCommandTimeoutMs)} ms; split longer work into separate tool calls.`;
}

type BoundedOutput = Readonly<{
  chunks: readonly Uint8Array[];
  byteLength: number;
  totalBytes: number;
}>;
export type ExecOutput = z.output<typeof execOutput>;

function isErrnoException(error: Error): error is NodeJS.ErrnoException {
  return "code" in error;
}

function assertContained(root: string, candidate: string, requested: string) {
  const fromRoot = relative(root, candidate);
  if (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(sep))
  ) {
    return;
  }
  throw new CapabilityFailed({
    namespace: "Computer",
    operation: "exec",
    cause: {
      kind: "InvalidInput",
      message: `Computer cwd resolves outside the invocation root: ${requested}`,
    },
  });
}

async function resolveCwd(root: string, requested: string | undefined) {
  const candidate = resolve(requested ?? root);
  assertContained(root, candidate, requested ?? root);
  const canonical = await realpath(candidate);
  assertContained(root, canonical, requested ?? root);
  return canonical;
}

/**
 * What `kill(-group, 0)` reports about a command's process group:
 * - `running`: at least one member we may signal still exists.
 * - `unsignalable`: members exist, but none we may signal (EPERM). On macOS a
 *   group whose remaining members are all unreaped zombies reports this until
 *   they are reaped; a member running as another user reports it indefinitely.
 * - `absent`: no member remains (ESRCH).
 */
type ProcessGroupState = "running" | "unsignalable" | "absent";

function errnoCode(error: Error): string | undefined {
  return isErrnoException(error) ? error.code : undefined;
}

function groupState(groupId: number) {
  return Effect.sync((): ProcessGroupState => {
    try {
      process.kill(-groupId, 0);
      return "running";
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      switch (errnoCode(error)) {
        case "ESRCH":
          return "absent";
        case "EPERM":
          return "unsignalable";
        default:
          throw error;
      }
    }
  });
}

/** Signal every member we may signal; false when none could be signalled. */
function signalGroup(groupId: number, signal: NodeJS.Signals) {
  return Effect.sync(() => {
    try {
      process.kill(-groupId, signal);
      return true;
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      const code = errnoCode(error);
      if (code === "ESRCH" || code === "EPERM") return false;
      throw error;
    }
  });
}

/** Zombie-only groups are reaped promptly; longer EPERM means a foreign member. */
const maximumUnsignalablePolls = 200;

function awaitLeaderExit(
  process: ChildProcessSpawner.ChildProcessHandle,
): Effect.Effect<void, PlatformError> {
  return Effect.suspend(() =>
    Effect.flatMap(process.isRunning, (running) =>
      running
        ? Effect.sleep("10 millis").pipe(
            Effect.andThen(awaitLeaderExit(process)),
          )
        : Effect.void,
    ),
  );
}

function awaitGroupAbsence(
  groupId: number,
  unsignalablePolls = 0,
): Effect.Effect<void> {
  return Effect.suspend(() =>
    Effect.flatMap(groupState(groupId), (state) => {
      if (state === "absent") return Effect.void;
      if (
        state === "unsignalable" &&
        unsignalablePolls >= maximumUnsignalablePolls
      ) {
        return Effect.die(
          new CapabilityFailed({
            namespace: "Computer",
            operation: "cleanup",
            cause: {
              kind: "OperationFailed",
              message: `Computer process group ${String(groupId)} has members this invocation cannot signal`,
            },
          }),
        );
      }
      return Effect.sleep("10 millis").pipe(
        Effect.andThen(
          awaitGroupAbsence(
            groupId,
            state === "unsignalable" ? unsignalablePolls + 1 : 0,
          ),
        ),
      );
    }),
  );
}

function awaitProcessGroupExit(
  process: ChildProcessSpawner.ChildProcessHandle,
  groupId: number,
) {
  return Effect.all(
    [Effect.exit(awaitLeaderExit(process)), awaitGroupAbsence(groupId)],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.flatMap(([leader]) =>
      Exit.isFailure(leader) ? Effect.failCause(leader.cause) : Effect.void,
    ),
    Effect.orDie,
  );
}

function nativeGroupFinalizer(process: ChildProcessSpawner.ChildProcessHandle) {
  return Effect.sync(() => {
    const groupId = Number(process.pid);
    if (!Number.isSafeInteger(groupId) || groupId <= 1) {
      throw new Error(
        "ChildProcessSpawner returned an unsafe process group id",
      );
    }
    return groupId;
  }).pipe(
    Effect.flatMap((groupId) =>
      Effect.flatMap(groupState(groupId), (state) => {
        const completion = awaitProcessGroupExit(process, groupId);
        if (state !== "running") return completion;
        return Effect.flatMap(signalGroup(groupId, "SIGTERM"), () =>
          Effect.flatMap(
            Effect.timeoutOption(
              completion.pipe(Effect.interruptible),
              "1 second",
            ),
            Option.match({
              onNone: () =>
                signalGroup(groupId, "SIGKILL").pipe(
                  Effect.andThen(completion),
                ),
              onSome: () => Effect.void,
            }),
          ),
        );
      }),
    ),
  );
}

function captureBoundedOutput<E, R>(stream: Stream.Stream<Uint8Array, E, R>) {
  const initial: BoundedOutput = { chunks: [], byteLength: 0, totalBytes: 0 };
  return Stream.runFold(
    stream,
    () => initial,
    (captured, chunk) => {
      const remaining = keptStreamBytes - captured.byteLength;
      const totalBytes = captured.totalBytes + chunk.byteLength;
      if (remaining <= 0) return { ...captured, totalBytes };
      const kept =
        chunk.byteLength <= remaining ? chunk : chunk.slice(0, remaining);
      return {
        chunks: [...captured.chunks, kept],
        byteLength: captured.byteLength + kept.byteLength,
        totalBytes,
      };
    },
  );
}

/** Length of the longest prefix that does not end inside a UTF-8 character. */
function completeUtf8Length(bytes: Uint8Array) {
  let start = bytes.byteLength;
  while (start > 0 && ((bytes[start - 1] ?? 0) & 0xc0) === 0x80) start -= 1;
  if (start === 0) return 0;
  const lead = bytes[start - 1] ?? 0;
  const width = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  return start - 1 + width <= bytes.byteLength ? bytes.byteLength : start - 1;
}

function kibibytes(bytes: number) {
  return `${(bytes / 1_024).toFixed(1)} KiB`;
}

function textOutput(captured: BoundedOutput, stream: "stdout" | "stderr") {
  const bytes = new Uint8Array(captured.byteLength);
  let offset = 0;
  for (const chunk of captured.chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (captured.totalBytes <= captured.byteLength) {
    return { text: new TextDecoder().decode(bytes), truncation: [] };
  }
  const keptBytes = completeUtf8Length(bytes);
  const text = new TextDecoder().decode(bytes.subarray(0, keptBytes));
  return {
    text: `${text}\n[fungi: ${stream} truncated: ${kibibytes(keptBytes)} of ${kibibytes(captured.totalBytes)} shown; redirect to a file or use head/tail]`,
    truncation: [
      {
        stream,
        keptBytes,
        totalBytes: captured.totalBytes,
      },
    ],
  };
}

function truncationReport(
  ...parts: readonly (readonly z.output<typeof execTruncation>[])[]
) {
  const all = parts.flat();
  return all.length === 0 ? (false as const) : all;
}

function commandResult(
  exitCode: number,
  stdout: BoundedOutput,
  stderr: BoundedOutput,
): ExecOutput {
  const standardOutput = textOutput(stdout, "stdout");
  const standardError = textOutput(stderr, "stderr");
  return {
    status: exitCode === 0 ? "completed" : "failed",
    exitCode,
    stdout: standardOutput.text,
    stderr: standardError.text,
    truncated: truncationReport(
      standardOutput.truncation,
      standardError.truncation,
    ),
  };
}

/**
 * Human-readable label for timeout messages; never used for execution. Each
 * direct-form arg is JSON-quoted so the label does not read like a
 * re-runnable shell line.
 */
function describeRunRequest(request: z.output<typeof execInput>): string {
  return "command" in request
    ? request.command
    : [
        request.executable,
        ...request.args.map((arg) => JSON.stringify(arg)),
      ].join(" ");
}

/**
 * Build the one `ChildProcess.Command` for a run request. The direct form
 * passes `executable`/`args` straight to `ChildProcess.make`, never through a
 * shell; only the intentional shell form interpolates into `sh -c`.
 */
function buildRunCommand(
  request: z.output<typeof execInput>,
  cwd: string,
  executionPath: string,
  home: string,
  sandbox?: LocalSandboxLaunch,
): ChildProcess.Command {
  const env = privateLocalExecEnvironment(executionPath, {
    HOME: home,
    XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR,
    DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS,
  });
  // Effect's own default stdin is an open "pipe" that nothing closes, so an
  // executable that reads stdin (`cat`, `python3 -`) would otherwise hang
  // for the full timeout. "ignore" gives it immediate EOF, matching the
  // background process owner's existing behavior for an omitted stdin.
  const stdin =
    request.stdin === undefined
      ? "ignore"
      : Stream.make(new TextEncoder().encode(request.stdin));
  const argv: [string, ...string[]] =
    "command" in request
      ? ["sh", "-c", request.command]
      : [request.executable, ...request.args];
  // Admission happens before spawn and is never retried after an executable
  // may have run. Folder validity and requireSandbox belong to the host.
  const launch = sandbox?.(cwd, argv);
  if (launch !== undefined) {
    delete env.XDG_RUNTIME_DIR;
    delete env.DBUS_SESSION_BUS_ADDRESS;
  }
  return ChildProcess.make(
    launch?.executable ?? argv[0],
    launch?.args ?? argv.slice(1),
    {
      cwd,
      env: { ...env, ...launch?.environment },
      extendEnv: false,
      stdin,
      additionalFds:
        launch?.seccompFilter === undefined
          ? undefined
          : {
              fd3: { type: "input", stream: Stream.make(launch.seccompFilter) },
            },
    },
  );
}

/**
 * Only the direct form names an executable the host itself must locate and
 * run; the shell form's `sh` is a fixed, always-present interpreter, so a
 * missing-executable mapping only ever applies to `request.executable`.
 */
function isMissingExecutableFailure(cause: unknown): cause is PlatformError & {
  reason: { _tag: "NotFound" | "PermissionDenied" };
} {
  return (
    isPlatformError(cause) &&
    (cause.reason._tag === "NotFound" ||
      cause.reason._tag === "PermissionDenied")
  );
}

async function runCommandAtInvocationBoundary(
  request: z.output<typeof execInput>,
  cwd: string,
  executionPath: string,
  home: string,
  signal: AbortSignal,
  sandbox?: LocalSandboxLaunch,
): Promise<ExecOutput> {
  const processCommand = buildRunCommand(
    request,
    cwd,
    executionPath,
    home,
    sandbox,
  );
  const timeoutMs = Math.min(request.timeoutMs, maximumCommandTimeoutMs);
  try {
    return await runPrivateInvocationProcess(
      processCommand,
      signal,
      timeoutMs,
      {
        requestedMs: request.timeoutMs,
        describeCommand: () => describeRunRequest(request),
      },
    );
  } catch (cause) {
    // Spawning the direct form's named executable can fail at the OS level
    // before any ExecOutput exists (ENOENT/EACCES), surfacing as an untyped
    // Effect PlatformError that would otherwise reach the model only as a
    // generic sandbox failure. Report it the same honest way as the NUL
    // refusal: a typed CapabilityFailed naming the executable, no process
    // started.
    if ("executable" in request && isMissingExecutableFailure(cause))
      throw new CapabilityFailed({
        namespace: "Computer",
        operation: "exec",
        cause: {
          kind: "InvalidInput",
          message: `Executable ${request.executable} was not found on PATH or could not be run; no process was started.`,
        },
      });
    throw cause;
  }
}

/** Shared bounded native process owner; callers supply argv/stdin, never shell interpolation. */
export function runPrivateInvocationProcess(
  processCommand: ChildProcess.Command,
  signal: AbortSignal,
  timeoutMs: number | undefined,
  describe?: Readonly<{
    /** The timeout actually requested, before any clamp; defaults to `timeoutMs`. */
    requestedMs?: number;
    /** The real command text, for the timeout message; omitted when not meaningful (e.g. a native helper). */
    describeCommand?: () => string;
  }>,
): Promise<ExecOutput> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const startedAt = yield* Clock.currentTimeMillis;
        const executor = yield* ChildProcessSpawner.ChildProcessSpawner;
        const processScope = yield* Effect.acquireRelease(
          Scope.make(),
          (scope) => Scope.close(scope, Exit.void),
        );
        const process = yield* Effect.acquireRelease(
          executor.spawn(processCommand),
          nativeGroupFinalizer,
        ).pipe(Effect.provideService(Scope.Scope, processScope));
        // Keep both readers alive when the exit wait times out. Killing and
        // reaping the owned group closes the pipes, preserving bounded output.
        const stdoutFiber = yield* Effect.forkChild(
          captureBoundedOutput(process.stdout),
        );
        const stderrFiber = yield* Effect.forkChild(
          captureBoundedOutput(process.stderr),
        );
        const exited = yield* timeoutMs === undefined
          ? Effect.map(process.exitCode, Option.some)
          : Effect.timeoutOption(process.exitCode, timeoutMs);
        yield* Scope.close(processScope, Exit.void);
        const [stdout, stderr] = yield* Effect.all(
          [Fiber.join(stdoutFiber), Fiber.join(stderrFiber)],
          { concurrency: "unbounded" },
        );
        if (Option.isSome(exited))
          return commandResult(Number(exited.value), stdout, stderr);
        if (timeoutMs === undefined)
          throw new Error("Missing command deadline");
        const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
        const standardOutput = textOutput(stdout, "stdout");
        const standardError = textOutput(stderr, "stderr");
        return {
          status: "deadline_exceeded",
          timeoutMs,
          elapsedMs,
          exitCode: -1,
          stdout: standardOutput.text,
          stderr: standardError.text,
          message:
            describe?.describeCommand === undefined
              ? `Command exceeded timeoutMs=${String(timeoutMs)} ms. Rerun with a larger timeoutMs, up to ${String(maximumCommandTimeoutMs)} ms; split longer work into separate tool calls.`
              : commandTimeoutMessage({
                  command: describe.describeCommand(),
                  timeoutMs,
                  requestedMs: describe.requestedMs ?? timeoutMs,
                }),
          truncated: truncationReport(
            standardOutput.truncation,
            standardError.truncation,
          ),
        } satisfies ExecOutput;
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
    { signal },
  );
}

async function execute(
  root: string,
  executionPath: string,
  home: string,
  request: z.output<typeof execInput>,
  context: InvocationContext,
  sandbox?: LocalSandboxLaunch,
): Promise<ExecOutput> {
  context.signal.throwIfAborted();
  const cwd = await resolveCwd(root, request.cwd);
  context.signal.throwIfAborted();
  return runCommandAtInvocationBoundary(
    request,
    cwd,
    executionPath,
    home,
    context.signal,
    sandbox,
  );
}

/**
 * Construct one private invocation-root Computer: bounded shell exec, plus the
 * background-process operations of `processes` when the host supplies a scope.
 */
export async function createPrivateInvocationComputer(
  invocationRoot: string,
  executionPath: string = capturePrivateLocalExecPath(
    process.env.PATH ?? "/usr/bin:/bin",
    process.cwd(),
  ),
  processes?: PrivateLocalProcessScope,
  /** Selected host home; standalone callers capture it before any await. */
  home: string = capturePrivateLocalConfigRoot().home,
  /** Native Local always supplies its live per-Agent admission callback. */
  sandbox?: LocalSandboxLaunch,
): Promise<KnapsackComputer> {
  const path = parsePrivateLocalExecPath(executionPath);
  const root = await realpath(resolve(invocationRoot));
  return Object.freeze({
    getCapabilities: () =>
      Promise.resolve(computerCapabilities(root, processes)),
    call: async (capabilityId, input, context) => {
      const selected = capabilityNameSchema.parse(capabilityId);
      if (selected !== "exec")
        throw new Error(`Computer capability is unavailable: ${selected}`);
      const request = (processes === undefined ? execInput : shellInput).parse(
        input,
      );
      // execve passes argv as NUL-terminated C strings; a NUL embedded in the
      // shell command, the direct executable, or any direct arg would
      // silently truncate it instead of running the submitted text. stdin is
      // a byte stream, not a C string, so it is exempt. The empty array is
      // every poll/wait/kill/list request: none of those carry argv at all.
      const launchArgv =
        "command" in request
          ? [request.command]
          : "executable" in request
            ? [request.executable, ...request.args]
            : [];
      if (launchArgv.some((value) => value.includes("\0")))
        throw new CapabilityFailed({
          namespace: "Computer",
          operation: "exec",
          cause: {
            kind: "InvalidInput",
            message:
              "Computer exec command or argument contains a NUL byte. Remove it or double the backslash in JavaScript escapes (for example, \\\\x00); no process was started.",
          },
        });
      if (request.operation === "run")
        return execute(root, path, home, request, context, sandbox);
      if (processes !== undefined)
        return jsonValueSchema.parse(
          await callBackgroundExec(
            processes,
            request,
            (requested) => resolveCwd(root, requested),
            path,
            context.signal,
            sandbox,
          ),
        );
      throw new Error(`Computer capability is unavailable: ${selected}`);
    },
  });
}
