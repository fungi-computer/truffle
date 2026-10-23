# Local sandbox v1: observation versus qualification

Limits what the agent's commands can change to your project folder and blocks
their network access. They can still read other files on this computer, and this
is not a security boundary against a hostile program.

The default `local-sandbox-proof.mts` exercises the current packaged wrapper and
its original maintained seccomp filter with an explicit child filter descriptor.
It is a focused kernel smoke test, **not** the foreground/background Local
caller, recovery, cancellation or lifecycle qualification.

## Run the Linux qualification

From the repository root, build the ordinary Local prerequisites, then invoke
its named proof command:

```sh
pnpm turbo:run run build --filter=@fungi.computer/truffle
pnpm --filter @fungi.computer/truffle run test:sandbox:linux
pnpm --filter @fungi.computer/truffle run test:sandbox:linux --tmp-project --pathname-socket
```

This is an explicit Linux qualification, not an automatic batch unit. The driver
launches `local-sandbox-probe.mts` with its owned folder, outside sentinel,
HOME, runtime socket and TCP port. That child is not a standalone proof command.
To falsify the same assertions without containment, run:

```sh
pnpm --filter @fungi.computer/truffle run test:sandbox:linux --uncontained-control
```

The bare control must exit nonzero; it is not a passing sandbox result.

`--tmp-project` repeats the same assertions with a project under `/tmp`. Private
system mounts must precede the writable folder bind; otherwise the wrapper hides
that project from itself. Host sentinels stay outside private `/tmp`, preserving
the exact refusal assertions rather than accepting a missing path.

## Recorded observations, not failing v1 gates

The scope cut recorded in [the v1 contract](../../src/sandbox-v1.md) retains
these two observations as known limits:

- `kernel-pathname-socket-red.log` predates the filter. A read-only host-root
  view plus namespaces allowed a child to reach a controlled host pathname
  socket using `../host.sock`. The current filter's `socket()` denial blocks the
  ordinary Node client used in that probe; this does not remove every pathname
  IPC path.
- `socketpair-datagram-escape.log` uses the original filter. An allowed
  `socketpair(AF_UNIX, SOCK_DGRAM)` endpoint sent six bytes with `sendto()` to a
  controlled host pathname socket. The host received `b'escape'`.

Those logs live in the bundle worktree's ignored `.botanical/receipts/yolo/`
directory. They are observations, not a command that qualification should turn
green or an assertion that v1 protects against a hostile executable.

`--pathname-socket` on the current smoke test adds the ordinary Node pathname
client to the filter checks; it does **not** re-create the pre-filter recipe.
`--uncontained-control` runs the ordinary write assertions without any wrapper
and must fail. A missing/refused backend also fails the smoke test; it must not
be reported as a passed sandbox.

The filesystem allowlist and any additional syscall rule remain separately
[parked](../../../../issues/yolo-v1/11-parked-host-filesystem-allowlist.md).
