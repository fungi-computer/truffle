import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  seatbeltCommand,
  seatbeltReadiness,
} from "../src/private-local-seatbelt.js";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fungi-seatbelt-")));
  directories.push(root);
  const writableRoot = join(root, 'work "a"');
  const temporaryDirectory = join(root, "private-temp");
  mkdirSync(writableRoot);
  mkdirSync(temporaryDirectory);
  return {
    writableRoot,
    temporaryDirectory,
    readOnly: [
      join(writableRoot, ".fungi"),
      join(writableRoot, ".git", "hooks"),
      join(writableRoot, ".git", "config"),
    ],
    immovable: [join(writableRoot, ".git")],
  };
}

describe("Seatbelt command policy", () => {
  it("keeps paths in parameters, excludes exact names and descendants, and never grants network", () => {
    const policy = fixture();
    const command = seatbeltCommand(policy, ["/bin/sh", "-c", "echo safe"]);
    expect(command.executable).toBe("/usr/bin/sandbox-exec");
    const profile = command.args[1];
    expect(profile).toContain('(deny default (with message "fungi-safe"))');
    expect(profile).not.toMatch(/\(allow network/);
    expect(profile).not.toContain("(allow system-socket");
    expect(profile).not.toContain("(remote unix-socket");
    expect(profile).toContain(
      '(deny appleevent-send (with message "fungi-safe"))',
    );
    expect(profile?.match(/\(allow mach-lookup/g)).toHaveLength(1);
    expect(profile).toContain(
      '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    );
    expect(profile).not.toContain("(global-name-prefix");
    expect(profile).not.toContain(policy.writableRoot);
    for (const [index, path] of policy.readOnly.entries()) {
      expect(command.args).toContain(`PROTECTED_${String(index)}=${path}`);
      expect(profile).toContain(
        `(require-not (literal (param "PROTECTED_${String(index)}")))`,
      );
      expect(profile).toContain(
        `(require-not (subpath (param "PROTECTED_${String(index)}")))`,
      );
    }
    expect(profile).toContain("(deny file-write-unlink");
    expect(profile).toContain("(deny system-fcntl (fcntl-command 80 110))");
    expect(command.args.slice(-4)).toEqual([
      "--",
      "/bin/sh",
      "-c",
      "echo safe",
    ]);
    expect(command.args).toContain(`WRITABLE_ROOT_0=${policy.writableRoot}`);
    expect(command.args).toContain(
      `WRITABLE_ROOT_1=${policy.temporaryDirectory}`,
    );
  });

  it.skipIf(process.platform === "darwin")(
    "reports the missing absolute macOS mechanism as unavailable (not a bare fallback)",
    () => {
      const result = seatbeltReadiness(fixture());
      expect(result.ready).toBe(false);
      expect(result).toHaveProperty("reason");
    },
  );
});
