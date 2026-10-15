import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import process from "node:process";
import { afterEach, expect, it } from "vitest";
import {
  ensureNativeHostToolchain,
  selectCargoInvocation,
} from "../scripts/native-toolchain.mjs";

const fixtures = [];
afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

// This box's real rustup install, used by the "real caller" tests below.
const realRustupDir = dirname(
  spawnSync(process.platform === "win32" ? "where" : "which", ["rustup"], {
    encoding: "utf8",
  }).stdout.trim(),
);

async function fakeCargoOnPath() {
  const root = await mkdtemp(join(tmpdir(), "fake-cargo-"));
  fixtures.push(root);
  const script = join(root, "cargo");
  // Mirrors a non-rustup `cargo` (for example Homebrew's), which rejects the
  // `+toolchain` directive only rustup's `cargo` proxy understands.
  await writeFile(
    script,
    "#!/bin/sh\ncase \"$1\" in\n  +*) echo 'error: Cargo does not handle +toolchain directives' >&2; exit 1;;\nesac\necho 'fake cargo invoked without a toolchain selector' >&2\nexit 1\n",
  );
  await chmod(script, 0o755);
  return root;
}

it("selects the container path's bare `cargo +<toolchain>` unchanged", () => {
  const { command, args } = selectCargoInvocation({
    containerized: true,
    toolchain: "1.98.1",
    cargoArgs: ["build", "--release"],
  });
  expect(command).toBe("cargo");
  expect(args).toEqual(["+1.98.1", "build", "--release"]);
});

it("selects rustup's ordinary toolchain-run interface for a native host build", () => {
  const { command, args } = selectCargoInvocation({
    containerized: false,
    toolchain: "1.98.1",
    cargoArgs: ["build", "--release"],
  });
  expect(command).toBe("rustup");
  expect(args).toEqual(["run", "1.98.1", "cargo", "build", "--release"]);
});

it("ensureNativeHostToolchain passes with the real installed 1.98.1 toolchain", () => {
  expect(() =>
    ensureNativeHostToolchain({ toolchain: "1.98.1" }),
  ).not.toThrow();
});

it("ensureNativeHostToolchain fails with one message naming rustup when it is absent", () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/usr/bin:/bin";
  try {
    expect(() => ensureNativeHostToolchain({ toolchain: "1.98.1" })).toThrow(
      /rustup.*https:\/\/rustup\.rs.*rustup toolchain install 1\.98\.1/su,
    );
  } finally {
    process.env.PATH = originalPath;
  }
});

it("ensureNativeHostToolchain fails with one message naming the install command when the toolchain is missing", () => {
  // Real rustup, asked for a toolchain this box never installed.
  expect(() =>
    ensureNativeHostToolchain({ toolchain: "9.9.9-not-installed" }),
  ).toThrow(
    /Rust 9\.9\.9-not-installed toolchain.*rustup toolchain install 9\.9\.9-not-installed.*is not installed/su,
  );
});

it("a shim cargo that rejects +toolchain fails bare `cargo +1.98.1` but not the real selection", async () => {
  const shimDir = await fakeCargoOnPath();
  const shimmedPath = [shimDir, realRustupDir, process.env.PATH].join(
    delimiter,
  );

  // Before the fix: a bare `cargo +1.98.1` resolves the shim first and fails.
  const bare = spawnSync("cargo", ["+1.98.1", "--version"], {
    env: { ...process.env, PATH: shimmedPath },
    encoding: "utf8",
  });
  expect(bare.status).not.toBe(0);
  expect(bare.stderr).toMatch(/does not handle \+toolchain directives/);

  // After the fix: the real selection goes through rustup directly, so the
  // shimmed `cargo` is never consulted and the pinned toolchain still runs.
  const { command, args } = selectCargoInvocation({
    containerized: false,
    toolchain: "1.98.1",
    cargoArgs: ["--version"],
  });
  const fixed = spawnSync(command, args, {
    env: { ...process.env, PATH: shimmedPath },
    encoding: "utf8",
  });
  expect(fixed.status).toBe(0);
  expect(fixed.stdout).toMatch(/cargo 1\.98\.1/);

  // The shimmed `cargo` does not confuse the preflight check either: rustup
  // still reports the pinned toolchain as installed.
  const originalPath = process.env.PATH;
  process.env.PATH = shimmedPath;
  try {
    expect(() =>
      ensureNativeHostToolchain({ toolchain: "1.98.1" }),
    ).not.toThrow();
  } finally {
    process.env.PATH = originalPath;
  }
});
