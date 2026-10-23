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
config and config.worktree protected. Logical reserved names and their resolved
targets are protected by the same policy for Files, bwrap and Seatbelt. Git
pointer files do not grant writes to external Git directories. With a stable
tree, discovery walks real directories (including hidden ones), not directory
symlinks.

**Discovery budget choice (Opus Y4, option b):** count discovered directories,
not regular files, with a 100,000-directory ceiling including the writable root.
Ordinary dependency payloads above 100,000 files must not prevent Agent
admission or command launch. Discovery does not exclude dependency directories
by name. **Nested Git-file checkouts are repository boundaries:** a nested
non-administration directory containing a regular `.git` file has that pointer
protected read-only, but its checkout payload is not descended into. The file is
not parsed. This includes linked worktree and submodule checkouts, so tool-owned
worktrees under `.claude` or `.botanical` do not multiply discovery work. The
selected writable root and recognized Git administration are still scanned.
Common hooks/config, module metadata and worktree records reached by the root
scan remain protected; outside-root administration gets no write grant.
Exceeding the directory ceiling or any incomplete scan still refuses without a
partial policy or bare retry. Discovery still synchronously enumerates the tree
per command; this changes the admission budget, not the traversal-cost
guarantee.

Repositories created during a command are covered on the next command, not
retroactively. **Coverage given up at the checkout boundary:** independent
nested repositories or other Git metadata inside a pruned checkout payload are
not discovered or given additional hooks/config protection. This is a
repository-boundary limit, not a dependency-name carve-out. Object, index and
ref writes remain allowed. A contained command can itself create this boundary
without a race, making hooks/config protection for independent nested
repositories not administered under the root `.git` best-effort and defeatable
on the next command, consistent with the "not a security boundary against a
hostile program" notice.

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

Known-path masking is a stopgap, not a complete host-socket inventory. A hostile
program can exploit IPC outside the named masks, and host-root reads remain
available. Neither the successful folder/Git/network probes nor digest checks
establish a stronger guarantee.

The filesystem allowlist, private HOME and socket-file walk proposal is
[parked](../../../issues/yolo-v1/11-parked-host-filesystem-allowlist.md). The
masked datagram-socketpair rule was withdrawn with it. Do not silently restore
either as a prerequisite for v1.
