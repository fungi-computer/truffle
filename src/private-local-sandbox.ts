import { isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createNativePayloadStaging } from "./private-local-native-staging.js";
import type { NativeSourceReader } from "./private-local-bwrap.js";
import { z } from "zod";
import {
  establishLocalSandbox,
  LocalSandboxUnavailable,
  sandboxUnavailableReason,
  sandboxUnavailableReasonSchema,
  type LocalSandbox,
  type SandboxCommand,
} from "./private-local-containment.js";
import type { BareNativeCommand } from "./private-invocation-computer.js";
import type { LocalSandboxWrites } from "./private-invocation-files.js";
import {
  protectedSandboxPaths,
  assertHostCodeOutsideAgent,
  UnsafeHostCode,
  resolveAgentFolder,
  sandboxPolicy,
  type NativeRunLivenessProbe,
} from "./private-local-sandbox-policy.js";

/** Availability is not a hostile-program security or an approval status. */
export const sandboxStatusSchema = z.discriminatedUnion("state", [
  z.strictObject({
    state: z.literal("available"),
    requireSandbox: z.boolean(),
  }),
  z.strictObject({
    state: z.literal("unavailable"),
    requireSandbox: z.boolean(),
    reason: sandboxUnavailableReasonSchema,
  }),
]);
export type LocalSandboxStatus = z.output<typeof sandboxStatusSchema>;

export type LocalSandboxControls = LocalSandboxWrites &
  Readonly<{
    assertReady(): void;
    status(): LocalSandboxStatus;
    close(): void;
  }>;

function contains(root: string, path: string) {
  const within = relative(root, path);
  return (
    !isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`)
  );
}

/**
 * Native Local owns the live requirement; the adapter owns only preparation.
 * Every consumer calls this authority immediately before launching or writing.
 */
export function createLocalSandboxControls(
  input: Readonly<{
    project: string;
    folder: string;
    required(): boolean;
    platform?: string;
    readNativePatchSource?: NativeSourceReader;
    probeNativeRunLiveness?: NativeRunLivenessProbe;
  }>,
): LocalSandboxControls {
  const required = input.required();
  const folder = resolveAgentFolder(input.project, input.folder);
  // The packed Node wrapper passes the paths it actually loaded. In source
  // runs this module is the executing host authority instead. Check before
  // staging or probing, independent of the optional/required setting.
  try {
    const launcher = process.env.FUNGI_LAUNCHER;
    const cli =
      launcher === undefined
        ? fileURLToPath(import.meta.url)
        : process.env.FUNGI_BUNDLED_CLI;
    if (cli === undefined)
      throw new UnsafeHostCode(
        "Packed CLI entry was not provided by the launcher; reinstall Fungi outside the project.",
      );
    assertHostCodeOutsideAgent(input.project, cli, launcher ?? cli);
  } catch (cause) {
    throw new LocalSandboxUnavailable(
      cause instanceof UnsafeHostCode
        ? sandboxUnavailableReason(cause)
        : {
            kind: "unsafe-host-code",
            message: `Fungi host JavaScript identity cannot be verified (${cause instanceof Error ? cause.message : String(cause)}); reinstall Fungi using a copying install outside the project.`,
          },
    );
  }
  const platform =
    input.platform === undefined ? {} : { platform: input.platform };
  const native = createNativePayloadStaging(
    input.project,
    input.readNativePatchSource,
    input.probeNativeRunLiveness,
  );
  const initial = establishLocalSandbox(
    {
      project: input.project,
      folder: folder.absolute,
      ...platform,
    },
    native,
  );
  let sandbox: LocalSandbox | undefined =
    initial.state === "ready" ? initial.sandbox : undefined;
  let everReady = initial.state === "ready";
  let unavailable =
    initial.state === "unavailable" ? initial.reason : undefined;
  if (unavailable !== undefined) {
    if (unavailable.kind === "invalid-folder") {
      native.close();
      throw new Error(unavailable.message);
    }
    if (required) {
      native.close();
      throw new LocalSandboxUnavailable(unavailable);
    }
  }
  let closed = false;
  const assertFolder = () => {
    if (closed) throw new Error("Local sandbox owner is closed");
    try {
      const current = resolveAgentFolder(input.project, input.folder);
      if (current.absolute === folder.absolute) return;
      throw new Error("Local Agent folder authority changed while open");
    } catch (cause) {
      if (!everReady) throw cause;
      unavailable = {
        kind: "invalid-folder",
        message: cause instanceof Error ? cause.message : String(cause),
      };
      throw new LocalSandboxUnavailable(unavailable);
    }
  };
  function launch(
    cwd: string,
    argv: readonly [string, ...string[]],
  ): SandboxCommand | undefined;
  function launch(
    cwd: string,
    argv: readonly [string, ...string[]],
    readOnlyHelperFile: string,
  ): SandboxCommand | BareNativeCommand;
  function launch(
    cwd: string,
    argv: readonly [string, ...string[]],
    readOnlyHelperFile?: string,
  ): SandboxCommand | BareNativeCommand | undefined {
    assertFolder();
    if (sandbox === undefined) {
      const admission = establishLocalSandbox(
        {
          project: input.project,
          folder: folder.absolute,
          ...platform,
        },
        native,
      );
      if (admission.state === "ready") {
        sandbox = admission.sandbox;
        everReady = true;
      } else unavailable = admission.reason;
    }
    if (sandbox !== undefined) {
      try {
        const command = sandbox.command(cwd, argv, readOnlyHelperFile);
        unavailable = undefined;
        return command;
      } catch (cause) {
        unavailable =
          cause instanceof LocalSandboxUnavailable
            ? cause.reason
            : sandboxUnavailableReason(cause);
        throw new LocalSandboxUnavailable(unavailable);
      }
    }
    if (unavailable === undefined)
      throw new Error("Local sandbox preparation produced no result");
    if (unavailable.kind === "invalid-folder" && !everReady)
      throw new Error(unavailable.message);
    // A formerly ready sandbox never becomes optional bare execution.
    // Before readiness, only availability failures permit fallback.
    if (
      everReady ||
      (unavailable.kind !== "missing" &&
        unavailable.kind !== "unsupported-platform" &&
        unavailable.kind !== "startup-refused")
    )
      throw new LocalSandboxUnavailable(unavailable);
    if (input.required()) throw new LocalSandboxUnavailable(unavailable);
    // Files is never handed back its installed executable for a bare retry.
    if (readOnlyHelperFile !== undefined) {
      try {
        return {
          bareNative: true,
          executable: native.patch(readOnlyHelperFile),
          args: [],
          environment: { TMPDIR: process.env.TMPDIR ?? tmpdir() },
        };
      } catch (cause) {
        unavailable = sandboxUnavailableReason(cause);
        throw new LocalSandboxUnavailable(unavailable);
      }
    }
    // No executable has started. Generic exec retains its ordinary fallback.
    return undefined;
  }
  const assertReady = () => {
    launch(folder.absolute, ["/usr/bin/true"]);
  };
  return {
    launch,
    assertReady,
    assertWrite: (path) => {
      assertReady();
      const target = resolve(path);
      const policy = sandboxPolicy(input.project, folder.absolute);
      if (
        !contains(policy.writableRoot, target) ||
        protectedSandboxPaths(policy.readOnly).some((protectedPath) =>
          contains(protectedPath, target),
        ) ||
        protectedSandboxPaths(policy.immovable).includes(target)
      )
        throw new Error("Files write targets a protected Local path");
    },
    status: () => {
      if (closed) throw new Error("Local sandbox owner is closed");
      return unavailable === undefined
        ? { state: "available", requireSandbox: input.required() }
        : {
            state: "unavailable",
            requireSandbox: input.required(),
            reason: unavailable,
          };
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        sandbox?.close();
      } finally {
        native.close();
      }
    },
  };
}
