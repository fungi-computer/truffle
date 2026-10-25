import { rmSync } from "node:fs";
import {
  localLinuxSandboxPayload,
  verifiedNativePatchHelper,
  LocalBwrapUnavailable,
  type NativeSourceReader,
} from "./private-local-bwrap.js";
import {
  privateNativeDirectory,
  stageNativeBytes,
  UnsafeNativePayload,
  type LocalSandboxPolicy,
  type NativeRunLivenessProbe,
} from "./private-local-sandbox-policy.js";

/**
 * One invocation owner for pinned native bytes. Verify the installed source on
 * every admission, but execute/bind only the first private copy of those
 * verified bytes. The built digest pins each label to a single payload.
 */
export function createNativePayloadStaging(
  project: string,
  readNativePatchSource?: NativeSourceReader,
  probeNativeRunLiveness?: NativeRunLivenessProbe,
) {
  let directory: string | undefined;
  let closed = false;
  const staged = new Map<string, string>();
  const stage = (label: string, bytes: Uint8Array): string => {
    if (closed) throw new Error("Native staging owner is closed");
    const existing = staged.get(label);
    if (existing !== undefined) return existing;
    try {
      directory ??= privateNativeDirectory(project, probeNativeRunLiveness);
      const path = stageNativeBytes(directory, label, bytes);
      staged.set(label, path);
      return path;
    } catch (cause) {
      if (cause instanceof UnsafeNativePayload) throw cause;
      throw new LocalBwrapUnavailable(
        "staging-failed",
        `Cannot stage verified ${label} in a private native directory; no command was started.`,
        { cause },
      );
    }
  };
  return {
    patch: (path: string) =>
      stage(
        "fungi-apply-patch",
        verifiedNativePatchHelper(path, project, readNativePatchSource),
      ),
    linux: (policy: LocalSandboxPolicy) => {
      const payload = localLinuxSandboxPayload(policy);
      return {
        executable: stage("fungi-bwrap", payload.executableBytes),
        seccompFilter: payload.seccompFilter,
      };
    },
    probeFilter: (bytes: Uint8Array) => stage("fungi-seccomp.bpf", bytes),
    close: () => {
      if (closed) return;
      closed = true;
      if (directory !== undefined) rmSync(directory, { recursive: true });
    },
  };
}

export type NativePayloadStaging = ReturnType<
  typeof createNativePayloadStaging
>;
