// Selects the pinned Rust toolchain's `cargo` for the native patch build.
//
// The Linux release container and the macOS cross-build's container already
// put rustup's pinned `cargo` proxy first on `PATH`, so those paths keep
// invoking `cargo +<toolchain>` unchanged. A genuinely native host build
// cannot rely on `PATH` order (a non-rustup `cargo`, for example Homebrew's,
// may resolve first and reject the `+toolchain` directive), so it asks
// rustup's ordinary interface for that toolchain's `cargo` explicitly.
import { spawnSync } from "node:child_process";

/**
 * Builds the `{ command, args }` cargo invocation for a native patch build.
 *
 * @param {{ containerized: boolean, toolchain: string, cargoArgs: string[] }} options
 */
export function selectCargoInvocation({ containerized, toolchain, cargoArgs }) {
  return containerized
    ? { command: "cargo", args: [`+${toolchain}`, ...cargoArgs] }
    : { command: "rustup", args: ["run", toolchain, "cargo", ...cargoArgs] };
}

/**
 * Confirms rustup and the pinned toolchain are available on a native host,
 * before starting the real build, so a missing prerequisite fails with one
 * actionable message naming the fix instead of an opaque nested build error.
 *
 * @param {{ toolchain: string }} options
 */
export function ensureNativeHostToolchain({ toolchain }) {
  const probe = spawnSync("rustup", ["run", toolchain, "cargo", "--version"], {
    encoding: "utf8",
  });
  if (probe.error?.code === "ENOENT")
    throw new Error(
      `Local's native build needs rustup with the Rust ${toolchain} toolchain. Install rustup from https://rustup.rs, then run \`rustup toolchain install ${toolchain}\`.`,
    );
  if (probe.error) throw probe.error;
  if (probe.status !== 0)
    throw new Error(
      `Local's native build needs the Rust ${toolchain} toolchain through rustup. Run \`rustup toolchain install ${toolchain}\`. rustup reported: ${probe.stderr.trim()}`,
    );
}
