import { createHash } from "node:crypto";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const digestSchema = z
  .string()
  .trim()
  .regex(/^[a-f0-9]{64}$/u);

export class LocalBwrapUnavailable extends Error {
  override readonly name = "LocalBwrapUnavailable";
  constructor(
    readonly reason:
      "missing" | "invalid-digest" | "digest-mismatch" | "not-executable",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type LinuxSandboxPayload = {
  readonly executable: string;
  readonly seccompFilter: Uint8Array;
};

/** Check both packaged artifacts on every use; never cache verification. */
export function verifyLocalLinuxSandboxPayload(
  executable: string,
): LinuxSandboxPayload {
  verifiedBytes(executable, "fungi-bwrap");
  try {
    accessSync(executable, constants.X_OK);
  } catch (cause) {
    throw new LocalBwrapUnavailable(
      "not-executable",
      "Packaged fungi-bwrap cannot be executed; reinstall Fungi.",
      { cause },
    );
  }
  return {
    executable,
    seccompFilter: verifiedBytes(
      join(dirname(executable), "fungi-seccomp.bpf"),
      "fungi-seccomp.bpf",
    ),
  };
}

function verifiedBytes(path: string, label: string): Uint8Array {
  let bytes: Buffer;
  let digest: string;
  try {
    if (!statSync(path).isFile())
      throw new LocalBwrapUnavailable(
        "not-executable",
        `Packaged ${label} is not a regular file; reinstall Fungi.`,
      );
    bytes = readFileSync(path);
    digest = readFileSync(`${path}.sha256`, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      throw new LocalBwrapUnavailable(
        "missing",
        `Packaged ${label} or its digest is missing; reinstall Fungi with optional dependencies enabled.`,
        { cause },
      );
    throw cause;
  }
  const expected = digestSchema.safeParse(digest);
  if (!expected.success)
    throw new LocalBwrapUnavailable(
      "invalid-digest",
      `Packaged ${label} has an invalid SHA-256 record; reinstall Fungi.`,
    );
  if (createHash("sha256").update(bytes).digest("hex") !== expected.data)
    throw new LocalBwrapUnavailable(
      "digest-mismatch",
      `Packaged ${label} digest mismatch; reinstall Fungi. No command was started.`,
    );
  return bytes;
}

/** Same optional native-package lookup as apply_patch, with no PATH fallback. */
export function localLinuxSandboxPayload(): LinuxSandboxPayload {
  let executable: string;
  if (process.env.FUNGI_BUNDLED_CLI) {
    const name = `@fungi.computer/spore-native-${process.platform}-${process.arch}`;
    try {
      executable = createRequire(process.env.FUNGI_BUNDLED_CLI).resolve(
        `${name}/bin/fungi-bwrap`,
      );
    } catch (cause) {
      throw new LocalBwrapUnavailable(
        "missing",
        `Missing ${name}/bin/fungi-bwrap; reinstall Fungi with optional dependencies enabled.`,
        { cause },
      );
    }
  } else {
    executable = fileURLToPath(
      new URL("../native/bin/fungi-bwrap", import.meta.url),
    );
  }
  return verifyLocalLinuxSandboxPayload(executable);
}
