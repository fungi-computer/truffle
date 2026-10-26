import { readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";
import {
  protectedSandboxPaths,
  type LinuxSandboxProfile,
} from "./private-local-sandbox-policy.js";

const sandboxExecutable = "/usr/bin/sandbox-exec";

export class UnsafeSeatbeltFolder extends Error {
  override readonly name = "UnsafeSeatbeltFolder";
}

/**
 * Containment supplies the single command-time profile (including HOME-based
 * hidden paths). macOS intentionally grants neither Linux caches nor ssh-agent.
 */
export type SeatbeltPolicy = Pick<
  LinuxSandboxProfile,
  | "mode"
  | "writableRoot"
  | "readOnly"
  | "hidden"
  | "temporaryDirectory"
  | "fungiCache"
>;

function covers(root: string, path: string): boolean {
  const remainder = relative(root, path);
  return (
    !isAbsolute(remainder) &&
    remainder !== ".." &&
    !remainder.startsWith(`..${sep}`)
  );
}

/**
 * Paths are argv definitions, never SBPL source. Both the logical name and its
 * resolved target are protected, including when a protected entry is a symlink.
 */
export function seatbeltCommand(
  policy: SeatbeltPolicy,
  argv: readonly [string, ...string[]],
) {
  const hidden = protectedSandboxPaths(policy.hidden);
  const roots =
    policy.mode === "workspace"
      ? [policy.writableRoot, policy.temporaryDirectory]
      : [policy.temporaryDirectory];
  // Denying writes on the hidden directory alone cannot prevent renaming its
  // parent into a writable root, then reading its credentials at the new path.
  if (
    roots.some((root) =>
      hidden.some((path) => covers(root, dirname(path)) || covers(path, root)),
    )
  )
    throw new UnsafeSeatbeltFolder(
      "Seatbelt writable folder or temp contains a Fungi hidden record or its parent.",
    );
  const definitions: string[] = [];
  const parameter = (name: string, path: string) => {
    definitions.push("-D", `${name}=${path}`);
    return `(param "${name}")`;
  };
  const hiddenRules = hidden.flatMap((path, index) => {
    const value = parameter(`HIDDEN_${String(index)}`, path);
    return [
      `(deny file-read* (literal ${value}))`,
      `(deny file-read* (subpath ${value}))`,
    ];
  });
  const hiddenWriteRules = hidden.flatMap((_, index) => {
    const value = `(param "HIDDEN_${String(index)}")`;
    return [
      `(deny file-write* (literal ${value}))`,
      `(deny file-write* (subpath ${value}))`,
    ];
  });
  const excluded = protectedSandboxPaths(policy.readOnly);
  const carveouts = excluded.map((path, index) => {
    const value = parameter(`PROTECTED_${String(index)}`, path);
    return {
      path,
      rules: [
        `(require-not (literal ${value}))`,
        `(require-not (subpath ${value}))`,
      ],
    };
  });
  const ownTemp = realpathSync(policy.temporaryDirectory);
  // Workspace's cache carve-out protects native receipts under a writable
  // cache parent. It must not cancel the narrower grant for our own temp.
  const cachePaths =
    policy.fungiCache !== undefined && covers(policy.fungiCache, ownTemp)
      ? new Set(protectedSandboxPaths([policy.fungiCache]))
      : undefined;
  const grants = roots.map((path, index) => {
    const value = parameter(
      `WRITABLE_ROOT_${String(index)}`,
      realpathSync(path),
    );
    const protectedRules = carveouts
      .filter(
        ({ path }) =>
          !(
            policy.mode === "workspace" &&
            index === 1 &&
            cachePaths?.has(path)
          ),
      )
      .flatMap(({ rules }) => rules);
    return `(require-all (subpath ${value}) ${protectedRules.join(" ")})`;
  });
  const anchors = [...new Set(roots.map((path) => realpathSync(path)))].map(
    (path, index) => {
      const value = parameter(`ANCHOR_${String(index)}`, path);
      return `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (literal ${value})))`;
    },
  );
  const base = readFileSync(
    new URL("./seatbelt/safe-base.sbpl", import.meta.url),
    "utf8",
  );
  const profile = [
    base,
    "(allow file-read*)",
    ...hiddenRules,
    `(allow file-write* ${grants.join(" ")})`,
    ...hiddenWriteRules,
    ...anchors,
    "(deny system-fcntl (fcntl-command 80 110))",
  ].join("\n");
  return {
    executable: sandboxExecutable,
    args: ["-p", profile, ...definitions, "--", ...argv],
    temporaryDirectory: realpathSync(policy.temporaryDirectory),
  };
}
