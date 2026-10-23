import { spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import {
  protectedSandboxPaths,
  type LocalSandboxPolicy,
} from "./private-local-sandbox-policy.js";

const sandboxExecutable = "/usr/bin/sandbox-exec";

/**
 * The containment owner supplies temporary-directory lifetime and command-time
 * protected paths; this adapter owns only the maintained Seatbelt translation.
 */
export type SeatbeltPolicy = LocalSandboxPolicy &
  Readonly<{
    temporaryDirectory: string;
  }>;

/**
 * Paths are argv definitions, never SBPL source. Both the logical name and its
 * resolved target are protected, including when a protected entry is a symlink.
 */
export function seatbeltCommand(
  policy: SeatbeltPolicy,
  argv: readonly [string, ...string[]],
) {
  const definitions: string[] = [];
  const parameter = (name: string, path: string) => {
    definitions.push("-D", `${name}=${path}`);
    return `(param "${name}")`;
  };
  const excluded = protectedSandboxPaths(policy.readOnly);
  const carveouts = excluded.flatMap((path, index) => {
    const value = parameter(`PROTECTED_${String(index)}`, path);
    return [
      `(require-not (literal ${value}))`,
      `(require-not (subpath ${value}))`,
    ];
  });
  const roots = [policy.writableRoot, policy.temporaryDirectory];
  const grants = roots.map((path, index) => {
    const value = parameter(
      `WRITABLE_ROOT_${String(index)}`,
      realpathSync(path),
    );
    return `(require-all (subpath ${value}) ${carveouts.join(" ")})`;
  });
  const anchors = [
    ...new Set([
      ...roots.map((path) => realpathSync(path)),
      ...protectedSandboxPaths(policy.immovable),
    ]),
  ].map((path, index) => {
    const value = parameter(`ANCHOR_${String(index)}`, path);
    return `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal ${value})))`;
  });
  const base = readFileSync(
    new URL("./seatbelt/safe-base.sbpl", import.meta.url),
    "utf8",
  );
  const profile = [
    base,
    "(allow file-read*)",
    `(allow file-write* ${grants.join(" ")})`,
    ...anchors,
    "(deny system-fcntl (fcntl-command 80 110))",
  ].join("\n");
  return {
    executable: sandboxExecutable,
    args: ["-p", profile, ...definitions, "--", ...argv],
    temporaryDirectory: realpathSync(policy.temporaryDirectory),
  };
}

/** A real startup probe; failure is data, never permission to execute bare. */
export function seatbeltReadiness(
  policy: SeatbeltPolicy,
): Readonly<{ ready: true }> | Readonly<{ ready: false; reason: string }> {
  const command = seatbeltCommand(policy, ["/usr/bin/true"]);
  const result = spawnSync(command.executable, command.args, {
    env: { TMPDIR: command.temporaryDirectory },
    encoding: "utf8",
    timeout: 5_000,
  });
  const diagnostic = result.error?.message ?? result.stderr.trim();
  return result.status === 0
    ? { ready: true }
    : {
        ready: false,
        reason:
          diagnostic.length > 0
            ? diagnostic
            : `sandbox-exec exited ${String(result.status)} (${String(result.signal)})`,
      };
}
