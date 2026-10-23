import {
  existsSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import {
  protectedSandboxPaths,
  type LocalSandboxPolicy,
} from "./private-local-sandbox-policy.js";
import type { LinuxSandboxPayload } from "./private-local-bwrap.js";

/** Ordinary upstream bwrap argv. There is no approval or bare-command path. */
export function linuxSandboxCommand(
  policy: LocalSandboxPolicy,
  payload: LinuxSandboxPayload,
  cwd: string,
  argv: readonly [string, ...string[]],
  host: NodeJS.ProcessEnv = process.env,
) {
  const root = policy.writableRoot;
  // Bind sources must exist. Only the trusted host prepares the reserved paths.
  mkdirSync(join(root, ".fungi"), { recursive: true });
  for (const git of policy.immovable) {
    mkdirSync(join(git, "hooks"), { recursive: true });
    for (const config of ["config", "config.worktree"])
      if (!existsSync(join(git, config)))
        writeFileSync(join(git, config), "", { flag: "wx" });
  }
  const args = [
    "--unshare-all",
    "--die-with-parent",
    "--new-session",
    "--seccomp",
    "3",
    "--ro-bind",
    "/",
    "/",
    // Private system mounts precede the folder bind so /tmp projects survive.
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--bind",
    root,
    root,
  ];
  for (const path of policy.immovable) args.push("--bind", path, path);
  for (const path of protectedSandboxPaths(policy.readOnly))
    args.push("--ro-bind", path, path);
  if (existsSync("/var/run") && realpathSync("/var/run") !== "/run")
    args.push("--tmpfs", realpathSync("/var/run"));
  const runtime = host.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime) && existsSync(runtime))
    args.push("--tmpfs", realpathSync(runtime));
  // Stopgap masks, not an inventory of all possible host IPC. /run also
  // covers the usual /var/run alias. These follow folder/protected binds so
  // a selected socket inside the project is not exposed again by a later bind.
  // Keep unusual selected SSH-agent paths
  // and Docker Desktop sockets out without masking all of the user's HOME.
  if (host.HOME && isAbsolute(host.HOME)) {
    for (const path of [
      join(host.HOME, ".docker", "run"),
      join(host.HOME, ".docker", "desktop"),
    ])
      if (existsSync(path) && statSync(path).isDirectory())
        args.push("--tmpfs", realpathSync(path));
  }
  const agentSocket = host.SSH_AUTH_SOCK;
  if (
    agentSocket &&
    isAbsolute(agentSocket) &&
    existsSync(agentSocket) &&
    statSync(agentSocket).isSocket()
  )
    args.push("--ro-bind", "/dev/null", realpathSync(agentSocket));
  args.push("--chdir", cwd, "--", ...argv);
  return { ...payload, args };
}
