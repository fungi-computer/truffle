import { expect, it } from "vitest";
import { nativeSandboxHost } from "../src/private-local-host-support.js";

it("a Linux host with glibc older than 2.35 cannot run the OS sandbox, and says why", () => {
  for (const glibc of ["2.17", "2.31", "2.34"])
    expect(nativeSandboxHost("linux", glibc)).toEqual({
      kind: "unsupported",
      reason: `The OS sandbox needs glibc 2.35 or newer and this host has glibc ${glibc}. Full access runs without it; Workspace and Read-only are not available here.`,
    });
});

it("glibc 2.35 and newer, other platforms and an unreadable glibc keep the sandbox", () => {
  for (const glibc of ["2.35", "2.39", "2.100", "3.0"])
    expect(nativeSandboxHost("linux", glibc)).toEqual({ kind: "supported" });
  expect(nativeSandboxHost("darwin", undefined)).toEqual({ kind: "supported" });
  // A Linux host with no glibc (musl) never gets this far: the launcher refuses
  // it, and an unreadable libc is not proof the hardware cannot sandbox.
  expect(nativeSandboxHost("linux", undefined)).toEqual({ kind: "supported" });
});
