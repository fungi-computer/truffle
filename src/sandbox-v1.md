# Local sandbox v1: useful limits, not a hostile-program security boundary

The retained v1 sandbox profile is used by both Workspace and Read-only modes in
S1. Its original user-facing description was:

> Limits what the agent's commands can change to your project folder and blocks
> their network access. They can still read other files on this computer, and
> this is not a security boundary against a hostile program.

CTO `3fd830860044` records this deliberate v1 scope. Do not claim
hostile-program isolation for a backend or Agent, or describe a successful
startup probe as security qualification.

## What the adapter does

On Linux, the adapter retains a read-only host /, selected writable folder,
private /tmp and /run, and known socket masks. For an existing R/.git marker,
the whole marker and its Git-reported administration and common directories are
read-only. No writable Git metadata binds or host-created absent markers exist.
A single hardened rev-parse query, with fsmonitor, untracked cache and optional
locks disabled, locates linked worktree administration; malformed or non-UTF-8
answers grant nothing. No nested Git discovery is performed. Agent-created
repositories are an accepted risk when the user runs git in the folder after the
Agent's git init. Git writes in Workspace require the later S5 approval escape
and S6 Always-allow support. Logical and resolved paths share one
Files/bwrap/Seatbelt protection policy.

The native staging owner verifies installed bwrap, both seccomp filters and the
patch helper once, copies their bytes under a private runtime directory, then
serves the copy without rereading the package on each command. It removes its
copy on close; a crash can leave orphaned files, but no other process's files
are swept. Until service startup owns and passes this instance through the
runtime-host handoff, standalone Agent controls own a copy for their lifetime.

It passes the already compiled maintained libseccomp filter to bwrap. The
Read-only filter denies `socket(AF_UNIX, …)` and AF_VSOCK creation and the three
`io_uring` syscalls. It does **not** deny `socketpair`. Files remain readable
outside the folder: this is not a secrets-hiding feature. These network
restrictions apply to sandboxed commands, not the Agent's web, connector or
delegation tools.

On macOS, the retained Seatbelt profile is deny-default and adds no network or
Unix-socket allowance; see
[the source-level Unix-socket check](seatbelt/README.md). A Linux run is not
evidence of macOS enforcement.

Approval policy is independent and is not a sandbox gate. This bundle neither
imports `@fungi.computer/approvals` nor calls `selectAutoApprove`; escapes and
approval are later work. Each Agent stores a permission mode. Full access runs
commands bare and never admits the sandbox (including its host-code check).
Workspace and Read-only admit the retained v1 sandbox profile or refuse with
`LocalSandboxUnavailable`; there is no optional bare fallback or unavailable
notice. A new Agent defaults to Workspace if the sandbox probe passes, otherwise
Full access. An explicitly selected sandboxed mode is refused before its mode is
persisted if admission fails. The TUI shows the mode label; a footer reason
belongs to the later permissions UI slice.

When a sandboxed mode refuses Local selection, the service returns HTTP 409 with
`{ code: "sandbox_unavailable", reason }`. The SDK decodes the maintained reason
schema and reconstructs `LocalSandboxUnavailable`, retaining its typed reason
rather than treating the refusal as an internal service error.

## Recorded escape limits

These observed escapes and source-traced limits are recorded **v1 caveats, not
failing v1 gates**:

1. **Pathname Unix sockets before the filter.** With namespaces and read-only
   host mounts alone, a controlled host stream listener at `project/host.sock`
   was reachable as `../host.sock`. The proof failed with
   `Error: Sandbox reached the controlled host socket`. The original receipt is
   `.botanical/receipts/yolo/kernel-pathname-socket-red.log` in the bundle
   worktree. This disproves the assumption that read-only mounts plus network
   namespaces isolate all host IPC. The current socket-creation filter blocks
   that ordinary connection path, not every way to obtain a Unix endpoint.
2. **Datagram socketpair with the compiled filter.** On the same real Linux
   backend with AF_UNIX socket creation denied, a child made
   `socketpair(AF_UNIX, SOCK_DGRAM)`, then used one endpoint to
   `sendto(b"escape", "../host-dgram.sock")`. The owned host listener received
   `b'escape'`; child status was zero and `bytes sent via socketpair: 6`. The
   original receipt is
   `.botanical/receipts/yolo/socketpair-datagram-escape.log`. The socketpair was
   created after exec, so closing inherited descriptors does not fix this path.
3. **Discovery-to-bind pathname race (Opus Y3; accepted v1 limit).** This is a
   source trace, not an executed kernel escape proof. The policy discovers real
   Git directories, but `linuxSandboxCommand` prepares reserved hooks/config
   names and binds Git directories read-write by pathname. A concurrent
   same-user process, including a contained background command, can swap a
   discovered directory for a symlink after discovery. Trusted preparation or
   bwrap's source-path resolution can then follow it outside the folder,
   including a read-write host-directory bind. Nested Git discovery widens the
   affected names beyond the top-level `.git`. Logical/resolved path protection
   fixes stable aliases, not this identity race. V1 accepts this under the
   hostile-program caveat rather than introducing directory-FD ownership,
   `--bind-fd` / `--ro-bind-fd`, or FD-relative host preparation. No
   race-hardening or stronger isolation is claimed.
4. **Agent-shaped startup-probe failure on a later service start.** Opus
   reported that roughly 1,500 long-named nested `.git` directories in the
   Agent's writable folder make Git protection expand bwrap's argv until Node's
   startup `spawnSync` reports `E2BIG`. The next service's controls have never
   been ready, so the failed probe is `startup-refused`: Workspace and Read-only
   refuse Local selection rather than starting bare commands. If the owner was
   already ready, an oversized command fails with `E2BIG` without a bare retry.
   This is not a regression in spore-v1-03; the 100,000-directory discovery
   ceiling does not bound argv bytes. Tracked separately as
   [spore-v1-06](../../../issues/spore-v1/06-refuse-agent-shaped-startup-probe-failure.md).
5. **Absent native package with the host install inside the project.** The
   packaged host-code check now refuses the bin wrapper and CLI entry inside the
   current Agent project before the native-package lookup. An intact checker
   also refuses hardlinked entry JS, even if the other link is not visible from
   the current project. It recommends a copying install outside the project. A
   missing native package cannot authorize a bare fallback in either sandboxed
   mode. Full access skips this host-code check and does not admit the sandbox.
6. **Host code already modified, or another project's Agent root.** The
   in-process check cannot protect its own JS against a rewrite that happened
   before it ran (including a prior Full access command), and it knows only the
   current project's Agent authority. Another project's Agent may cover an
   otherwise safe-looking installation or the private native staging root. The
   link-count test conservatively rejects hardlinked host JS, not arbitrary
   outside-project writable aliases or a same-user attacker. Neither a
   successful check nor native digests prove pre-compromise integrity. Native
   staging deletes only its own copy on close; orphaned copies after a crash
   require separate operator cleanup, not a PID-based startup sweep.
7. **Bun's cwd autoload is host code authority, not Agent data.** The Node bin
   wrapper and the embedded Bun child in the compiled launcher now pass
   `--config=/dev/null --no-env-file`; the compiled launcher itself is built
   with Bun's `--no-compile-autoload-bunfig` and `--no-compile-autoload-dotenv`.
   A detached Bun service uses the same runtime switches. Thus an Agent-authored
   project `bunfig.toml` preload and project `.env` are not loaded into those
   host processes on the next launch. `FUNGI_*` values from a real inherited
   process environment remain supported; values supplied only by the project's
   `.env` are not. Source-tree runs in their own Agent project are refused by
   the existing host-code admission check; there is no maintainer opt-out while
   Levi decides. The maintained source `start` command also disables Bun
   autoload. A direct manual `bun dist/cli.js` bypassing these launchers is not
   protected; source invokers must supply the same Bun flags.
8. **Host-install aliases and link-check scope.** Only the CLI entry JS and bin
   wrapper have their inode link counts checked. `miniflare`, `@opentui/core`,
   `@opencode-ai/pty`, the `@oven/bun` runtime binary, `dist/internal/*.mjs` and
   `dist/internal/*.cjs`, and `dist/seatbelt/safe-base.sbpl` rely on the package
   manager installing a whole package uniformly, not individual hardlinked
   dependency files mixed with a copied CLI. That assumption does not prove an
   arbitrary mixed or hand-assembled installation safe. Bind mounts or alias
   mounts inside the Agent project pointing to an outside installation are
   invisible to the logical/realpath and link-count check. Case-insensitive path
   comparison on macOS is untested here, as with the native-source location
   check.

Known-path masking is a stopgap, not a complete host-socket inventory. A hostile
program can exploit IPC outside the named masks, and host-root reads remain
available. Neither the successful folder/Git/network probes nor digest checks
establish a stronger guarantee.

The filesystem allowlist, private HOME and socket-file walk proposal is
[parked](../../../issues/yolo-v1/11-parked-host-filesystem-allowlist.md). The
masked datagram-socketpair rule was withdrawn with it. Do not silently restore
either as a prerequisite for v1.
