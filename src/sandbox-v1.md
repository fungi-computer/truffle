# Local sandbox v1: useful limits, not a hostile-program security boundary

The user-facing description, including the one-time TUI notice, is:

> Limits what the agent's commands can change to your project folder and blocks
> their network access. They can still read other files on this computer, and
> this is not a security boundary against a hostile program.

CTO `3fd830860044` records this deliberate v1 scope. Do not claim
hostile-program isolation for a backend or Agent, or describe a successful
startup probe as security qualification.

## What the adapter does

On Linux, `linuxSandboxCommand` retains the read-only host `/` bind, writes to
the selected folder, protected `.fungi`/Git hooks/config, network namespaces,
private `/tmp` and `/run`, and known host socket masks. Git protection is
recomputed before each command: every discovered Git directory under the folder,
including nested repositories, submodule metadata and worktrees, has its hooks,
config, config.worktree and commondir protected. A writable `commondir` would
redirect host Git to an Agent-built common directory and its config and hooks.
Where `commondir` is absent, the trusted host first writes a `.` placeholder,
which names the Git directory itself exactly as absence does; Git rejects an
empty `commondir`, so the usual empty bind source cannot be used. A Git
directory whose read-only `commondir` names another directory (a linked worktree
record) has only `config.worktree` and `commondir` protected: Git reads hooks
and config from the common directory, and skipping inert copies keeps bwrap's
9,000-argument cap within reach of repositories with many worktrees. Logical
reserved names and their resolved targets are protected by the same policy for
Files, bwrap and Seatbelt. Git pointer files do not grant writes to external Git
directories.

**Discovery follows Git.** Inside a work tree, the host's Git names what to
protect: `rev-parse` gives its administration, `ls-files --stage` its gitlinks
and tracked `HEAD` files, `ls-files --others --exclude-standard` its untracked
nested repositories and files, and `worktree list` its registered worktrees,
including those inside ignored directories. The work tree's payload is never
walked, so per-command cost no longer grows with dependency stores or generated
trees. Each reported nested repository with a `.git` directory is asked the same
way; a `.git` file or symlink is protected read-only and not followed. Outside
any work tree, or when Git cannot answer (absent, too old, a dubious-ownership
refusal, a timeout, an unparsable record or a name that is not UTF-8), discovery
falls back to the complete walk of real directories (including hidden ones,
never directory symlinks) for that directory. Git administration itself is
always walked completely and never pruned.

Git runs only from an absolute PATH entry outside the project and Git
administration, with `GIT_*` variables removed, `core.fsmonitor=false`,
`core.untrackedCache=false`, no pager and no optional index locks, because the
repository's configuration and index may be Agent-authored. Every Git-reported
path is data: it must be a real directory inside the folder, reached without a
symlink, before it is protected or bound.

**Discovery budget choice (Opus Y4, option b):** count discovered directories,
not regular files, with a 100,000-directory ceiling including the writable root,
and at most 256 Git work trees (four Git processes each). Exceeding either
ceiling or any incomplete walk still refuses without a partial policy or bare
retry. **Nested Git-file checkouts are repository boundaries:** a nested
non-administration directory containing a regular `.git` file has that pointer
protected read-only, but its checkout payload is not descended into. The file is
not parsed.

**Coverage given up for bounded cost (ignored payload).** Git does not list
ignored content, so an independent repository inside an ignored directory (for
example a clone under an ignored tool directory, or a Cargo Git checkout inside
an ignored `CARGO_HOME`) gets no additional hooks/config protection. Registered
worktrees, submodules and the work tree's own administration are still found
there through Git. Ignored payload is tool-owned content the folder already lets
a command rewrite (dependency code, build inputs), which the owning tools
execute; its Git metadata is not a stronger boundary than that content. This is
a deliberate trade-off, not a dependency-name carve-out.

Repositories created during a command are covered on the next command, not
retroactively. A command that creates a repository writes its hooks and config
in the same command, so per-command recomputation protects pre-existing and
host-created repositories, not Agent-created ones. Independent nested
repositories not administered under the folder's own `.git` remain best-effort
and defeatable on the next command: a command can add an ignore rule, drop a
gitlink from the index, rewrite a worktree record, or create a Git-file boundary
above them, all without a race. The folder's own administration, its module
metadata and its worktree records stay protected regardless. Object, index and
ref writes remain allowed. This is consistent with the "not a security boundary
against a hostile program" notice.

It passes the already compiled maintained libseccomp filter to bwrap. That
filter denies `socket(AF_UNIX, …)` and AF_VSOCK creation and the three
`io_uring` syscalls. It does **not** deny `socketpair`. Files remain readable
outside the folder: this is not a secrets-hiding feature. These network
restrictions apply to sandboxed commands, not the Agent's web, connector or
delegation tools.

On macOS, the retained Seatbelt profile is deny-default and adds no network or
Unix-socket allowance; see
[the source-level Unix-socket check](seatbelt/README.md). A Linux run is not
evidence of macOS enforcement.

Approval policy is independent and is not a sandbox gate. This bundle neither
imports `@fungi.computer/approvals` nor calls `selectAutoApprove`; it does not
wait for that package to land. The host attempts sandboxing automatically
whenever available. Unavailability produces a typed status and one visible
notice per Agent/session, with unsandboxed fallback unless the person explicitly
sets the sandbox's own persisted `requireSandbox` setting. Requiring the v1
sandbox does not upgrade its security guarantee.

When `requireSandbox` refuses Local selection, the service returns HTTP 409 with
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
   been ready, so the failed probe is `startup-refused` and optional commands
   can fall back to bare execution for that service lifetime while the layout
   persists. If the owner was already ready, an oversized command fails with
   `E2BIG` without a bare retry. This is not a regression in spore-v1-03; the
   100,000-directory discovery ceiling does not bound argv bytes. Tracked
   separately as
   [spore-v1-06](../../../issues/spore-v1/06-refuse-agent-shaped-startup-probe-failure.md).
5. **Absent native package with the host install inside the project.** The
   packaged host-code check now refuses the bin wrapper and CLI entry inside the
   current Agent project before the native-package lookup. An intact checker
   also refuses hardlinked entry JS, even if the other link is not visible from
   the current project. It recommends a copying install outside the project. A
   missing optional native package therefore cannot produce a bare fallback from
   that known host-code layout.
6. **Host code already modified, or another project's Agent root.** The
   in-process check cannot protect its own JS against a rewrite that happened
   before it ran (including a prior unsandboxed command), and it knows only the
   current project's Agent authority. Another project's Agent may cover an
   otherwise safe-looking installation or the private native staging root. The
   link-count test conservatively rejects hardlinked host JS, not arbitrary
   outside-project writable aliases or a same-user attacker. Neither a
   successful check nor native digests prove pre-compromise integrity. PID-only
   native-run liveness can still retain stale runs after PID reuse; sweep
   failure remains independent of admission.
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
