# Seatbelt Unix-socket boundary

`safe-base.sbpl` is deny-default. `seatbeltCommand` adds file reads, bounded
folder/temporary-directory writes, protected-path exclusions and unlink/fcntl
denials. It adds **no** `system-socket`, `network-bind`, `network-inbound` or
`network-outbound` allowance. File-read/write allowances are not Unix-socket
connection grants.

This matches the maintained implementations inspected for the socket escape
review:

- [OpenAI Codex `rust-v0.162.1`, `seatbelt.rs`](https://github.com/openai/codex/blob/092d3acd6bec3e3a14bdc7e7a2810ab628ab759d/codex-rs/sandboxing/src/seatbelt.rs):
  `unix_socket_policy` explicitly grants
  `(allow system-socket (socket-domain AF_UNIX))` and
  `(allow network-outbound (remote unix-socket …))` only when Unix sockets are
  allowed. An empty restricted allowlist produces no such fragment. The tag
  object is `7a078f6bb4ce0dc2a81408b334ce52979d92c603`; its target commit is
  `092d3acd6bec3e3a14bdc7e7a2810ab628ab759d`.
- [Anthropic sandbox-runtime, `macos-sandbox-utils.ts`](https://github.com/anthropics/sandbox-runtime/blob/38d1aee29c72035f1dba1337ac89b03a2f655d26/src/sandbox/macos-sandbox-utils.ts):
  the Unix IPC section distinguishes socket creation (`system-socket`), bind
  (`network-bind`) and connection (`network-outbound`). With neither a Unix
  allowlist nor allow-all, Unix sockets are blocked by deny-default.

Thus the **generated policy** denies outbound Unix-socket connections, including
Docker/SSH-agent-style paths, rather than relying on filesystem read-only mounts
to stop `connect`. The Linux seccomp/socketpair finding does not establish a
Seatbelt bypass.

This is a source-level finding, **not a macOS enforcement pass**. The Linux host
cannot execute Seatbelt. `scripts/seatbelt-mac-proof.mjs` is the real-adapter
proof: it must run on macOS with an owned scratch directory and throwaway HOME,
and its controlled live Unix listener must accept a bare positive control but
not the sandboxed request. An unavailable platform exits 77, never PASS. Startup
`/usr/bin/true`, static profile assertions and a skipped Mac run do not qualify
the joined Local foreground/background/lifecycle paths.

## Run the macOS qualification

From the repository root on macOS, use the named package command with a short,
canonical, owned scratch path for its Unix socket and a disposable HOME:

```sh
scratch=$(mktemp -d /tmp/fungi-seatbelt.XXXXXX)
scratch=$(cd "$scratch" && pwd -P)
mkdir -p "$scratch/home"
HOME="$scratch/home" pnpm --filter @fungi.computer/truffle run test:sandbox:macos "$scratch"
```

The scratch directory is retained for inspection. This is an explicit platform
qualification, not an automatic batch unit. Running the same package command on
Linux still reports unavailable and exits 77; registration does not turn that
result into an enforcement pass.
