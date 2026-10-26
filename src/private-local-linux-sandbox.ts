import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  protectedSandboxPaths,
  type LinuxSandboxProfile,
} from "./private-local-sandbox-policy.js";

/** Ordinary upstream bwrap argv. There is no approval or bare-command path. */
export function linuxSandboxCommand(
  policy: LinuxSandboxProfile,
  payload: Readonly<{ executable: string; seccompFilter: Uint8Array }>,
  cwd: string,
  argv: readonly [string, ...string[]],
  host: NodeJS.ProcessEnv = process.env,
  readOnlyHelperFile?: string,
) {
  const root = policy.writableRoot;
  // Bind sources must exist. Only the trusted host prepares the reserved paths.
  mkdirSync(join(root, ".fungi"), { recursive: true });
  // A missing carve-out would be skipped by the existing-path ro-bind loop,
  // allowing Workspace to seed self-attested native-patch cache receipts.
  if (policy.fungiCache !== undefined)
    mkdirSync(policy.fungiCache, { recursive: true, mode: 0o700 });
  const args = [
    ...(policy.mode === "read-only"
      ? ["--unshare-all"]
      : [
          "--unshare-user",
          "--unshare-pid",
          "--unshare-ipc",
          "--unshare-uts",
          "--unshare-cgroup-try",
        ]),
    "--die-with-parent",
    "--new-session",
    "--seccomp",
    "3",
    "--ro-bind",
    "/",
    "/",
    // Private system mounts precede the folder bind so /tmp projects survive.
    "--bind",
    policy.temporaryDirectory,
    "/tmp",
    "--tmpfs",
    "/run",
    ...(existsSync("/var/run") && realpathSync("/var/run") !== "/run"
      ? ["--tmpfs", realpathSync("/var/run")]
      : []),
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];
  // A selected folder under /tmp disappears behind the private /tmp bind.
  // Restore it read-only for Read-only; Workspace will bind it writable below.
  if (policy.mode === "read-only") args.push("--ro-bind", root, root);
  // System masks precede every writable grant. Git is rebound read-only after.
  for (const path of policy.writable) args.push("--bind", path, path);
  // External Git metadata is never a writable grant. Missing paths do not
  // become host-side bwrap mountpoints.
  if (policy.mode === "workspace")
    for (const path of protectedSandboxPaths(policy.readOnly))
      if (existsSync(path)) args.push("--ro-bind", path, path);
  const runtime = host.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime) && existsSync(runtime))
    args.push("--tmpfs", realpathSync(runtime));
  // systemd's /etc/resolv.conf is often a symlink into the masked /run tree.
  // Restore only its target file in networked Workspace, never the resolver's
  // runtime directory or user bus.
  if (policy.mode === "workspace" && existsSync("/etc/resolv.conf")) {
    const resolver = realpathSync("/etc/resolv.conf");
    if (resolver.startsWith("/run/"))
      args.push("--ro-bind", resolver, resolver);
  }
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
  for (const path of policy.hidden) {
    // Host /tmp is already replaced. An external fixture HOME beneath it has
    // no mountpoint in the guest; restoring it would reveal host data.
    const underTmp = relative("/tmp", path);
    const underRoot = relative(root, path);
    if (
      underTmp !== ".." &&
      !underTmp.startsWith(`..${sep}`) &&
      (underRoot === ".." || underRoot.startsWith(`..${sep}`))
    )
      continue;
    // Absent records cannot be read; never create a user's credential paths.
    if (existsSync(path) && statSync(path).isDirectory())
      args.push("--tmpfs", path);
  }
  if (policy.sshAgentSocket !== undefined)
    args.push("--bind", policy.sshAgentSocket, policy.sshAgentSocket);
  if (policy.sshAgentMask !== undefined)
    args.push("--ro-bind", "/dev/null", policy.sshAgentMask);
  // Native Files passes its resolved helper, never an untrusted exec argv[0].
  // Re-expose only that file after private mounts; its siblings stay hidden.
  if (readOnlyHelperFile !== undefined) {
    if (!statSync(readOnlyHelperFile).isFile())
      throw new Error("Local native helper must be a regular file");
    args.push("--ro-bind", readOnlyHelperFile, readOnlyHelperFile);
  }
  // R is a bind mount: let sandboxed Git reads discover a parent repository
  // when the selected folder has no .git of its own.
  args.push("--setenv", "GIT_DISCOVERY_ACROSS_FILESYSTEM", "1");
  args.push("--setenv", "FUNGI_SANDBOX", policy.mode);
  if (policy.mode === "read-only")
    args.push("--setenv", "FUNGI_SANDBOX_NETWORK_DISABLED", "1");
  args.push("--chdir", cwd, "--", ...argv);
  return { ...payload, args };
}
