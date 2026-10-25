import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { nativeDigests } from "./private-local-native-digests.js";
import {
  assertHostOwnedNativeFile,
  UnsafeNativePayload,
  type LocalSandboxPolicy,
} from "./private-local-sandbox-policy.js";

export class LocalBwrapUnavailable extends Error {
  override readonly name = "LocalBwrapUnavailable";
  constructor(
    readonly reason:
      | "missing"
      | "missing-artifact"
      | "invalid-digest"
      | "digest-mismatch"
      | "unreadable"
      | "not-executable"
      | "staging-failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type LinuxSandboxPayload = {
  readonly executableBytes: Uint8Array;
  readonly seccompFilter: Uint8Array;
};

export type LinuxSandboxDigests = Readonly<{
  bwrap: string;
  seccomp: string;
}>;

/** Packaged patch has no sidecar; the built module owns its digest. */
export type NativeSourceReader = (path: string) => Buffer;

export function verifiedNativePatchHelper(
  path: string,
  project: string,
  readNativeSource: NativeSourceReader = readFileSync,
): Uint8Array {
  const expected = nativeDigests[`${process.platform}-${process.arch}`]?.patch;
  if (expected === undefined)
    throw new LocalBwrapUnavailable(
      "invalid-digest",
      "No built native patch digest for this platform; reinstall Fungi.",
    );
  return verifiedBytes(
    path,
    "fungi-apply-patch",
    project,
    expected,
    readNativeSource,
  );
}

/** Check both packaged artifacts on every use; never cache verification. */
export function verifyLocalLinuxSandboxPayload(
  executable: string,
  policy: LocalSandboxPolicy,
  expected: LinuxSandboxDigests,
): LinuxSandboxPayload {
  const executableBytes = verifiedBytes(
    executable,
    "fungi-bwrap",
    policy.projectRoot,
    expected.bwrap,
  );
  return {
    executableBytes,
    seccompFilter: verifiedBytes(
      join(dirname(executable), "fungi-seccomp.bpf"),
      "fungi-seccomp.bpf",
      policy.projectRoot,
      expected.seccomp,
    ),
  };
}

function verifiedBytes(
  path: string,
  label: string,
  project: string,
  expected: string,
  readNativeSource: NativeSourceReader = readFileSync,
): Uint8Array {
  let bytes: Buffer;
  try {
    assertHostOwnedNativeFile(project, path);
    if (!statSync(path).isFile())
      throw new LocalBwrapUnavailable(
        "not-executable",
        `Packaged ${label} is not a regular file; reinstall Fungi.`,
      );
    bytes = readNativeSource(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      throw new LocalBwrapUnavailable(
        "missing-artifact",
        `Packaged ${label} is missing; reinstall Fungi with optional dependencies enabled.`,
        { cause },
      );
    if (
      cause instanceof UnsafeNativePayload ||
      cause instanceof LocalBwrapUnavailable
    )
      throw cause;
    throw new LocalBwrapUnavailable(
      "unreadable",
      `Packaged ${label} cannot be read; reinstall Fungi. No command was started.`,
      { cause },
    );
  }
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new LocalBwrapUnavailable(
      "digest-mismatch",
      `Packaged ${label} digest mismatch; reinstall Fungi. No command was started.`,
    );
  return bytes;
}

/** Same optional native-package lookup as apply_patch, with no PATH fallback. */
export function localLinuxSandboxPayload(
  policy: LocalSandboxPolicy,
): LinuxSandboxPayload {
  const digest = nativeDigests[`${process.platform}-${process.arch}`];
  if (digest?.bwrap === undefined || digest.seccomp === undefined)
    throw new LocalBwrapUnavailable(
      "invalid-digest",
      "No built native Linux payload digest for this platform; reinstall Fungi.",
    );
  let executable: string;
  if (process.env.FUNGI_BUNDLED_CLI) {
    const name = `@fungi.computer/spore-native-${process.platform}-${process.arch}`;
    const message = `Packaged ${name}/bin/fungi-bwrap cannot be read; reinstall Fungi.`;
    let directories: string[] | null;
    try {
      directories = createRequire(process.env.FUNGI_BUNDLED_CLI).resolve.paths(
        name,
      );
    } catch (cause) {
      throw new LocalBwrapUnavailable("missing-artifact", message, { cause });
    }
    if (directories === null)
      throw new LocalBwrapUnavailable("missing-artifact", message);
    let packageRoot: string | undefined;
    for (const directory of directories) {
      const candidate = join(directory, name);
      try {
        if (lstatSync(candidate, { throwIfNoEntry: false }) !== undefined) {
          packageRoot = candidate;
          break;
        }
      } catch (cause) {
        throw new LocalBwrapUnavailable("missing-artifact", message, { cause });
      }
    }
    if (packageRoot === undefined)
      throw new LocalBwrapUnavailable(
        "missing",
        `Missing ${name}; reinstall Fungi with optional dependencies enabled.`,
      );
    // Package metadata (including exports) is not an authority for whether
    // native bytes are absent. Check the package's location before its bin.
    try {
      assertHostOwnedNativeFile(policy.projectRoot, packageRoot);
      if (!statSync(packageRoot).isDirectory())
        throw new LocalBwrapUnavailable("missing-artifact", message);
    } catch (cause) {
      if (
        cause instanceof UnsafeNativePayload ||
        cause instanceof LocalBwrapUnavailable
      )
        throw cause;
      throw new LocalBwrapUnavailable("missing-artifact", message, { cause });
    }
    executable = join(packageRoot, "bin", "fungi-bwrap");
  } else {
    executable = fileURLToPath(
      new URL("../native/bin/fungi-bwrap", import.meta.url),
    );
  }
  return verifyLocalLinuxSandboxPayload(executable, policy, {
    bwrap: digest.bwrap,
    seccomp: digest.seccomp,
  });
}
