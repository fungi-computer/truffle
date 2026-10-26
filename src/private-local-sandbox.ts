import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";
import { createNativePayloadStaging } from "./private-local-native-staging.js";
import type { NativeSourceReader } from "./private-local-bwrap.js";
import { z } from "zod";
import {
  establishLocalSandbox,
  LocalSandboxUnavailable,
  sandboxUnavailableReason,
  sandboxUnavailableReasonSchema,
  type SandboxUnavailableReason,
  type LocalSandbox,
  type SandboxCommand,
} from "./private-local-containment.js";
import type { LocalPermissionMode } from "./private-local-permission-mode.js";
import type { LocalSandboxWrites } from "./private-invocation-files.js";
import {
  protectedSandboxPaths,
  assertHostCodeOutsideAgent,
  UnsafeHostCode,
  resolveAgentFolder,
  sandboxPolicy,
  agentSandboxTemporaryDirectory,
} from "./private-local-sandbox-policy.js";
import type { NativePayloadStaging } from "./private-local-native-staging.js";

/** Availability is not a hostile-program security or an approval status. */
export const sandboxStatusSchema = z.strictObject({
  mode: z.enum(["full-access", "workspace", "read-only"]),
  available: z.boolean(),
  reason: sandboxUnavailableReasonSchema.optional(),
});
export type LocalSandboxStatus = z.output<typeof sandboxStatusSchema>;

export type LocalSandboxControls = LocalSandboxWrites &
  Readonly<{
    assertReady(): void;
    assertModeReady(mode: LocalPermissionMode): void;
    status(): LocalSandboxStatus;
    close(): void;
  }>;

/** Refusal before an Agent Files write can be staged or dispatched. */
export class ProtectedLocalFilesPath extends Error {
  override readonly name = "ProtectedLocalFilesPath";
  constructor(readonly path: string) {
    super(`Files write targets a protected Local path: ${path}`);
  }
}

function contains(root: string, path: string) {
  const within = relative(root, path);
  return (
    !isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`)
  );
}

/**
 * Native Local owns the live mode; the adapter owns only preparation.
 * Every consumer calls this authority immediately before launching or writing.
 */
export function createLocalSandboxControls(
  input: Readonly<{
    project: string;
    folder: string;
    agentId?: string;
    mode(): LocalPermissionMode;
    defaultReason?: z.output<typeof sandboxUnavailableReasonSchema> | undefined;
    platform?: string;
    readNativePatchSource?: NativeSourceReader;
    native?: NativePayloadStaging | undefined;
  }>,
): LocalSandboxControls {
  const mode = input.mode();
  const folder = resolveAgentFolder(input.project, input.folder);
  // Before an Agent store exists, a probe has a disposable temporary owner,
  // not a fabricated Local store identity.
  const temporaryOwner =
    input.agentId ??
    `probe-${String(process.pid)}-${process.hrtime.bigint().toString(36)}`;
  // The packed Node wrapper passes the paths it actually loaded. In source
  // runs this module is the executing host authority instead. Check before
  // staging or probing. Full access never calls this admission.
  const assertHostCode = () => {
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
              kind: "install",
              message: `Fungi host JavaScript identity cannot be verified (${cause instanceof Error ? cause.message : String(cause)}); reinstall Fungi using a copying install outside the project.`,
            },
      );
    }
  };
  if (mode !== "full-access") assertHostCode();
  let hostCodeAdmitted = mode !== "full-access";
  let temporaryDirectory =
    mode === "full-access"
      ? undefined
      : agentSandboxTemporaryDirectory(temporaryOwner, input.project);
  const platform =
    input.platform === undefined ? {} : { platform: input.platform };
  const supportedPlatform =
    (input.platform ?? process.platform) === "linux" ||
    (input.platform ?? process.platform) === "darwin";
  const ownNative = () => {
    try {
      return createNativePayloadStaging(
        input.project,
        input.readNativePatchSource,
      );
    } catch (cause) {
      throw new LocalSandboxUnavailable(sandboxUnavailableReason(cause));
    }
  };
  const admitNative = (staging: NativePayloadStaging | undefined) => {
    try {
      staging?.admitProject(input.project);
    } catch (cause) {
      throw new LocalSandboxUnavailable(sandboxUnavailableReason(cause));
    }
  };
  let native: NativePayloadStaging | undefined;
  let nativeAdmitted = false;
  let initial: ReturnType<typeof establishLocalSandbox> | undefined;
  try {
    if (mode !== "full-access") {
      native = supportedPlatform ? (input.native ?? ownNative()) : undefined;
      admitNative(native);
      nativeAdmitted = native !== undefined;
      initial = establishLocalSandbox(
        {
          project: input.project,
          folder: folder.absolute,
          mode,
          temporaryDirectory:
            temporaryDirectory ??
            agentSandboxTemporaryDirectory(temporaryOwner, input.project),
          ...platform,
        },
        native,
      );
    }
  } catch (cause) {
    try {
      if (input.native === undefined) native?.close();
    } finally {
      if (temporaryDirectory !== undefined)
        rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    throw cause;
  }
  let sandbox: LocalSandbox | undefined =
    initial?.state === "ready" ? initial.sandbox : undefined;
  let preparedMode: LocalPermissionMode | undefined =
    sandbox === undefined ? undefined : mode;
  let unavailable =
    initial?.state === "unavailable" ? initial.reason : input.defaultReason;
  if (unavailable !== undefined) {
    if (temporaryDirectory !== undefined)
      rmSync(temporaryDirectory, { recursive: true, force: true });
    if (unavailable.kind === "folder") {
      if (input.native === undefined) native?.close();
      throw new Error(unavailable.message);
    }
    if (mode !== "full-access") {
      if (input.native === undefined) native?.close();
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
      unavailable = {
        kind: "folder",
        message: cause instanceof Error ? cause.message : String(cause),
      };
      throw new LocalSandboxUnavailable(unavailable);
    }
  };
  function prepareSandbox(
    nextMode: Exclude<LocalPermissionMode, "full-access">,
  ) {
    if (sandbox !== undefined && preparedMode === nextMode) return;
    sandbox?.close();
    sandbox = undefined;
    if (!hostCodeAdmitted) {
      assertHostCode();
      hostCodeAdmitted = true;
    }
    native ??= input.native ?? ownNative();
    if (!nativeAdmitted) {
      admitNative(native);
      nativeAdmitted = true;
    }
    temporaryDirectory ??= agentSandboxTemporaryDirectory(
      temporaryOwner,
      input.project,
    );
    const admission = establishLocalSandbox(
      {
        project: input.project,
        folder: folder.absolute,
        mode: nextMode,
        temporaryDirectory,
        ...platform,
      },
      native,
    );
    if (admission.state === "ready") {
      sandbox = admission.sandbox;
      preparedMode = nextMode;
      unavailable = undefined;
    } else {
      unavailable = admission.reason;
      throw new LocalSandboxUnavailable(unavailable);
    }
  }
  function launch(
    cwd: string,
    argv: readonly [string, ...string[]],
    readOnlyHelperFile?: string,
  ): SandboxCommand | undefined {
    assertFolder();
    if (input.mode() === "full-access") return undefined;
    prepareSandbox(input.mode() === "read-only" ? "read-only" : "workspace");
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
    if (unavailable.kind === "folder") throw new Error(unavailable.message);
    throw new LocalSandboxUnavailable(unavailable);
  }
  const assertReady = () => {
    if (input.mode() === "full-access") return;
    launch(folder.absolute, ["/usr/bin/true"]);
  };
  return {
    launch,
    assertReady,
    assertModeReady: (nextMode) => {
      if (nextMode === "full-access") return;
      assertFolder();
      prepareSandbox(nextMode);
      if (sandbox === undefined)
        throw new Error("Local sandbox preparation produced no result");
      sandbox.command(folder.absolute, ["/usr/bin/true"]);
    },
    assertWrite: (paths) => {
      if (input.mode() === "full-access") return;
      assertReady();
      const policy = sandboxPolicy(input.project, folder.absolute);
      const protectedPaths = protectedSandboxPaths([
        ...policy.readOnly,
        join(policy.writableRoot, ".git"),
      ]);
      for (const path of paths) {
        const target = resolve(path);
        if (
          !contains(policy.writableRoot, target) ||
          protectedPaths.some((protectedPath) =>
            contains(protectedPath, target),
          )
        )
          throw new ProtectedLocalFilesPath(target);
      }
    },
    status: () => {
      if (closed) throw new Error("Local sandbox owner is closed");
      return unavailable === undefined
        ? { mode: input.mode(), available: true }
        : { mode: input.mode(), available: false, reason: unavailable };
    },
    close: () => {
      if (closed) return;
      closed = true;
      try {
        sandbox?.close();
      } finally {
        if (input.native === undefined) native?.close();
        if (temporaryDirectory !== undefined)
          rmSync(temporaryDirectory, { recursive: true });
      }
    },
  };
}

/** Probe a fresh Agent before deciding its mode; never treat an unavailable backend as a sandboxed run. */
export function probeLocalSandbox(
  project: string,
  folder: string,
  native?: NativePayloadStaging,
): SandboxUnavailableReason | undefined {
  try {
    const controls = createLocalSandboxControls({
      project,
      folder,
      mode: () => "workspace",
      native,
    });
    controls.close();
    return undefined;
  } catch (cause) {
    if (cause instanceof LocalSandboxUnavailable) return cause.reason;
    throw cause;
  }
}
