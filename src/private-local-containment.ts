import { spawnSync } from "node:child_process";
import { closeSync, openSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { LocalBwrapUnavailable } from "./private-local-bwrap.js";
import {
  createNativePayloadStaging,
  type NativePayloadStaging,
} from "./private-local-native-staging.js";
import { linuxSandboxCommand } from "./private-local-linux-sandbox.js";
import {
  seatbeltCommand,
  UnsafeSeatbeltFolder,
} from "./private-local-seatbelt.js";
import {
  sandboxPolicy,
  linuxSandboxProfile,
  UnsafeGitMarker,
  UnsafeHostCode,
  UnsafeNativePayload,
} from "./private-local-sandbox-policy.js";
import { z } from "zod";
import type { LocalPermissionMode } from "./private-local-permission-mode.js";

export const sandboxUnavailableReasonSchema = z.strictObject({
  kind: z.enum(["unsupported", "install", "folder", "startup-refused"]),
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
  environment: Readonly<{ TMPDIR: string; SSH_AUTH_SOCK?: string }>;
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
  if (cause instanceof UnsafeGitMarker)
    return { kind: "folder", message: cause.message };
  if (cause instanceof UnsafeSeatbeltFolder)
    return { kind: "folder", message: cause.message };
  if (cause instanceof UnsafeHostCode)
    return { kind: "install", message: cause.message };
  if (cause instanceof UnsafeNativePayload)
    return { kind: "install", message: cause.message };
  if (cause instanceof LocalBwrapUnavailable)
    return { kind: cause.reason, message: cause.message };
  return {
    kind: "startup-refused",
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
    mode: Exclude<LocalPermissionMode, "full-access">;
    temporaryDirectory: string;
    platform?: string;
  }>,
  staging?: NativePayloadStaging,
  /** Host startup probe; a Linux command-generation test can supply its own runner. */
  runProbe?: (command: SandboxCommand) => Readonly<{
    status: number | null;
    stderr: string;
    signal: string | null;
    error?: Error;
  }>,
): SandboxAdmission {
  try {
    sandboxPolicy(input.project, input.folder);
  } catch (cause) {
    return {
      state: "unavailable",
      reason: {
        kind: "folder",
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
        kind: "unsupported",
        message: `${input.mode === "workspace" ? "Workspace" : "Read-only"} on ${platform} needs a supported OS sandbox; use --yolo or run on macOS/Linux.`,
      },
    };

  let native: NativePayloadStaging | undefined;
  try {
    native =
      staging ??
      (platform === "linux"
        ? createNativePayloadStaging(input.project)
        : undefined);
    const environmentTmp =
      platform === "linux" ? "/tmp" : input.temporaryDirectory;
    let closed = false;
    const sandbox: LocalSandbox = {
      command: (cwd, argv, readOnlyHelperFile) => {
        if (closed)
          throw new LocalSandboxUnavailable({
            kind: "startup-refused",
            message: "Sandbox has been closed.",
          });
        // Failed/incomplete authority discovery is not an unavailable backend:
        // it must not turn into an authorized unsandboxed retry.
        const policy = sandboxPolicy(input.project, input.folder);
        try {
          const profile = linuxSandboxProfile(
            policy,
            input.mode,
            input.temporaryDirectory,
            process.env,
            userInfo().homedir,
            platform,
          );
          const linuxPayload =
            platform === "linux" ? native?.linux(profile) : undefined;
          const stagedHelper =
            readOnlyHelperFile === undefined
              ? undefined
              : native?.patch(readOnlyHelperFile);
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
                  profile,
                  linuxPayload,
                  cwd,
                  stagedArgv,
                  undefined,
                  stagedHelper,
                )
              : seatbeltCommand(profile, stagedArgv);
          let environment: SandboxCommand["environment"] = {
            TMPDIR: environmentTmp,
          };
          if (platform === "linux" && profile.sshAgentSocket !== undefined)
            environment = {
              TMPDIR: environmentTmp,
              SSH_AUTH_SOCK: profile.sshAgentSocket,
            };
          return { ...launch, environment };
        } catch (cause) {
          throw new LocalSandboxUnavailable(sandboxUnavailableReason(cause));
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        if (staging === undefined) native?.close();
      },
    };
    const command = sandbox.command(realpathSync(input.folder), [
      "/usr/bin/true",
    ]);
    let filterDescriptor: number | undefined;
    const probe = () => {
      if (command.seccompFilter !== undefined) {
        const path = native?.probeFilter(command.seccompFilter);
        if (path === undefined)
          throw new Error("No Linux filter staging owner");
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
        return runProbe?.(command) ?? probe();
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
          message: `${input.mode === "workspace" ? "Workspace" : "Read-only"} on this ${platform === "darwin" ? "Mac" : "Linux host"} needs a working ${platform === "darwin" ? "sandbox-exec profile probe" : "bwrap installation"}; use --yolo or ${platform === "darwin" ? "check the failed Seatbelt profile probe" : "fix the sandbox installation"}. ${
            result.error?.message ??
            (stderr.length > 0
              ? stderr
              : `Sandbox startup exited ${String(result.status)} (${String(result.signal)}).`)
          }`,
        },
      };
    }
    return { state: "ready", sandbox };
  } catch (cause) {
    if (staging === undefined) native?.close();
    return {
      state: "unavailable",
      reason:
        cause instanceof LocalSandboxUnavailable
          ? cause.reason
          : sandboxUnavailableReason(cause),
    };
  }
}
