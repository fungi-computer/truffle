import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalBwrapUnavailable } from "./private-local-bwrap.js";
import {
  createNativePayloadStaging,
  type NativePayloadStaging,
} from "./private-local-native-staging.js";
import { linuxSandboxCommand } from "./private-local-linux-sandbox.js";
import { seatbeltCommand } from "./private-local-seatbelt.js";
import {
  sandboxPolicy,
  UnsafeHostCode,
  UnsafeNativePayload,
} from "./private-local-sandbox-policy.js";
import { z } from "zod";

export const sandboxUnavailableReasonSchema = z.strictObject({
  kind: z.enum([
    "unsupported-platform",
    "invalid-folder",
    "missing",
    "missing-artifact",
    "invalid-digest",
    "digest-mismatch",
    "unreadable",
    "not-executable",
    "staging-failed",
    "unsafe-native-payload",
    "unsafe-host-code",
    "startup-refused",
    "backend-refused",
  ]),
  message: z.string(),
});

export type SandboxUnavailableReason = z.output<
  typeof sandboxUnavailableReasonSchema
>;

export class LocalSandboxUnavailable extends Error {
  override readonly name = "LocalSandboxUnavailable";
  constructor(readonly reason: SandboxUnavailableReason) {
    super(`Local sandbox unavailable: ${reason.message}`);
  }
}

export type SandboxCommand = Readonly<{
  executable: string;
  args: readonly string[];
  environment: Readonly<{ TMPDIR: string }>;
  /** Linux only: feed these verified bytes to fd3; never inherit arbitrary fds. */
  seccompFilter?: Uint8Array;
}>;

/** Existing foreground/background owners retain process and cancellation lifetime. */
export type LocalSandbox = Readonly<{
  command(
    cwd: string,
    argv: readonly [string, ...string[]],
    readOnlyHelperFile?: string,
  ): SandboxCommand;
  close(): void;
}>;

export type SandboxAdmission =
  | Readonly<{ state: "ready"; sandbox: LocalSandbox }>
  | Readonly<{ state: "unavailable"; reason: SandboxUnavailableReason }>;

export function sandboxUnavailableReason(
  cause: unknown,
): SandboxUnavailableReason {
  if (cause instanceof UnsafeHostCode)
    return { kind: "unsafe-host-code", message: cause.message };
  if (cause instanceof UnsafeNativePayload)
    return { kind: "unsafe-native-payload", message: cause.message };
  if (cause instanceof LocalBwrapUnavailable)
    return { kind: cause.reason, message: cause.message };
  return {
    kind: "backend-refused",
    message:
      cause instanceof Error ? cause.message : "Sandbox preparation failed.",
  };
}

/**
 * The caller already owns the person's auto-approve choice. This module has no
 * mode, setting, bare-command branch, PATH fallback or permission to widen it.
 * A ready result proves only that the backend can start, not the escape matrix.
 */
export function establishLocalSandbox(
  input: Readonly<{
    project: string;
    /** Absolute folder selected by the Local owner. */
    folder: string;
    platform?: string;
  }>,
  staging?: NativePayloadStaging,
): SandboxAdmission {
  try {
    sandboxPolicy(input.project, input.folder);
  } catch (cause) {
    return {
      state: "unavailable",
      reason: {
        kind: "invalid-folder",
        message:
          cause instanceof Error ? cause.message : "Invalid sandbox folder.",
      },
    };
  }
  const platform = input.platform ?? process.platform;
  if (platform !== "linux" && platform !== "darwin")
    return {
      state: "unavailable",
      reason: {
        kind: "unsupported-platform",
        message: `Local sandbox is unavailable on ${platform}.`,
      },
    };

  const native = staging ?? createNativePayloadStaging(input.project);
  let agentTemporaryDirectory: string | undefined;
  try {
    // Native staging is never granted as an Agent-writable temporary root.
    if (platform === "darwin")
      agentTemporaryDirectory = realpathSync(
        mkdtempSync(join(tmpdir(), "fungi-sandbox-")),
      );
    const agentTemporary = agentTemporaryDirectory;
    const environmentTmp = agentTemporary ?? "/tmp";
    let closed = false;
    const sandbox: LocalSandbox = {
      command: (cwd, argv, readOnlyHelperFile) => {
        if (closed)
          throw new LocalSandboxUnavailable({
            kind: "backend-refused",
            message: "Sandbox has been closed.",
          });
        // Failed/incomplete authority discovery is not an unavailable backend:
        // it must not turn into an authorized unsandboxed retry.
        const policy = sandboxPolicy(input.project, input.folder);
        try {
          const linuxPayload =
            platform === "linux" ? native.linux(policy) : undefined;
          const stagedHelper =
            readOnlyHelperFile === undefined
              ? undefined
              : native.patch(readOnlyHelperFile);
          const stagedArgv: readonly [string, ...string[]] =
            stagedHelper === undefined
              ? argv
              : [
                  argv[0] === readOnlyHelperFile ? stagedHelper : argv[0],
                  ...argv
                    .slice(1)
                    .map((argument) =>
                      argument === readOnlyHelperFile ? stagedHelper : argument,
                    ),
                ];
          const launch =
            linuxPayload !== undefined
              ? linuxSandboxCommand(
                  policy,
                  linuxPayload,
                  cwd,
                  stagedArgv,
                  undefined,
                  stagedHelper,
                )
              : seatbeltCommand(
                  {
                    ...policy,
                    temporaryDirectory: environmentTmp,
                  },
                  stagedArgv,
                );
          return {
            ...launch,
            environment: { TMPDIR: environmentTmp },
          };
        } catch (cause) {
          throw new LocalSandboxUnavailable(sandboxUnavailableReason(cause));
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        try {
          if (staging === undefined) native.close();
        } finally {
          if (agentTemporary !== undefined)
            rmSync(agentTemporary, { recursive: true });
        }
      },
    };
    const command = sandbox.command(realpathSync(input.folder), [
      "/usr/bin/true",
    ]);
    let filterDescriptor: number | undefined;
    const probe = () => {
      if (command.seccompFilter !== undefined) {
        const path = native.probeFilter(command.seccompFilter);
        filterDescriptor = openSync(path, "r");
      }
      return spawnSync(command.executable, [...command.args], {
        cwd: input.folder,
        env: { ...command.environment },
        encoding: "utf8",
        timeout: 5_000,
        // Node's maintained spawn allowlist closes every other inherited fd.
        // bwrap loads and closes fd3 before exec (seccomp_program_new).
        stdio: [
          "ignore",
          "pipe",
          "pipe",
          ...(filterDescriptor === undefined ? [] : [filterDescriptor]),
        ],
      });
    };
    const result = (() => {
      try {
        return probe();
      } finally {
        if (filterDescriptor !== undefined) closeSync(filterDescriptor);
      }
    })();
    if (result.status !== 0) {
      sandbox.close();
      const stderr = result.error === undefined ? result.stderr.trim() : "";
      return {
        state: "unavailable",
        reason: {
          kind: "startup-refused",
          message:
            result.error?.message ??
            (stderr.length > 0
              ? stderr
              : `Sandbox startup exited ${String(result.status)} (${String(result.signal)}).`),
        },
      };
    }
    return { state: "ready", sandbox };
  } catch (cause) {
    try {
      if (staging === undefined) native.close();
    } finally {
      if (agentTemporaryDirectory !== undefined)
        rmSync(agentTemporaryDirectory, { recursive: true });
    }
    return {
      state: "unavailable",
      reason:
        cause instanceof LocalSandboxUnavailable
          ? cause.reason
          : sandboxUnavailableReason(cause),
    };
  }
}
