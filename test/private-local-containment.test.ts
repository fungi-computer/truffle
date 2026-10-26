import {
  closeSync,
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { createServer } from "node:net";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  establishLocalSandbox,
  LocalSandboxUnavailable,
  type SandboxCommand,
} from "../src/private-local-containment.js";
import {
  localAgentFolderSchema,
  resolveAgentFolder,
  sandboxPolicy,
  linuxSandboxProfile,
} from "../src/private-local-sandbox-policy.js";
import { linuxSandboxCommand } from "../src/private-local-linux-sandbox.js";
import {
  createLocalSandboxControls,
  ProtectedLocalFilesPath,
} from "../src/private-local-sandbox.js";
import { createPrivateFilesPatch } from "../src/private-files-patch.js";

const fixtures: string[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0))
    rmSync(fixture, { recursive: true });
});

function fixture() {
  const project = mkdtempSync(join(tmpdir(), "fungi-containment-"));
  fixtures.push(project);
  mkdirSync(join(project, "agent"));
  return project;
}

it("refuses Files writes into protected markers even before .git exists", () => {
  const project = fixture();
  const controls = createLocalSandboxControls({
    project,
    folder: "agent",
    mode: () => "read-only",
  });
  try {
    expect(() => {
      controls.assertWrite([
        join(project, "agent", ".git", "hooks", "post-commit"),
      ]);
    }).toThrow(ProtectedLocalFilesPath);
    expect(() => {
      controls.assertWrite([
        join(project, "agent", ".fungi", "exec-rules.json"),
      ]);
    }).toThrow(ProtectedLocalFilesPath);
    expect(() => {
      controls.assertWrite([join(project, "agent", "note.txt")]);
    }).not.toThrow();
    expect(() => {
      controls.assertWrite([
        join(project, "agent", "note.txt"),
        join(project, "agent", ".git", "config"),
      ]);
    }).toThrow(ProtectedLocalFilesPath);
  } finally {
    controls.close();
  }
});

/** Real Git, isolated from the developer's own configuration. */
function gitIn(home: string) {
  return (cwd: string, args: readonly string[]) =>
    execFileSync("git", [...args], {
      cwd,
      env: {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        HEAVY: "/nonexistent",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
}

function commit(git: ReturnType<typeof gitIn>, cwd: string) {
  git(cwd, [
    "-c",
    "user.name=Sandbox fixture",
    "-c",
    "user.email=sandbox@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
}

function bundledNativeFixture() {
  const project = fixture();
  const folder = join(project, "agent");
  const install = mkdtempSync(join(tmpdir(), "fungi-native-install-"));
  fixtures.push(install);
  const packageName = `@fungi.computer/spore-native-${process.platform}-${process.arch}`;
  const packageRoot = join(install, "node_modules", packageName);
  const bin = join(packageRoot, "bin");
  mkdirSync(bin, { recursive: true });
  for (const name of [
    "fungi-bwrap",
    "fungi-seccomp.bpf",
    "fungi-seccomp-workspace.bpf",
    "fungi-apply-patch",
  ])
    copyFileSync(
      fileURLToPath(new URL(`../native/bin/${name}`, import.meta.url)),
      join(bin, name),
    );
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      exports: {
        "./bin/fungi-bwrap": "./bin/fungi-bwrap",
        "./bin/fungi-apply-patch": "./bin/fungi-apply-patch",
      },
    }),
  );
  const cli = join(install, "cli.cjs");
  writeFileSync(cli, "");
  return { project, folder, bin, cli };
}

/** Real native launch, with only the maintained filter supplied on fd3. */
function runContained(
  command: SandboxCommand | undefined,
  project: string,
  folder: string,
) {
  if (command?.seccompFilter === undefined)
    throw new Error("Real Linux sandbox launch required, not bare fallback");
  const filter = join(project, "filter.bpf");
  writeFileSync(filter, command.seccompFilter);
  const fd = openSync(filter, "r");
  try {
    return spawnSync(command.executable, command.args, {
      cwd: folder,
      env: { ...command.environment, HEAVY: "/nonexistent" },
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe", fd],
    });
  } finally {
    closeSync(fd);
  }
}

describe("Local containment admission", () => {
  it("Full access skips sandbox admission and emits no wrapped launch", () => {
    const project = fixture();
    const cli = join(project, "agent", "fungi.cjs");
    writeFileSync(cli, "host code inside the Agent");
    const previous = process.env.FUNGI_BUNDLED_CLI;
    const previousLauncher = process.env.FUNGI_LAUNCHER;
    process.env.FUNGI_BUNDLED_CLI = cli;
    process.env.FUNGI_LAUNCHER = cli;
    try {
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        mode: () => "full-access",
        platform: "unsupported",
      });
      try {
        expect(
          controls.launch(join(project, "agent"), ["/usr/bin/true"]),
        ).toBeUndefined();
        expect(controls.status()).toMatchObject({
          mode: "full-access",
          available: true,
        });
      } finally {
        controls.close();
      }
      expect(() =>
        createLocalSandboxControls({
          project,
          folder: "agent",
          mode: () => "workspace",
          platform: "unsupported",
        }),
      ).toThrow(/install Fungi outside the project/u);
    } finally {
      if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
      else process.env.FUNGI_BUNDLED_CLI = previous;
      if (previousLauncher === undefined) delete process.env.FUNGI_LAUNCHER;
      else process.env.FUNGI_LAUNCHER = previousLauncher;
    }
  });

  it("Workspace on an unsupported host refuses without a bare command", () => {
    const project = fixture();
    const open = () =>
      createLocalSandboxControls({
        project,
        folder: "agent",
        mode: () => "workspace",
        platform: "unsupported",
      });
    expect(open).toThrow(LocalSandboxUnavailable);
    expect(open).toThrow("unsupported");
  });

  it.runIf(process.platform === "linux")(
    "refuses a packaged host entry inside the Agent project before sandbox admission",
    () => {
      const project = fixture();
      const install = join(project, "node_modules", "@fungi.computer", "spore");
      mkdirSync(join(install, "dist"), { recursive: true });
      const cli = join(install, "dist", "cli.js");
      const wrapper = join(install, "dist", "fungi.cjs");
      writeFileSync(cli, "host JS");
      writeFileSync(wrapper, "wrapper JS");
      const previousCli = process.env.FUNGI_BUNDLED_CLI;
      const previousLauncher = process.env.FUNGI_LAUNCHER;
      process.env.FUNGI_BUNDLED_CLI = cli;
      process.env.FUNGI_LAUNCHER = wrapper;
      try {
        expect(() =>
          createLocalSandboxControls({
            project,
            folder: "agent",
            mode: () => "workspace",
          }),
        ).toThrow(/install Fungi outside the project/i);
      } finally {
        if (previousCli === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previousCli;
        if (previousLauncher === undefined) delete process.env.FUNGI_LAUNCHER;
        else process.env.FUNGI_LAUNCHER = previousLauncher;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses a store-hardlinked host entry before sandbox admission",
    () => {
      const project = fixture();
      const install = mkdtempSync(join(tmpdir(), "fungi-host-install-"));
      fixtures.push(install);
      const dist = join(install, "dist");
      mkdirSync(dist);
      const cli = join(dist, "cli.js");
      const wrapper = join(dist, "fungi.cjs");
      writeFileSync(cli, "host JS");
      writeFileSync(wrapper, "wrapper JS");
      const alias = join(project, "agent", "cli.js");
      linkSync(cli, alias);
      writeFileSync(alias, "benign rewrite");
      expect(readFileSync(cli, "utf8")).toBe("benign rewrite");
      const previousCli = process.env.FUNGI_BUNDLED_CLI;
      const previousLauncher = process.env.FUNGI_LAUNCHER;
      process.env.FUNGI_BUNDLED_CLI = cli;
      process.env.FUNGI_LAUNCHER = wrapper;
      try {
        expect(() =>
          createLocalSandboxControls({
            project,
            folder: "agent",
            mode: () => "workspace",
          }),
        ).toThrow(/copying install/i);
      } finally {
        if (previousCli === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previousCli;
        if (previousLauncher === undefined) delete process.env.FUNGI_LAUNCHER;
        else process.env.FUNGI_LAUNCHER = previousLauncher;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "admits a copied host install outside the Agent project",
    () => {
      const { project, folder, cli } = bundledNativeFixture();
      const wrapper = join(dirname(cli), "fungi.cjs");
      writeFileSync(wrapper, "wrapper JS");
      const previousCli = process.env.FUNGI_BUNDLED_CLI;
      const previousLauncher = process.env.FUNGI_LAUNCHER;
      process.env.FUNGI_BUNDLED_CLI = cli;
      process.env.FUNGI_LAUNCHER = wrapper;
      let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
      try {
        controls = createLocalSandboxControls({
          project,
          folder: "agent",
          mode: () => "workspace",
        });
        expect(controls.status().available).toBe(true);
        expect(controls.launch(folder, ["/usr/bin/true"])).toBeDefined();
      } finally {
        controls?.close();
        if (previousCli === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previousCli;
        if (previousLauncher === undefined) delete process.env.FUNGI_LAUNCHER;
        else process.env.FUNGI_LAUNCHER = previousLauncher;
      }
    },
  );

  it("refuses a wrapper resolved into Git administration even with a copied CLI outside the project", () => {
    const project = fixture();
    const install = mkdtempSync(join(tmpdir(), "fungi-host-git-install-"));
    fixtures.push(install);
    mkdirSync(join(install, "dist"));
    const cli = join(install, "dist", "cli.js");
    writeFileSync(cli, "host JS");
    const git = join(project, ".git");
    mkdirSync(git);
    const wrapper = join(git, "fungi.cjs");
    writeFileSync(wrapper, "wrapper JS");
    const previousCli = process.env.FUNGI_BUNDLED_CLI;
    const previousLauncher = process.env.FUNGI_LAUNCHER;
    process.env.FUNGI_BUNDLED_CLI = cli;
    process.env.FUNGI_LAUNCHER = wrapper;
    try {
      expect(() =>
        createLocalSandboxControls({
          project,
          folder: "agent",
          mode: () => "workspace",
        }),
      ).toThrow(/Git administration/);
    } finally {
      if (previousCli === undefined) delete process.env.FUNGI_BUNDLED_CLI;
      else process.env.FUNGI_BUNDLED_CLI = previousCli;
      if (previousLauncher === undefined) delete process.env.FUNGI_LAUNCHER;
      else process.env.FUNGI_LAUNCHER = previousLauncher;
    }
  });

  it("refuses a hardlinked bin wrapper even when the CLI entry is a private copy", () => {
    const project = fixture();
    const install = mkdtempSync(join(tmpdir(), "fungi-host-wrapper-"));
    fixtures.push(install);
    mkdirSync(join(install, "dist"));
    const cli = join(install, "dist", "cli.js");
    const wrapper = join(install, "dist", "fungi.cjs");
    writeFileSync(cli, "host JS");
    writeFileSync(wrapper, "wrapper JS");
    linkSync(wrapper, join(project, "agent", "fungi.cjs"));
    const previousCli = process.env.FUNGI_BUNDLED_CLI;
    const previousLauncher = process.env.FUNGI_LAUNCHER;
    process.env.FUNGI_BUNDLED_CLI = cli;
    process.env.FUNGI_LAUNCHER = wrapper;
    try {
      expect(() =>
        createLocalSandboxControls({
          project,
          folder: "agent",
          mode: () => "workspace",
        }),
      ).toThrow(/copying install/);
    } finally {
      if (previousCli === undefined) delete process.env.FUNGI_BUNDLED_CLI;
      else process.env.FUNGI_BUNDLED_CLI = previousCli;
      if (previousLauncher === undefined) delete process.env.FUNGI_LAUNCHER;
      else process.env.FUNGI_LAUNCHER = previousLauncher;
    }
  });
  it.runIf(process.platform === "linux")(
    "reuses one verified launcher and one helper across readiness and repeated patch commands",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        mode: () => "workspace",
      });
      let stagedLauncher: string | undefined;
      try {
        const first = controls.launch(folder, ["/usr/bin/true"]);
        if (first === undefined)
          throw new Error("This test needs the real native Linux launcher");
        stagedLauncher = first.executable;
        const run = dirname(first.executable);
        const initial = readdirSync(run).sort();
        for (let index = 0; index < 50; index += 1) {
          controls.assertReady();
          expect(controls.launch(folder, ["/usr/bin/true"])?.executable).toBe(
            first.executable,
          );
        }
        expect(readdirSync(run).sort()).toEqual(initial);

        const helper = fileURLToPath(
          new URL("../native/bin/fungi-apply-patch", import.meta.url),
        );
        const paths = new Set<string>();
        for (let index = 0; index < 5; index += 1) {
          const command = controls.launch(folder, [helper], helper);
          if (command === undefined)
            throw new Error("Workspace launch must be sandboxed");
          paths.add(command.args.at(-1) ?? "");
          expect(command.executable).toBe(first.executable);
        }
        expect(paths.size).toBe(1);
        expect(readdirSync(run)).toEqual(initial);
      } finally {
        controls.close();
      }
      expect(existsSync(stagedLauncher)).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "uses the verified service copy after packaged launcher bytes change",
    () => {
      const { project, folder, bin, cli } = bundledNativeFixture();
      const launcher = join(bin, "fungi-bwrap");
      const previous = process.env.FUNGI_BUNDLED_CLI;
      process.env.FUNGI_BUNDLED_CLI = cli;
      let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
      try {
        controls = createLocalSandboxControls({
          project,
          folder: "agent",
          mode: () => "workspace",
        });
        expect(controls.status().available).toBe(true);
        const alias = join(folder, "launcher");
        linkSync(launcher, alias);
        writeFileSync(alias, "rewritten by Agent");
        const ready = controls;
        const launch = ready.launch(folder, ["/usr/bin/true"]);
        expect(launch?.executable).not.toBe(launcher);
        expect(controls.status()).toEqual({
          mode: "workspace",
          available: true,
        });
      } finally {
        controls?.close();
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previous;
      }
    },
  );

  it.runIf(process.platform === "linux").each([
    { exports: {}, name: "removed export" },
    {
      exports: { "./bin/fungi-bwrap": "./bin/absent-bwrap" },
      name: "export to absent file",
    },
  ])(
    "sandbox admission ignores Agent-hardlinked package.json $name when native bytes are intact",
    ({ exports }) => {
      const { project, folder, bin, cli } = bundledNativeFixture();
      const previous = process.env.FUNGI_BUNDLED_CLI;
      process.env.FUNGI_BUNDLED_CLI = cli;
      let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
      try {
        const metadata = join(dirname(bin), "package.json");
        const alias = join(folder, "package.json");
        linkSync(metadata, alias);
        writeFileSync(
          alias,
          JSON.stringify({
            name: `@fungi.computer/spore-native-${process.platform}-${process.arch}`,
            exports,
          }),
        );
        controls = createLocalSandboxControls({
          project,
          folder: "agent",
          mode: () => "workspace",
        });
        expect(controls.status().available).toBe(true);
        const ready = controls;
        const command = ready.launch(folder, ["/usr/bin/true"]);
        expect(command?.seccompFilter).toBeDefined();
        expect(controls.status()).toMatchObject({
          mode: "workspace",
          available: true,
        });
      } finally {
        controls?.close();
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previous;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "in-project native package without a bwrap file cannot claim to be missing",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const name = `@fungi.computer/spore-native-${process.platform}-${process.arch}`;
      const packageRoot = join(folder, "node_modules", name);
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name,
          exports: { "./bin/fungi-bwrap": "./bin/fungi-bwrap" },
        }),
      );
      const cli = join(folder, "cli.cjs");
      writeFileSync(cli, "");
      const previous = process.env.FUNGI_BUNDLED_CLI;
      process.env.FUNGI_BUNDLED_CLI = cli;
      try {
        expect(() =>
          createLocalSandboxControls({
            project,
            folder: "agent",
            mode: () => "workspace",
          }),
        ).toThrow("Packaged native payload is inside the Agent project");
      } finally {
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previous;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses Workspace when the outside-project package has no launcher",
    () => {
      const { project, bin, cli } = bundledNativeFixture();
      rmSync(join(bin, "fungi-bwrap"));
      const previous = process.env.FUNGI_BUNDLED_CLI;
      process.env.FUNGI_BUNDLED_CLI = cli;
      try {
        expect(() =>
          createLocalSandboxControls({
            project,
            folder: "agent",
            mode: () => "workspace",
          }),
        ).toThrow(LocalSandboxUnavailable);
      } finally {
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previous;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "a ready sandbox runs its verified private copy after the installed package disappears",
    () => {
      const { project, folder, cli } = bundledNativeFixture();
      const absent = mkdtempSync(join(tmpdir(), "fungi-absent-after-ready-"));
      fixtures.push(absent);
      const previous = process.env.FUNGI_BUNDLED_CLI;
      process.env.FUNGI_BUNDLED_CLI = cli;
      let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
      try {
        controls = createLocalSandboxControls({
          project,
          folder: "agent",
          mode: () => "workspace",
        });
        expect(controls.status().available).toBe(true);
        const otherCli = join(absent, "cli.cjs");
        writeFileSync(otherCli, "");
        process.env.FUNGI_BUNDLED_CLI = otherCli;
        const ready = controls;
        expect(ready.launch(folder, ["/usr/bin/true"])?.executable).toContain(
          "native-",
        );
        expect(controls.status()).toMatchObject({
          mode: "workspace",
          available: true,
        });
      } finally {
        controls?.close();
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previous;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "a ready owner types a changed Agent folder authority instead of proceeding",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        mode: () => "workspace",
      });
      try {
        expect(controls.status().available).toBe(true);
        rmSync(folder, { recursive: true });
        mkdirSync(join(project, "other"));
        symlinkSync("other", folder, "dir");
        expect(() => controls.launch(folder, ["/usr/bin/true"])).toThrow(
          LocalSandboxUnavailable,
        );
        expect(controls.status()).toMatchObject({
          mode: "workspace",
          available: false,
          reason: { kind: "folder" },
        });
      } finally {
        controls.close();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses Workspace when the host's first startup probe fails",
    () => {
      const project = fixture();
      // Linux has no macOS sandbox-exec; the constructed Seatbelt command
      // reaches the real host startup probe, which reports unavailable.
      const open = () =>
        createLocalSandboxControls({
          project,
          folder: "agent",
          mode: () => "workspace",
          platform: "darwin",
        });
      expect(open).toThrow(LocalSandboxUnavailable);
      expect(open).toThrow(/sandbox-exec|startup/u);
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses Read-only when the macOS profile cannot start, without bare fallback",
    () => {
      const project = fixture();
      const temporaryDirectory = join(project, "private-temp");
      mkdirSync(temporaryDirectory);
      const admission = establishLocalSandbox({
        project,
        folder: join(project, "agent"),
        mode: "read-only",
        platform: "darwin",
        temporaryDirectory,
      });
      expect(admission).toMatchObject({
        state: "unavailable",
        reason: { kind: "startup-refused" },
      });
      if (admission.state === "unavailable")
        expect(admission.reason.message).toMatch(
          /Read-only on this Mac needs a working sandbox-exec/u,
        );
    },
  );

  it("refuses Read-only on an unsupported host without a bare launch", () => {
    const project = fixture();
    expect(() =>
      createLocalSandboxControls({
        project,
        folder: "agent",
        mode: () => "read-only",
        platform: "unsupported",
      }),
    ).toThrow(LocalSandboxUnavailable);
  });

  it.runIf(process.platform === "linux")(
    "Workspace refuses an unreadable installed filter before opening",
    () => {
      const { project, folder, bin, cli } = bundledNativeFixture();
      const previous = process.env.FUNGI_BUNDLED_CLI;
      process.env.FUNGI_BUNDLED_CLI = cli;
      linkSync(
        join(bin, "fungi-seccomp-workspace.bpf"),
        join(folder, "filter"),
      );
      chmodSync(join(folder, "filter"), 0);
      try {
        expect(() =>
          createLocalSandboxControls({
            project,
            folder: "agent",
            mode: () => "workspace",
          }),
        ).toThrow(LocalSandboxUnavailable);
      } finally {
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previous;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "Workspace refuses native staging failure before opening",
    () => {
      const { project, cli } = bundledNativeFixture();
      const runtime = mkdtempSync(join(tmpdir(), "fungi-no-stage-"));
      fixtures.push(runtime);
      const previousCli = process.env.FUNGI_BUNDLED_CLI;
      const previousRuntime = process.env.XDG_RUNTIME_DIR;
      process.env.FUNGI_BUNDLED_CLI = cli;
      process.env.XDG_RUNTIME_DIR = runtime;
      chmodSync(runtime, 0o500);
      try {
        expect(() =>
          createLocalSandboxControls({
            project,
            folder: "agent",
            mode: () => "workspace",
          }),
        ).toThrow(/EACCES|Local sandbox unavailable/u);
      } finally {
        chmodSync(runtime, 0o700);
        if (previousCli === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previousCli;
        if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = previousRuntime;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses Workspace when its native package is missing instead of falling back",
    () => {
      const project = fixture();
      const install = mkdtempSync(join(tmpdir(), "fungi-missing-package-"));
      fixtures.push(install);
      const cli = join(install, "cli.cjs");
      writeFileSync(cli, "");
      const previous = process.env.FUNGI_BUNDLED_CLI;
      process.env.FUNGI_BUNDLED_CLI = cli;
      try {
        expect(() =>
          createLocalSandboxControls({
            project,
            folder: "agent",
            mode: () => "workspace",
          }),
        ).toThrow(LocalSandboxUnavailable);
      } finally {
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previous;
      }
    },
  );

  it("releases standalone staged native bytes when Files.patch fails", async () => {
    const project = fixture();
    const folder = join(project, "agent");
    const runtime = mkdtempSync(join(tmpdir(), "fungi-failed-patch-"));
    fixtures.push(runtime);
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtime;
    try {
      const patch = await createPrivateFilesPatch(folder, () =>
        Promise.reject(new Error("No diagnostic read expected")),
      );
      if (patch === undefined)
        throw new Error("Fixture helper must be installed");
      const result = await patch(
        { patch: "not a native patch" },
        {
          executionId: "native-failure-cleanup",
          signal: new AbortController().signal,
          deadlineAt: null,
        },
      );
      expect("status" in result && result.status).toBe("failed");
      expect(readdirSync(join(runtime, "fungi"))).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
    }
  });

  it("does not return a bare command when the packaged backend is missing", () => {
    const project = fixture();
    // No backend is installed by a unit test. Kernel enforcement is qualified
    // separately with the real packaged binary, never a pretend ready probe.
    const result = establishLocalSandbox({
      project,
      folder: join(project, "agent"),
      mode: "workspace",
      temporaryDirectory: join(project, "private-temp"),
      platform: "unsupported",
    });
    expect(result).toEqual({
      state: "unavailable",
      reason: {
        kind: "unsupported",
        message:
          "Workspace on unsupported needs a supported OS sandbox; use --yolo or run on macOS/Linux.",
      },
    });
  });

  it("refuses a folder outside the project before preparing any backend", () => {
    const project = fixture();
    const outside = fixture();
    const result = establishLocalSandbox({
      project,
      folder: outside,
      mode: "workspace",
      temporaryDirectory: join(project, "private-temp"),
      platform: "unsupported",
    });
    expect(result.state).toBe("unavailable");
    if (result.state === "unavailable")
      expect(result.reason.kind).toBe("folder");
  });
});

describe("command-time sandbox policy", () => {
  it("grants only existing host cache roots in Workspace, never a project .npmrc or PATH bins", () => {
    const project = fixture();
    const folder = join(project, "agent");
    const home = join(project, "fixture-home");
    const cache = join(home, ".cache");
    const store = join(home, ".local", "share", "pnpm", "store");
    mkdirSync(cache, { recursive: true });
    mkdirSync(store, { recursive: true });
    writeFileSync(join(folder, ".npmrc"), `store-dir=${home}\n`);
    const policy = sandboxPolicy(project, folder);
    const host = { HOME: home };
    // Both home candidates are this fixture's input, never the machine HOME.
    const workspace = linuxSandboxProfile(
      policy,
      "workspace",
      folder,
      host,
      home,
    );
    expect(workspace.writable).toContain(cache);
    expect(workspace.writable).toContain(store);
    expect(workspace.writable).not.toContain(home);
    expect(workspace.writable).not.toContain(join(home, ".local", "bin"));
    expect(workspace.hidden).toEqual([
      join(home, ".config", "fungi"),
      join(home, ".fungi", "service"),
    ]);
    const readOnly = linuxSandboxProfile(
      policy,
      "read-only",
      folder,
      host,
      home,
    );
    expect(readOnly.writable).toEqual([]);
    expect(readOnly.sshAgentSocket).toBeUndefined();
  });

  it("protects Fungi's native cache under the host-selected XDG cache grant", () => {
    const project = fixture();
    const folder = join(project, "agent");
    const home = join(project, "home");
    const cache = join(project, "external-cache");
    const link = join(project, "cache-link");
    mkdirSync(join(cache, "fungi"), { recursive: true });
    symlinkSync(cache, link);
    for (const selected of [cache, link]) {
      const profile = linuxSandboxProfile(
        sandboxPolicy(project, folder),
        "workspace",
        folder,
        { HOME: home, XDG_CACHE_HOME: selected },
        home,
      );
      expect(profile.writable).toContain(cache);
      expect(profile.readOnly).toContain(join(cache, "fungi"));
    }
  });

  it("prepares an absent Fungi cache privately before mounting its writable parent", () => {
    const project = fixture();
    const folder = join(project, "agent");
    const home = join(project, "home");
    const cache = join(project, "cache");
    const link = join(project, "cache-link");
    mkdirSync(cache);
    symlinkSync(cache, link);
    for (const selected of [cache, link]) {
      const fungi = join(cache, "fungi");
      expect(existsSync(fungi)).toBe(false);
      const host = { HOME: home, XDG_CACHE_HOME: selected };
      const command = linuxSandboxCommand(
        linuxSandboxProfile(
          sandboxPolicy(project, folder),
          "workspace",
          folder,
          host,
          home,
        ),
        {
          executable: "/fixture/fungi-bwrap",
          seccompFilter: new Uint8Array([1]),
        },
        folder,
        ["/usr/bin/true"],
        host,
      );
      expect(statSync(fungi).mode & 0o777).toBe(0o700);
      expect(command.args.join("\0")).toContain(
        ["--ro-bind", fungi, fungi].join("\0"),
      );
      rmSync(fungi, { recursive: true });
    }
  });

  it("hides a sibling Agent's fallback temp after granting host caches in both modes", () => {
    // Host /tmp is already masked; the real fallback under HOME is not.
    const scratch = fileURLToPath(
      new URL("../../../.botanical/tmp/", import.meta.url),
    );
    mkdirSync(scratch, { recursive: true });
    const project = mkdtempSync(join(scratch, "fungi-fallback-"));
    fixtures.push(project);
    mkdirSync(join(project, "agent"));
    const folder = join(project, "agent");
    const home = join(project, "home");
    const base = join(home, ".cache", "fungi", "tmp");
    const own = join(base, "agent-b");
    mkdirSync(own, { recursive: true });
    mkdirSync(join(base, "agent-a"), { recursive: true });
    const policy = sandboxPolicy(project, folder);
    for (const mode of ["workspace", "read-only"] as const) {
      const profile = linuxSandboxProfile(
        policy,
        mode,
        own,
        { HOME: home },
        home,
      );
      const command = linuxSandboxCommand(
        profile,
        {
          executable: "/fixture/fungi-bwrap",
          seccompFilter: new Uint8Array([1]),
        },
        folder,
        ["/usr/bin/true"],
        { HOME: home },
      );
      expect(command.args.join("\0")).toContain(
        ["--bind", own, "/tmp"].join("\0"),
      );
      // When this checkout itself is under /tmp, the earlier private /tmp
      // already masks the host fallback; no guest mountpoint exists here.
      const underTmp = relative("/tmp", base);
      if (underTmp === ".." || underTmp.startsWith(`..${sep}`)) {
        expect(command.args.join("\0")).toContain(["--tmpfs", base].join("\0"));
        expect(command.args.indexOf(base)).toBeGreaterThan(
          command.args.indexOf(own),
        );
      }
    }
  });

  it("masks a stale fallback temp when this Agent has a runtime temp", () => {
    const project = fixture();
    const folder = join(project, "agent");
    const home = join(project, "home");
    const base = join(home, ".cache", "fungi", "tmp");
    const osHome = join(project, "os-home");
    const osBase = join(osHome, ".cache", "fungi", "tmp");
    const runtimeOwn = join(project, "runtime-agent");
    mkdirSync(join(base, "other"), { recursive: true });
    mkdirSync(join(osBase, "other"), { recursive: true });
    mkdirSync(runtimeOwn);
    for (const mode of ["workspace", "read-only"] as const) {
      const profile = linuxSandboxProfile(
        sandboxPolicy(project, folder),
        mode,
        runtimeOwn,
        { HOME: home },
        osHome,
      );
      expect(profile.hidden).toContain(base);
      expect(profile.hidden).toContain(osBase);
    }
  });

  it("refuses Files writes to Git administration and outside the Agent folder", () => {
    const project = fixture();
    const folder = join(project, "agent");
    gitIn(project)(folder, ["init", "-b", "main"]);
    const controls = createLocalSandboxControls({
      project,
      folder: "agent",
      mode: () => "workspace",
    });
    try {
      expect(() => {
        controls.assertWrite([join(folder, "source.ts")]);
      }).not.toThrow();
      for (const path of [
        join(folder, ".git"),
        join(folder, ".git", "config"),
        join(folder, ".git", "hooks", "pre-commit"),
        join(project, "outside"),
      ])
        expect(() => {
          controls.assertWrite([path]);
        }).toThrow(/protected Local path/u);
    } finally {
      controls.close();
    }
  });

  it("types a symlinked Agent .git as an invalid folder with a recovery instruction", () => {
    const project = fixture();
    const folder = join(project, "agent");
    const target = join(project, "git-target");
    mkdirSync(target);
    symlinkSync(target, join(folder, ".git"));
    const admission = establishLocalSandbox({
      project,
      folder,
      mode: "workspace",
      temporaryDirectory: folder,
      platform: "unsupported",
    });
    expect(admission.state).toBe("unavailable");
    if (admission.state !== "unavailable")
      throw new Error("Symlinked Git marker must refuse admission");
    expect(admission.reason.kind).toBe("folder");
    expect(admission.reason.message).toMatch(
      /Remove the \.git symlink or select a different Agent folder/u,
    );
    expect(() => sandboxPolicy(project, folder)).toThrow(
      /Remove the \.git symlink or select a different Agent folder/u,
    );
  });

  it("types a .git symlink planted after readiness instead of exposing bwrap's raw error", () => {
    const project = fixture();
    const folder = join(project, "agent");
    const controls = createLocalSandboxControls({
      project,
      folder: "agent",
      mode: () => "workspace",
    });
    try {
      const target = join(project, "git-target");
      mkdirSync(target);
      symlinkSync(target, join(folder, ".git"));
      expect(() => controls.launch(folder, ["/usr/bin/true"])).toThrow(
        LocalSandboxUnavailable,
      );
      expect(() => controls.launch(folder, ["/usr/bin/true"])).toThrow(
        /Remove the \.git symlink or select a different Agent folder/u,
      );
    } finally {
      controls.close();
    }
  });

  it
    .runIf(process.platform === "linux")
    .each(["repository root", "repository subdirectory", "non-repository"])(
    "does not grant a planted Git pointer access to a victim from a %s",
    (repositoryLocation) => {
      const project = fixture();
      const folder = join(project, "agent");
      // /tmp is masked inside bwrap; keep the victim in the ignored checkout
      // scratchpad so a refusal proves read-only enforcement, not ENOENT.
      const area = fileURLToPath(
        new URL("../../../.botanical/", import.meta.url),
      );
      mkdirSync(area, { recursive: true });
      const victim = mkdtempSync(join(area, "fungi-git-victim-"));
      fixtures.push(victim);
      const git = gitIn(project);
      git(victim, ["init", "-b", "main"]);
      commit(git, victim);
      if (repositoryLocation === "repository root") {
        git(folder, ["init", "-b", "main"]);
        commit(git, folder);
      } else if (repositoryLocation === "repository subdirectory") {
        git(project, ["init", "-b", "main"]);
        commit(git, project);
      }
      const head = readFileSync(
        join(victim, ".git", "refs", "heads", "main"),
        "utf8",
      );
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        mode: () => "workspace",
      });
      try {
        // These are two separate ordinary Workspace commands. The first
        // cannot plant the pointer, and the next must never bind victim's C.
        const plant = runContained(
          controls.launch(folder, [
            "/usr/bin/python3",
            "-c",
            [
              "import pathlib",
              ...(repositoryLocation === "repository root"
                ? ["pathlib.Path('.git').rename('.git-decoy')"]
                : []),
              `pathlib.Path('.git').write_text(${JSON.stringify(`gitdir: ${join(victim, ".git")}\n`)})`,
            ].join("\n"),
          ]),
          project,
          folder,
        );
        const write = runContained(
          controls.launch(folder, [
            "/usr/bin/python3",
            "-c",
            [
              "import pathlib",
              `pathlib.Path(${JSON.stringify(join(victim, ".git", "objects", "planted"))}).write_text('planted')`,
              `pathlib.Path(${JSON.stringify(join(victim, ".git", "refs", "heads", "main"))}).write_text('0' * 40 + '\\n')`,
            ].join("\n"),
          ]),
          project,
          folder,
        );
        expect(existsSync(join(victim, ".git", "objects", "planted"))).toBe(
          false,
        );
        expect(
          readFileSync(join(victim, ".git", "refs", "heads", "main"), "utf8"),
        ).toBe(head);
        expect(git(victim, ["status", "--porcelain"])).toBe("");
        if (repositoryLocation === "repository root")
          expect(plant.status, plant.stderr).not.toBe(0);
        else expect(plant.status, plant.stderr).toBe(0);
        expect(write.status, write.stderr).not.toBe(0);
        expect(write.stderr).toMatch(/read-only file system/iu);
      } finally {
        controls.close();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps a 601-worktree Git policy and bwrap argv bounded",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const git = gitIn(project);
      git(folder, ["init", "-b", "main"]);
      commit(git, folder);
      for (let index = 0; index < 601; index += 1)
        git(folder, [
          "worktree",
          "add",
          "--detach",
          join(project, "lanes", String(index)),
          "HEAD",
        ]);
      const policy = sandboxPolicy(project, folder);
      const command = linuxSandboxCommand(
        linuxSandboxProfile(
          policy,
          "workspace",
          join(project, "agent"),
          process.env,
          userInfo().homedir,
        ),
        {
          executable: "/fixture/fungi-bwrap",
          seccompFilter: new Uint8Array([1]),
        },
        folder,
        ["/usr/bin/true"],
      );
      expect(command.args.length).toBeLessThan(200);
      expect(policy.readOnly).toContain(join(folder, ".git"));
    },
    120_000,
  );

  it.runIf(process.platform === "linux")(
    "reads Git but refuses all metadata writes in main and linked worktrees",
    () => {
      const project = fixture();
      const main = join(project, "agent");
      const linked = join(project, "linked");
      const git = gitIn(project);
      git(main, ["init", "-b", "main"]);
      commit(git, main);
      git(main, ["worktree", "add", "--detach", linked, "HEAD"]);
      for (const [folder, name] of [
        [main, "agent"],
        [linked, "linked"],
      ]) {
        if (folder === undefined || name === undefined)
          throw new Error("Missing checkout");
        const controls = createLocalSandboxControls({
          project,
          folder: name,
          mode: () => "workspace",
        });
        try {
          for (const args of [["status"], ["log", "-1"], ["diff"]]) {
            const result = runContained(
              controls.launch(folder, ["/usr/bin/git", ...args]),
              project,
              folder,
            );
            expect(result.status, result.stderr).toBe(0);
          }
          const metadata =
            name === "linked"
              ? join(main, ".git", "worktrees", "linked")
              : join(main, ".git");
          for (const args of [
            ["commit", "--allow-empty", "-m", "blocked"],
            ["config", "user.name", "blocked"],
            ["branch", "blocked"],
          ]) {
            const result = runContained(
              controls.launch(folder, ["/usr/bin/git", ...args]),
              project,
              folder,
            );
            expect(result.status, result.stderr).not.toBe(0);
          }
          const common = join(main, ".git");
          const targets = [
            join(common, "objects", "planted"),
            join(common, "refs", "heads", "main"),
            join(common, "index"),
            join(metadata, "HEAD"),
            join(metadata, "index"),
          ];
          const before = targets.map((target) =>
            existsSync(target) ? readFileSync(target) : undefined,
          );
          for (const target of targets) {
            const result = runContained(
              controls.launch(folder, [
                "/usr/bin/python3",
                "-c",
                "import pathlib; pathlib.Path(" +
                  JSON.stringify(target) +
                  ").write_bytes(b'planted')",
              ]),
              project,
              folder,
            );
            expect(result.status, result.stderr).not.toBe(0);
          }
          for (const [index, target] of targets.entries()) {
            if (before[index] === undefined)
              expect(existsSync(target)).toBe(false);
            else expect(readFileSync(target)).toEqual(before[index]);
          }
        } finally {
          controls.close();
        }
      }
      // Full access skips the sandbox and commits with ordinary host Git.
      const full = createLocalSandboxControls({
        project,
        folder: "agent",
        mode: () => "full-access",
      });
      try {
        expect(
          full.launch(main, [
            "/usr/bin/git",
            "commit",
            "--allow-empty",
            "-m",
            "full",
          ]),
        ).toBeUndefined();
        commit(git, main);
        expect(git(main, ["log", "-1", "--format=%s"]).trim()).toBe("fixture");
      } finally {
        full.close();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "an Agent cannot rewrite a protected Always-allow store with a sandboxed command",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const store = join(folder, ".fungi");
      mkdirSync(store);
      const rules = join(store, "exec-rules.json");
      writeFileSync(rules, '{"version":1,"prefixes":[]}\n');
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        mode: () => "workspace",
      });
      try {
        const result = runContained(
          controls.launch(folder, [
            "/usr/bin/python3",
            "-c",
            "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('forged')",
            rules,
          ]),
          project,
          folder,
        );
        expect(result.status).not.toBe(0);
        expect(readFileSync(rules, "utf8")).toBe(
          '{"version":1,"prefixes":[]}\n',
        );
      } finally {
        controls.close();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "leaves no Git marker when the selected folder has none",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const marker = join(folder, ".git");
      expect(sandboxPolicy(project, folder).readOnly).not.toContain(marker);
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        mode: () => "workspace",
      });
      try {
        const result = runContained(
          controls.launch(folder, ["/usr/bin/true"]),
          project,
          folder,
        );
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(marker)).toBe(false);
      } finally {
        controls.close();
      }
    },
  );

  it("requires a directory for Agent folder authority before sandbox admission", () => {
    const project = fixture();
    writeFileSync(join(project, "not-a-folder"), "ordinary file");
    expect(() => resolveAgentFolder(project, "not-a-folder")).toThrow(
      "Agent folder must be a directory",
    );
  });

  it("uses the retained POSIX folder grammar and rejects realpath escape", () => {
    const project = fixture();
    expect(localAgentFolderSchema.parse("./agent/")).toBe("agent/");
    expect(resolveAgentFolder(project, "./agent")).toEqual({
      folder: "agent",
      absolute: join(project, "agent"),
    });
    for (const folder of ["", "/tmp", "..", "agent/../", "a\\b", "a\0b"])
      expect(localAgentFolderSchema.safeParse(folder).success).toBe(false);
    const outside = fixture();
    symlinkSync(outside, join(project, "escape"));
    expect(() => resolveAgentFolder(project, "escape")).toThrow(
      "outside the project",
    );
  });

  it("retains the v1 host view, filter fd and known Docker/runtime masks", () => {
    const project = fixture();
    const folder = join(project, "agent");
    const home = join(folder, "home");
    const runtime = join(folder, "runtime");
    mkdirSync(join(home, ".docker", "run"), { recursive: true });
    mkdirSync(join(home, ".docker", "desktop"), { recursive: true });
    mkdirSync(runtime);
    const filter = new Uint8Array([1]); // Builder data fixture, never executed.
    const command = linuxSandboxCommand(
      linuxSandboxProfile(
        sandboxPolicy(project, folder),
        "workspace",
        folder,
        {
          HOME: home,
          XDG_RUNTIME_DIR: runtime,
        },
        home,
      ),
      { executable: "/fixture/fungi-bwrap", seccompFilter: filter },
      folder,
      ["/usr/bin/true"],
      { HOME: home, XDG_RUNTIME_DIR: runtime },
    );
    expect(command.seccompFilter).toBe(filter);
    expect(command.args.join("\0")).toContain(
      ["--ro-bind", "/", "/"].join("\0"),
    );
    expect(command.args.join("\0")).toContain(["--seccomp", "3"].join("\0"));
    expect(command.args.join("\0")).toContain(
      ["--bind", folder, "/tmp"].join("\0"),
    );
    for (const path of [
      "/run",
      runtime,
      join(home, ".docker", "run"),
      join(home, ".docker", "desktop"),
    ])
      expect(command.args.join("\0")).toContain(["--tmpfs", path].join("\0"));
    const folderBind = command.args.indexOf(
      folder,
      command.args.indexOf("--bind") + 3,
    );
    for (const path of ["/run"])
      expect(command.args.indexOf(path)).toBeLessThan(folderBind);
    for (const path of [
      runtime,
      join(home, ".docker", "run"),
      join(home, ".docker", "desktop"),
    ])
      expect(command.args.indexOf(path)).toBeGreaterThan(folderBind);
  });

  it("masks the selected SSH-agent socket even inside the writable folder", async () => {
    const project = fixture();
    const folder = join(project, "agent");
    const socket = join(folder, "ssh.sock");
    const server = createServer();
    await new Promise<void>((accept, reject) => {
      server.once("error", reject);
      server.listen(socket, accept);
    });
    try {
      const command = linuxSandboxCommand(
        linuxSandboxProfile(
          sandboxPolicy(project, folder),
          "read-only",
          folder,
          { SSH_AUTH_SOCK: socket },
          join(project, "home"),
        ),
        {
          executable: "/fixture/fungi-bwrap",
          seccompFilter: new Uint8Array([1]),
        },
        folder,
        ["/usr/bin/true"],
        { SSH_AUTH_SOCK: socket },
      );
      expect(command.args.join("\0")).toContain(
        ["--ro-bind", "/dev/null", socket].join("\0"),
      );
      expect(command.args.indexOf(socket)).toBeGreaterThan(
        command.args.indexOf("--bind"),
      );
    } finally {
      await new Promise<void>((accept, reject) => {
        server.close((cause) => {
          if (cause) reject(cause);
          else accept();
        });
      });
    }
  });

  it("protects the whole Git directory and linked administration without writable grants", () => {
    const project = fixture();
    const main = join(project, "agent");
    const linked = join(project, "linked");
    const git = gitIn(project);
    git(main, ["init", "-b", "main"]);
    commit(git, main);
    git(main, ["worktree", "add", "--detach", linked, "HEAD"]);
    const common = join(main, ".git");
    const worktree = join(common, "worktrees", "linked");
    const policy = sandboxPolicy(project, linked);
    expect(policy.readOnly).toEqual([
      join(linked, ".fungi"),
      join(linked, ".git"),
      worktree,
      common,
    ]);
    const command = linuxSandboxCommand(
      linuxSandboxProfile(
        policy,
        "workspace",
        linked,
        process.env,
        userInfo().homedir,
      ),
      {
        executable: "/fixture/fungi-bwrap",
        seccompFilter: new Uint8Array([1]),
      },
      linked,
      ["/usr/bin/true"],
    );
    const args = command.args.join("\0");
    for (const path of [join(linked, ".git"), worktree, common])
      expect(args).toContain(["--ro-bind", path, path].join("\0"));
    expect(args).not.toContain(["--bind", common, common].join("\0"));
    expect(command.args.indexOf("--bind")).toBeLessThan(
      command.args.indexOf("--ro-bind", command.args.indexOf("--bind")),
    );
    const rootBind = command.args.indexOf("--bind");
    for (const path of [join(linked, ".git"), worktree, common])
      expect(command.args.indexOf(path)).toBeGreaterThan(rootBind);
    expect(command.args.indexOf(worktree)).toBeLessThan(
      command.args.lastIndexOf(common),
    );
  });

  it("does not use ambiguous Git query output to bind another directory writable", () => {
    const project = fixture();
    const folder = join(project, "agent");
    const newline = join(project, "new\nline");
    mkdirSync(newline);
    const git = gitIn(project);
    git(newline, ["init", "-b", "main"]);
    writeFileSync(join(folder, ".git"), `gitdir: ${join(newline, ".git")}\n`);
    expect(sandboxPolicy(project, folder).readOnly).toEqual([
      join(folder, ".fungi"),
      join(folder, ".git"),
    ]);
  });
});
