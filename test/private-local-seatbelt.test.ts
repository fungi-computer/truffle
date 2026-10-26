import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { seatbeltCommand } from "../src/private-local-seatbelt.js";
import {
  linuxSandboxProfile,
  sandboxPolicy,
} from "../src/private-local-sandbox-policy.js";

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
    projectRoot: root,
    writableRoot,
    temporaryDirectory,
    readOnly: [
      join(writableRoot, ".fungi"),
      join(writableRoot, ".git", "hooks"),
      join(writableRoot, ".git", "config"),
    ],
  };
}

function writableDefinitions(args: readonly string[]) {
  return args.filter((arg) => /^WRITABLE_ROOT_\d+=/u.test(arg));
}

function seatbeltProfile(
  policy: Parameters<typeof linuxSandboxProfile>[0] &
    Readonly<{ temporaryDirectory: string }>,
  mode: "read-only" | "workspace",
  home = join(policy.projectRoot, "home"),
) {
  return linuxSandboxProfile(
    policy,
    mode,
    policy.temporaryDirectory,
    {
      HOME: home,
    },
    home,
    "darwin",
  );
}

describe("Seatbelt command policy", () => {
  it("protects the entire Git marker supplied by the real policy builder", () => {
    const { projectRoot, writableRoot, temporaryDirectory } = fixture();
    execFileSync("git", ["init", "-q", writableRoot], {
      env: { PATH: process.env.PATH, HOME: projectRoot, HEAVY: "/nonexistent" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const policy = {
      ...sandboxPolicy(projectRoot, writableRoot),
      temporaryDirectory,
    };
    const marker = join(writableRoot, ".git");
    const index = policy.readOnly.indexOf(marker);
    expect(index).toBeGreaterThanOrEqual(0);
    const command = seatbeltCommand(seatbeltProfile(policy, "workspace"), [
      "/usr/bin/true",
    ]);
    expect(command.args).toContain(`PROTECTED_${String(index)}=${marker}`);
    expect(command.args[1]).toContain(
      `(require-not (literal (param "PROTECTED_${String(index)}")))`,
    );
    expect(command.args[1]).toContain(
      `(require-not (subpath (param "PROTECTED_${String(index)}")))`,
    );
  });

  it("never grants a linked Git directory a write exception", () => {
    const base = fixture();
    const common = join(base.projectRoot, "common");
    const worktree = join(common, "worktrees", "lane");
    mkdirSync(worktree, { recursive: true });
    const command = seatbeltCommand(
      seatbeltProfile({ ...base, readOnly: [common, worktree] }, "workspace"),
      ["/usr/bin/true"],
    );
    expect(command.args).not.toContain(`WRITABLE_ROOT_2=${common}`);
    expect(command.args).toContain(`PROTECTED_0=${common}`);
    expect(command.args).toContain(`PROTECTED_1=${worktree}`);
  });

  it("keeps verified host-native staging outside the Agent's writable TMPDIR grant", () => {
    const policy = fixture();
    const host = realpathSync(
      mkdtempSync(join(tmpdir(), "fungi-seatbelt-host-")),
    );
    directories.push(host);
    const staged = join(host, "native");
    mkdirSync(staged, { mode: 0o700 });
    const command = seatbeltCommand(seatbeltProfile(policy, "read-only"), [
      join(staged, "fungi-apply-patch"),
    ]);
    expect(command.args).toContain(
      `WRITABLE_ROOT_0=${policy.temporaryDirectory}`,
    );
    expect(
      command.args.filter((argument) => argument.startsWith("WRITABLE_ROOT_")),
    ).not.toContain(`WRITABLE_ROOT_0=${staged}`);
    expect(staged).not.toBe(policy.temporaryDirectory);
    expect(command.temporaryDirectory).toBe(policy.temporaryDirectory);
  });
  it("keeps paths in parameters, excludes exact names and descendants, and never grants network", () => {
    const policy = fixture();
    const command = seatbeltCommand(seatbeltProfile(policy, "workspace"), [
      "/bin/sh",
      "-c",
      "echo safe",
    ]);
    expect(command.executable).toBe("/usr/bin/sandbox-exec");
    const profile = command.args[1] ?? "";
    expect(profile).toContain('(deny default (with message "fungi-safe"))');
    expect(profile).not.toMatch(/\(allow network/);
    expect(profile).not.toContain("(allow system-socket");
    expect(profile).not.toContain("(remote unix-socket");
    expect(profile).toContain(
      '(deny appleevent-send (with message "fungi-safe"))',
    );
    expect(profile.match(/\(allow mach-lookup/g)).toHaveLength(1);
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
    expect(writableDefinitions(command.args)).toEqual([
      `WRITABLE_ROOT_0=${policy.writableRoot}`,
      `WRITABLE_ROOT_1=${policy.temporaryDirectory}`,
    ]);
    expect(profile.match(/\(allow file-write\*/gu)).toHaveLength(1);
  });

  it("Read-only grants temp but not the Agent folder and denies network", () => {
    const policy = fixture();
    const command = seatbeltCommand(seatbeltProfile(policy, "read-only"), [
      "/usr/bin/true",
    ]);
    expect(command.args).toContain(
      `WRITABLE_ROOT_0=${policy.temporaryDirectory}`,
    );
    expect(command.args).not.toContain(
      `WRITABLE_ROOT_0=${policy.writableRoot}`,
    );
    expect(command.args).not.toContain(
      `WRITABLE_ROOT_1=${policy.temporaryDirectory}`,
    );
    expect(writableDefinitions(command.args)).toEqual([
      `WRITABLE_ROOT_0=${policy.temporaryDirectory}`,
    ]);
    expect(command.args[1]?.match(/\(allow file-write\*/gu)).toHaveLength(1);
    expect(command.args[1]).not.toMatch(/\(allow network/);
  });
  it("Workspace writes only the Agent folder and temp; Fungi records are hidden", () => {
    const policy = fixture();
    const home = join(policy.projectRoot, "home");
    mkdirSync(home);
    const command = seatbeltCommand(
      seatbeltProfile(policy, "workspace", home),
      ["/usr/bin/true"],
    );
    expect(command.args).toContain(`WRITABLE_ROOT_0=${policy.writableRoot}`);
    expect(command.args).toContain(
      `WRITABLE_ROOT_1=${policy.temporaryDirectory}`,
    );
    expect(command.args[1]).toContain(
      '(deny file-read* (subpath (param "HIDDEN_0")))',
    );
    expect(command.args).toContain(
      `HIDDEN_0=${join(home, ".config", "fungi")}`,
    );
    expect(command.args).toContain(
      `HIDDEN_1=${join(home, ".fungi", "service")}`,
    );
    for (const hidden of ["HIDDEN_0", "HIDDEN_1"]) {
      const text = command.args[1] ?? "";
      expect(
        text.indexOf(`(deny file-read* (literal (param "${hidden}")))`),
      ).toBeGreaterThan(text.indexOf("(allow file-read*)"));
      expect(
        text.indexOf(`(deny file-read* (subpath (param "${hidden}")))`),
      ).toBeGreaterThan(text.indexOf("(allow file-read*)"));
      expect(
        text.indexOf(`(deny file-write* (literal (param "${hidden}")))`),
      ).toBeGreaterThan(text.indexOf("(allow file-write*"));
      expect(
        text.indexOf(`(deny file-write* (subpath (param "${hidden}")))`),
      ).toBeGreaterThan(text.indexOf("(allow file-write*"));
    }
  });

  it("refuses writable roots that can rename Fungi records or their parents", () => {
    const base = fixture();
    const home = join(base.projectRoot, "home");
    const config = join(home, ".config");
    const fungi = join(config, "fungi");
    const state = join(home, ".fungi");
    for (const path of [fungi, state]) mkdirSync(path, { recursive: true });
    for (const folder of [home, config, fungi, state]) {
      expect(() =>
        seatbeltCommand(
          seatbeltProfile({ ...base, writableRoot: folder }, "workspace", home),
          ["/usr/bin/true"],
        ),
      ).toThrow(/hidden record or its parent/u);
    }
    expect(() =>
      seatbeltCommand(seatbeltProfile(base, "read-only", home), [
        "/usr/bin/true",
      ]),
    ).not.toThrow();
    for (const mode of ["read-only", "workspace"] as const) {
      expect(() =>
        seatbeltCommand(
          linuxSandboxProfile(
            base,
            mode,
            config,
            { HOME: home },
            home,
            "darwin",
          ),
          ["/usr/bin/true"],
        ),
      ).toThrow(/hidden record or its parent/u);
    }
  });

  it("preserves the Agent's fallback Mac temp while Linux masks sibling temps", () => {
    const base = fixture();
    const home = join(base.projectRoot, "home");
    const tempBase = join(home, ".cache", "fungi", "tmp");
    const ownTemp = join(tempBase, "agent");
    mkdirSync(ownTemp, { recursive: true });
    const mac = linuxSandboxProfile(
      base,
      "read-only",
      ownTemp,
      { HOME: home },
      home,
      "darwin",
    );
    const linux = linuxSandboxProfile(
      base,
      "read-only",
      ownTemp,
      {
        HOME: home,
      },
      home,
    );
    expect(linux.hidden).toContain(tempBase);
    expect(mac.hidden).toEqual([
      join(home, ".config", "fungi"),
      join(home, ".fungi", "service"),
    ]);
    const command = seatbeltCommand(mac, ["/usr/bin/true"]);
    expect(writableDefinitions(command.args)).toEqual([
      `WRITABLE_ROOT_0=${ownTemp}`,
    ]);
    expect(command.args.filter((arg) => /^HIDDEN_\d+=/u.test(arg))).toEqual([
      `HIDDEN_0=${join(home, ".config", "fungi")}`,
      `HIDDEN_1=${join(home, ".fungi", "service")}`,
    ]);
  });

  it("Workspace fallback temp grant cannot inherit the Fungi cache write exclusion", () => {
    const base = fixture();
    const home = join(base.projectRoot, "home");
    const cache = join(home, ".cache");
    const ownTemp = join(cache, "fungi", "tmp", "agent");
    mkdirSync(ownTemp, { recursive: true });
    const profile = linuxSandboxProfile(
      base,
      "workspace",
      ownTemp,
      { HOME: home, XDG_CACHE_HOME: cache },
      home,
      "darwin",
    );
    const fungiCache = join(cache, "fungi");
    expect(profile.fungiCache).toBe(fungiCache);
    const command = seatbeltCommand(profile, ["/usr/bin/true"]);
    expect(writableDefinitions(command.args)).toEqual([
      `WRITABLE_ROOT_0=${base.writableRoot}`,
      `WRITABLE_ROOT_1=${ownTemp}`,
    ]);
    const name = command.args
      .find((arg) => /^PROTECTED_\d+=/u.test(arg) && arg.endsWith(fungiCache))
      ?.split("=")[0];
    if (name === undefined)
      throw new Error("Generated Seatbelt profile lost the Fungi cache guard");
    const exclusion = `(require-not (subpath (param "${name}")))`;
    const [folderGrant, tempGrant] = (command.args[1] ?? "").split(
      '(require-all (subpath (param "WRITABLE_ROOT_1"))',
    );
    expect(folderGrant).toContain(exclusion);
    expect(tempGrant).toBeDefined();
    expect(tempGrant).not.toContain(exclusion);
  });
});
