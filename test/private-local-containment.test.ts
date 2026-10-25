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
  symlinkSync,
  writeFileSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  establishLocalSandbox,
  LocalSandboxUnavailable,
  type SandboxCommand,
} from "../src/private-local-containment.js";
import {
  privateNativeDirectory,
  localAgentFolderSchema,
  resolveAgentFolder,
  sandboxPolicy,
} from "../src/private-local-sandbox-policy.js";
import { linuxSandboxCommand } from "../src/private-local-linux-sandbox.js";
import { createLocalSandboxControls } from "../src/private-local-sandbox.js";
import { createPrivateInvocationFilesPort } from "../src/private-invocation-files.js";
import { createPrivateFilesPatch } from "../src/private-files-patch.js";
import type {
  BareNativeCommand,
  LocalSandboxLaunch,
} from "../src/private-invocation-computer.js";

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
  for (const name of ["fungi-bwrap", "fungi-seccomp.bpf", "fungi-apply-patch"])
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
      env: command.environment,
      encoding: "utf8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "pipe", fd],
    });
  } finally {
    closeSync(fd);
  }
}

describe("Local containment admission", () => {
  it.runIf(process.platform === "linux").each([false, true])(
    "refuses a packaged host entry inside the Agent project before native admission (required=%s)",
    (required) => {
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
            required: () => required,
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

  it.runIf(process.platform === "linux").each([false, true])(
    "refuses a store-hardlinked host entry before native admission (required=%s)",
    (required) => {
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
            required: () => required,
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

  it.runIf(process.platform === "linux").each([false, true])(
    "admits a copied host install outside the Agent project (required=%s)",
    (required) => {
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
          required: () => required,
        });
        expect(controls.status().state).toBe("available");
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
          required: () => false,
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
          required: () => false,
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
    "runs the once-admitted helper bytes when bare fallback is allowed, without rereading its source",
    async () => {
      const project = fixture();
      const folder = join(project, "agent");
      const install = mkdtempSync(join(tmpdir(), "fungi-fallback-install-"));
      fixtures.push(install);
      const packageName = `@fungi.computer/spore-native-${process.platform}-${process.arch}`;
      const packageRoot = join(install, "node_modules", packageName);
      const bin = join(packageRoot, "bin");
      mkdirSync(bin, { recursive: true });
      const helper = join(bin, "fungi-apply-patch");
      copyFileSync(
        fileURLToPath(
          new URL("../native/bin/fungi-apply-patch", import.meta.url),
        ),
        helper,
      );
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({
          name: packageName,
          exports: { "./bin/fungi-apply-patch": "./bin/fungi-apply-patch" },
        }),
      );
      const cli = join(install, "cli.cjs");
      writeFileSync(cli, "");
      const previous = process.env.FUNGI_BUNDLED_CLI;
      process.env.FUNGI_BUNDLED_CLI = cli;
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => false,
        platform: "unsupported",
      });
      let admitted = 0;
      let stagedPath: string | undefined;
      try {
        expect(controls.status().state).toBe("unavailable"); // Unsupported backend.
        function admit(
          cwd: string,
          argv: readonly [string, ...string[]],
        ): SandboxCommand | undefined;
        function admit(
          cwd: string,
          argv: readonly [string, ...string[]],
          readOnlyHelperFile: string,
        ): SandboxCommand | BareNativeCommand;
        function admit(
          cwd: string,
          argv: readonly [string, ...string[]],
          readOnlyHelperFile?: string,
        ): SandboxCommand | BareNativeCommand | undefined {
          if (readOnlyHelperFile === undefined)
            return controls.launch(cwd, argv);
          const command = controls.launch(cwd, argv, readOnlyHelperFile);
          if ("bareNative" in command) stagedPath = command.executable;
          admitted += 1;
          // The producer changes after admission; only the staged inode may
          // be executed. A second source read would see the altered bytes.
          writeFileSync(helper, "altered", { mode: 0o700 });
          return command;
        }
        const sandbox: LocalSandboxLaunch = admit;
        // Files advertises the readable installed helper; only its staged
        // copy needs an execute bit.
        chmodSync(helper, 0o644);
        const patch = await createPrivateFilesPatch(
          folder,
          () => Promise.reject(new Error("No diagnostic read expected")),
          sandbox,
        );
        if (patch === undefined)
          throw new Error("Fixture helper must be installed");
        const result = await patch(
          {
            patch:
              "*** Begin Patch\n*** Add File: admitted.txt\n+admitted\n*** End Patch\n",
          },
          {
            executionId: "native-fallback-once",
            signal: new AbortController().signal,
            deadlineAt: null,
          },
        );
        expect(admitted).toBe(1);
        expect(result.status).toBe("completed");
        expect(readFileSync(join(folder, "admitted.txt"), "utf8")).toBe(
          "admitted\n",
        );
        if (stagedPath === undefined)
          throw new Error("Fallback must have staged the helper");
        expect(statSync(stagedPath).mode & 0o777).toBe(0o500);
        expect(readdirSync(dirname(dirname(stagedPath)))).toHaveLength(1);
        await expect(
          patch(
            {
              patch:
                "*** Begin Patch\n*** Add File: refused.txt\n+refused\n*** End Patch\n",
            },
            {
              executionId: "native-fallback-recheck",
              signal: new AbortController().signal,
              deadlineAt: null,
            },
          ),
        ).rejects.toThrow("digest mismatch");
        expect(admitted).toBe(1);
      } finally {
        controls.close();
        if (stagedPath !== undefined)
          expect(existsSync(stagedPath)).toBe(false);
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previous;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "reuses one verified launcher and one helper across readiness and repeated patch commands",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => true,
      });
      let stagedLauncher: string | undefined;
      try {
        const first = controls.launch(folder, ["/usr/bin/true"]);
        if (first === undefined)
          throw new Error("This test needs the real native Linux launcher");
        stagedLauncher = first.executable;
        const run = dirname(dirname(first.executable));
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
          paths.add(command.args.at(-1) ?? "");
          expect(command.executable).toBe(first.executable);
        }
        expect(paths.size).toBe(1);
        expect(readdirSync(run)).toHaveLength(initial.length + 1);
      } finally {
        controls.close();
      }
      expect(existsSync(stagedLauncher)).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses optional bare fallback when the ready sandbox's launcher is rewritten through an Agent hardlink",
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
          required: () => false,
        });
        expect(controls.status().state).toBe("available");
        const alias = join(folder, "launcher");
        linkSync(launcher, alias);
        writeFileSync(alias, "rewritten by Agent");
        const ready = controls;
        expect(() => ready.launch(folder, ["/usr/bin/true"])).toThrow(
          LocalSandboxUnavailable,
        );
        expect(controls.status()).toEqual({
          state: "unavailable",
          requireSandbox: false,
          reason: {
            kind: "digest-mismatch",
            message:
              "Packaged fungi-bwrap digest mismatch; reinstall Fungi. No command was started.",
          },
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
    "optional sandbox ignores Agent-hardlinked package.json $name when native bytes are intact",
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
          required: () => false,
        });
        expect(controls.status().state).toBe("available");
        const ready = controls;
        const command = ready.launch(folder, ["/usr/bin/true"]);
        expect(command?.seccompFilter).toBeDefined();
        expect(controls.status()).toMatchObject({ state: "available" });
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
      let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
      try {
        controls = createLocalSandboxControls({
          project,
          folder: "agent",
          required: () => false,
        });
        const ready = controls;
        expect(() => ready.launch(folder, ["/usr/bin/true"])).toThrow(
          LocalSandboxUnavailable,
        );
        expect(controls.status()).toMatchObject({
          state: "unavailable",
          reason: { kind: "unsafe-native-payload" },
        });
      } finally {
        controls?.close();
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previous;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "fresh optional admission refuses an outside-project package whose launcher is absent",
    () => {
      const { project, folder, bin, cli } = bundledNativeFixture();
      rmSync(join(bin, "fungi-bwrap"));
      const previous = process.env.FUNGI_BUNDLED_CLI;
      process.env.FUNGI_BUNDLED_CLI = cli;
      let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
      try {
        controls = createLocalSandboxControls({
          project,
          folder: "agent",
          required: () => false,
        });
        expect(controls.status()).toMatchObject({
          state: "unavailable",
          requireSandbox: false,
          reason: { kind: "missing-artifact" },
        });
        const admitted = controls;
        expect(() => admitted.launch(folder, ["/usr/bin/true"])).toThrow(
          LocalSandboxUnavailable,
        );
        expect(controls.status()).toMatchObject({
          state: "unavailable",
          reason: { kind: "missing-artifact" },
        });
      } finally {
        controls?.close();
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previous;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "a ready optional sandbox refuses even a subsequently absent native package",
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
          required: () => false,
        });
        expect(controls.status().state).toBe("available");
        const otherCli = join(absent, "cli.cjs");
        writeFileSync(otherCli, "");
        process.env.FUNGI_BUNDLED_CLI = otherCli;
        const ready = controls;
        expect(() => ready.launch(folder, ["/usr/bin/true"])).toThrow(
          LocalSandboxUnavailable,
        );
        expect(controls.status()).toMatchObject({
          state: "unavailable",
          reason: { kind: "missing" },
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
        required: () => false,
      });
      try {
        expect(controls.status().state).toBe("available");
        rmSync(folder, { recursive: true });
        mkdirSync(join(project, "other"));
        symlinkSync("other", folder, "dir");
        expect(() => controls.launch(folder, ["/usr/bin/true"])).toThrow(
          LocalSandboxUnavailable,
        );
        expect(controls.status()).toMatchObject({
          state: "unavailable",
          reason: { kind: "invalid-folder" },
        });
      } finally {
        controls.close();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "ready optional sandbox refuses a Git hooks file instead of returning a bare command",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => false,
      });
      try {
        expect(controls.status().state).toBe("available");
        const git = join(folder, "sub", ".git");
        mkdirSync(git, { recursive: true });
        writeFileSync(join(git, "hooks"), "");
        const ready = controls;
        expect(() => ready.launch(folder, ["/usr/bin/true"])).toThrow(
          LocalSandboxUnavailable,
        );
        expect(controls.status()).toMatchObject({
          state: "unavailable",
          reason: { kind: "backend-refused" },
        });
      } finally {
        controls.close();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "optional sandbox refuses Git preparation errors even before its first readiness probe",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const git = join(folder, "sub", ".git");
      mkdirSync(git, { recursive: true });
      writeFileSync(join(git, "hooks"), "");
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => false,
      });
      try {
        expect(controls.status()).toMatchObject({
          state: "unavailable",
          reason: { kind: "backend-refused" },
        });
        expect(() => controls.launch(folder, ["/usr/bin/true"])).toThrow(
          LocalSandboxUnavailable,
        );
      } finally {
        controls.close();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "optional sandbox may fall back when the host's first startup probe fails",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      // Linux has no macOS sandbox-exec; the constructed Seatbelt command
      // reaches the real host startup probe, which reports unavailable.
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => false,
        platform: "darwin",
      });
      try {
        expect(controls.status()).toMatchObject({
          state: "unavailable",
          reason: { kind: "startup-refused" },
        });
        expect(controls.launch(folder, ["/usr/bin/true"])).toBeUndefined();
      } finally {
        controls.close();
      }
    },
  );

  it("optional unsupported platform still permits a bare command", () => {
    const project = fixture();
    const folder = join(project, "agent");
    const controls = createLocalSandboxControls({
      project,
      folder: "agent",
      required: () => false,
      platform: "unsupported",
    });
    try {
      expect(controls.status()).toMatchObject({
        state: "unavailable",
        reason: { kind: "unsupported-platform" },
      });
      expect(controls.launch(folder, ["/usr/bin/true"])).toBeUndefined();
    } finally {
      controls.close();
    }
  });

  it.runIf(process.platform === "linux").each([
    { artifact: "fungi-bwrap", mode: 0o644, expected: "contained" },
    { artifact: "fungi-seccomp.bpf", mode: 0o000, expected: "unreadable" },
    { artifact: "fungi-apply-patch", mode: 0o000, expected: "unreadable" },
    { artifact: "fungi-apply-patch", mode: 0o644, expected: "contained" },
  ])(
    "optional sandbox rechecks installed $artifact permissions after readiness",
    ({ artifact, mode, expected }) => {
      const { project, folder, bin, cli } = bundledNativeFixture();
      const previous = process.env.FUNGI_BUNDLED_CLI;
      process.env.FUNGI_BUNDLED_CLI = cli;
      let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
      try {
        controls = createLocalSandboxControls({
          project,
          folder: "agent",
          required: () => false,
        });
        expect(controls.status().state).toBe("available");
        const installed = join(bin, artifact);
        const alias = join(folder, artifact);
        linkSync(installed, alias);
        chmodSync(alias, mode);
        const ready = controls;
        const helper = artifact === "fungi-apply-patch" ? installed : undefined;
        const command = () =>
          helper === undefined
            ? ready.launch(folder, ["/usr/bin/true"])
            : ready.launch(folder, [helper], helper);
        if (expected === "contained") {
          const launch = command();
          expect(launch).toBeDefined();
          expect(launch).not.toHaveProperty("bareNative");
          expect(launch?.seccompFilter).toBeDefined();
        } else {
          expect(command).toThrow(LocalSandboxUnavailable);
          const status = controls.status();
          expect(status).toMatchObject({
            state: "unavailable",
            requireSandbox: false,
            reason: { kind: expected },
          });
          if (status.state !== "unavailable")
            throw new Error("Expected a typed native refusal");
          expect(status.reason.message).toContain(artifact);
        }
      } finally {
        controls?.close();
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previous;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses a missing installed artifact after readiness rather than treating it as a missing package",
    () => {
      const { project, folder, bin, cli } = bundledNativeFixture();
      const previous = process.env.FUNGI_BUNDLED_CLI;
      process.env.FUNGI_BUNDLED_CLI = cli;
      let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
      try {
        controls = createLocalSandboxControls({
          project,
          folder: "agent",
          required: () => false,
        });
        expect(controls.status().state).toBe("available");
        rmSync(join(bin, "fungi-seccomp.bpf"));
        const ready = controls;
        expect(() => ready.launch(folder, ["/usr/bin/true"])).toThrow(
          LocalSandboxUnavailable,
        );
        expect(controls.status()).toMatchObject({
          state: "unavailable",
          reason: { kind: "missing-artifact" },
        });
      } finally {
        controls?.close();
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previous;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "optional sandbox refuses an unreadable installed filter at first admission",
    () => {
      const { project, folder, bin, cli } = bundledNativeFixture();
      const previous = process.env.FUNGI_BUNDLED_CLI;
      process.env.FUNGI_BUNDLED_CLI = cli;
      linkSync(join(bin, "fungi-seccomp.bpf"), join(folder, "filter"));
      chmodSync(join(folder, "filter"), 0);
      let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
      try {
        controls = createLocalSandboxControls({
          project,
          folder: "agent",
          required: () => false,
        });
        const ready = controls;
        expect(() => ready.launch(folder, ["/usr/bin/true"])).toThrow(
          LocalSandboxUnavailable,
        );
        expect(controls.status()).toMatchObject({
          state: "unavailable",
          reason: { kind: "unreadable" },
        });
      } finally {
        controls?.close();
        if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previous;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "optional sandbox refuses native staging failure instead of running bare",
    () => {
      const { project, folder, cli } = bundledNativeFixture();
      const runtime = mkdtempSync(join(tmpdir(), "fungi-no-stage-"));
      fixtures.push(runtime);
      const previousCli = process.env.FUNGI_BUNDLED_CLI;
      const previousRuntime = process.env.XDG_RUNTIME_DIR;
      process.env.FUNGI_BUNDLED_CLI = cli;
      process.env.XDG_RUNTIME_DIR = runtime;
      chmodSync(runtime, 0o500);
      let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
      try {
        controls = createLocalSandboxControls({
          project,
          folder: "agent",
          required: () => false,
        });
        const ready = controls;
        expect(() => ready.launch(folder, ["/usr/bin/true"])).toThrow(
          LocalSandboxUnavailable,
        );
        expect(controls.status()).toMatchObject({
          state: "unavailable",
          reason: { kind: "staging-failed" },
        });
      } finally {
        controls?.close();
        chmodSync(runtime, 0o700);
        if (previousCli === undefined) delete process.env.FUNGI_BUNDLED_CLI;
        else process.env.FUNGI_BUNDLED_CLI = previousCli;
        if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = previousRuntime;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "optional sandbox may still use bare fallback when its native package is missing",
    () => {
      const project = fixture();
      const install = mkdtempSync(join(tmpdir(), "fungi-missing-package-"));
      fixtures.push(install);
      const cli = join(install, "cli.cjs");
      writeFileSync(cli, "");
      const previous = process.env.FUNGI_BUNDLED_CLI;
      process.env.FUNGI_BUNDLED_CLI = cli;
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => false,
      });
      try {
        expect(controls.status()).toMatchObject({
          state: "unavailable",
          reason: { kind: "missing" },
        });
        expect(
          controls.launch(join(project, "agent"), ["/usr/bin/true"]),
        ).toBeUndefined();
      } finally {
        controls.close();
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
      expect(result.status).toBe("failed");
      expect(readdirSync(join(runtime, "fungi", "native"))).toEqual([]);
    } finally {
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
    }
  });

  it.runIf(process.platform === "linux")(
    "admits a healthy sandbox when a stale-run PID probe is denied",
    () => {
      const project = fixture();
      const runtime = mkdtempSync(join(tmpdir(), "fungi-denied-pid-"));
      fixtures.push(runtime);
      const root = join(runtime, "fungi", "native");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const denied = join(root, "run-1-ABC123");
      mkdirSync(denied, { mode: 0o700 });
      const previous = process.env.XDG_RUNTIME_DIR;
      const probed: number[] = [];
      process.env.XDG_RUNTIME_DIR = runtime;
      let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
      try {
        controls = createLocalSandboxControls({
          project,
          folder: "agent",
          required: () => true,
          probeNativeRunLiveness: (pid) => {
            probed.push(pid);
            throw Object.assign(new Error("permission denied"), {
              code: "EPERM",
            });
          },
        });
        expect(controls.status().state).toBe("available");
        expect(
          controls.launch(join(project, "agent"), ["/usr/bin/true"])
            ?.seccompFilter,
        ).toBeDefined();
        expect(probed).toEqual([1]);
        expect(existsSync(denied)).toBe(true);
      } finally {
        controls?.close();
        if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = previous;
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "admits a healthy sandbox when another sweeper removes the next stale run",
    () => {
      const project = fixture();
      const runtime = mkdtempSync(join(tmpdir(), "fungi-concurrent-sweep-"));
      fixtures.push(runtime);
      const root = join(runtime, "fungi", "native");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const first = join(root, "run-999999998-ABC123");
      const removedByPeer = join(root, "run-999999998-ABC124");
      mkdirSync(first, { mode: 0o700 });
      mkdirSync(removedByPeer, { mode: 0o700 });
      expect(readdirSync(root)).toEqual([
        "run-999999998-ABC123",
        "run-999999998-ABC124",
      ]);
      const previous = process.env.XDG_RUNTIME_DIR;
      const probed: number[] = [];
      process.env.XDG_RUNTIME_DIR = runtime;
      let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
      try {
        controls = createLocalSandboxControls({
          project,
          folder: "agent",
          required: () => true,
          probeNativeRunLiveness: (pid) => {
            probed.push(pid);
            rmSync(removedByPeer, { recursive: true, force: true });
            throw Object.assign(new Error("process exited"), { code: "ESRCH" });
          },
        });
        expect(controls.status().state).toBe("available");
        expect(probed).toEqual([999999998]);
        expect(existsSync(first)).toBe(false);
        expect(existsSync(removedByPeer)).toBe(false);
      } finally {
        controls?.close();
        if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
        else process.env.XDG_RUNTIME_DIR = previous;
      }
    },
  );

  it("logs unexpected sweep errors and still opens a private native run", () => {
    const project = fixture();
    const runtime = mkdtempSync(join(tmpdir(), "fungi-sweep-error-"));
    fixtures.push(runtime);
    const root = join(runtime, "fungi", "native");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const inaccessible = join(root, "run-999999997-ABC123");
    const reclaimable = join(root, "run-999999998-ABC124");
    mkdirSync(inaccessible, { mode: 0o700 });
    mkdirSync(reclaimable, { mode: 0o700 });
    const previous = process.env.XDG_RUNTIME_DIR;
    const unexpected = Object.assign(new Error("cannot probe"), {
      code: "EACCES",
    });
    const warnings: unknown[][] = [];
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation((...args: unknown[]) => {
        warnings.push(args);
      });
    process.env.XDG_RUNTIME_DIR = runtime;
    try {
      const run = privateNativeDirectory(project, (pid) => {
        if (pid === 999999997) throw unexpected;
        throw Object.assign(new Error("process exited"), { code: "ESRCH" });
      });
      expect(existsSync(run)).toBe(true);
      expect(existsSync(inaccessible)).toBe(true);
      expect(existsSync(reclaimable)).toBe(false);
      expect(warning).toHaveBeenCalledWith(
        "Native stale-run sweep could not inspect entry",
        unexpected,
      );
      expect(warnings).toHaveLength(1);
      rmSync(run, { recursive: true });
    } finally {
      warning.mockRestore();
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
    }
  });

  it("sweeps only owned stale PID-named native runs under the selected runtime root", () => {
    const project = fixture();
    const runtime = mkdtempSync(join(tmpdir(), "fungi-runtime-root-"));
    fixtures.push(runtime);
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtime;
    try {
      const root = join(runtime, "fungi", "native");
      mkdirSync(root, { recursive: true, mode: 0o700 });
      const exited = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
      if (exited.status !== 0) throw new Error("Need an exited PID");
      const dead = exited.pid;
      const stale = join(root, `run-${String(dead)}-ABC123`);
      const foreign = join(root, `run-${String(dead)}-other`);
      const live = join(root, `run-${String(process.pid)}-ABC124`);
      const symlink = join(root, `run-${String(dead)}-ABC125`);
      mkdirSync(stale, { mode: 0o700 });
      mkdirSync(foreign, { mode: 0o700 });
      mkdirSync(live, { mode: 0o700 });
      symlinkSync(foreign, symlink);
      const current = privateNativeDirectory(project);
      expect(current).toMatch(
        new RegExp(`^${root}/run-${String(process.pid)}-`),
      );
      expect(readdirSync(root)).not.toContain(`run-${String(dead)}-ABC123`);
      expect(readdirSync(root)).toContain(`run-${String(dead)}-other`);
      expect(readdirSync(root)).toContain(`run-${String(process.pid)}-ABC124`);
      expect(readdirSync(root)).toContain(`run-${String(dead)}-ABC125`);
    } finally {
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
    }
  });

  it("refuses an Agent-project XDG runtime location instead of staging there", () => {
    const project = fixture();
    const folder = join(project, "agent");
    chmodSync(folder, 0o700);
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = folder;
    try {
      expect(() => privateNativeDirectory(project)).toThrow(/Agent project/);
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
      platform: "unsupported",
    });
    expect(result).toEqual({
      state: "unavailable",
      reason: {
        kind: "unsupported-platform",
        message: "Local sandbox is unavailable on unsupported.",
      },
    });
  });

  it("refuses a folder outside the project before preparing any backend", () => {
    const project = fixture();
    const outside = fixture();
    const result = establishLocalSandbox({
      project,
      folder: outside,
      platform: "unsupported",
    });
    expect(result.state).toBe("unavailable");
    if (result.state === "unavailable")
      expect(result.reason.kind).toBe("invalid-folder");
  });
});

describe("command-time sandbox policy", () => {
  it("requires a directory for Agent folder authority before unavailable fallback", () => {
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
      sandboxPolicy(project, folder),
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
    for (const path of [
      "/tmp",
      "/run",
      runtime,
      join(home, ".docker", "run"),
      join(home, ".docker", "desktop"),
    ])
      expect(command.args.join("\0")).toContain(["--tmpfs", path].join("\0"));
    const folderBind = command.args.indexOf("--bind");
    for (const path of ["/tmp", "/run"])
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
        sandboxPolicy(project, folder),
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

  it("protects state, hooks and config while retaining ordinary Git writes", () => {
    const project = fixture();
    const folder = join(project, "agent");
    mkdirSync(join(folder, ".git"));
    writeFileSync(join(folder, ".git", "config"), "fixture config");
    const policy = sandboxPolicy(project, folder);
    expect(policy.writableRoot).toBe(folder);
    expect(policy.readOnly).toEqual([
      join(folder, ".fungi"),
      join(folder, ".git", "hooks"),
      join(folder, ".git", "config"),
      join(folder, ".git", "config.worktree"),
      join(folder, ".git", "commondir"),
    ]);
    expect(policy.immovable).toEqual([join(folder, ".git")]);
    expect(readFileSync(join(folder, ".git", "config"), "utf8")).toBe(
      "fixture config",
    );
  });

  it("protects the linked worktree pointer instead of granting its external gitdir", () => {
    const project = fixture();
    const folder = join(project, "agent");
    writeFileSync(join(folder, ".git"), "gitdir: /outside/objects");
    expect(sandboxPolicy(project, folder).readOnly).toEqual([
      join(folder, ".fungi"),
      join(folder, ".git"),
    ]);
  });

  it("recomputes protected paths after Git is initialized", () => {
    const project = fixture();
    const folder = join(project, "agent");
    expect(sandboxPolicy(project, folder).immovable).toEqual([]);
    mkdirSync(join(folder, ".git"));
    expect(sandboxPolicy(project, folder).immovable).toEqual([
      join(folder, ".git"),
    ]);
  });

  it("counts the selected root and refuses incomplete discovery at the directory budget", () => {
    const project = fixture();
    const folder = join(project, "agent");
    // A selected-root Git pointer must not prune its own payload.
    writeFileSync(join(folder, ".git"), "gitdir: /outside/objects\n");
    expect(sandboxPolicy(project, folder, 1).writableRoot).toBe(folder);
    mkdirSync(join(folder, "payload"));
    expect(() => sandboxPolicy(project, folder, 1)).toThrow(
      "Sandbox Git discovery exceeds 1 directories",
    );
    expect(sandboxPolicy(project, folder, 2).writableRoot).toBe(folder);
    mkdirSync(join(folder, "payload", "child"));
    expect(() => sandboxPolicy(project, folder, 2)).toThrow(
      "Sandbox Git discovery exceeds 2 directories",
    );
  });

  it.each([0, -1, 1.5, 100_001, Infinity, NaN])(
    "does not accept a widened or invalid directory budget %s",
    (limit) => {
      const project = fixture();
      expect(() =>
        sandboxPolicy(project, join(project, "agent"), limit),
      ).toThrow();
    },
  );

  it.each([
    [".git/config", "git-config", ""],
    [".git/hooks", "git-hooks", "post-checkout"],
    [".fungi", "agent-state", "settings"],
  ])(
    "refuses real Files replacement through existing protected symlink %s",
    async (logical, destination, child) => {
      const project = fixture();
      const folder = join(project, "agent");
      mkdirSync(join(folder, ".git"));
      const target = join(folder, destination);
      if (child !== "") mkdirSync(target);
      const file = child === "" ? target : join(target, child);
      writeFileSync(file, "before");
      symlinkSync(
        logical.startsWith(".git/") ? `../${destination}` : destination,
        join(folder, logical),
      );
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => false,
      });
      try {
        const files = await createPrivateInvocationFilesPort(
          folder,
          undefined,
          controls,
        );
        for (const path of [join(logical, child), join(destination, child)]) {
          await expect(
            files.replace(
              { path, expectedContent: "before", content: "escaped" },
              {
                executionId: "protected-symlink",
                signal: new AbortController().signal,
                deadlineAt: null,
              },
            ),
          ).rejects.toThrow("Files write targets a protected Local path");
          expect(readFileSync(file, "utf8")).toBe("before");
        }
      } finally {
        controls.close();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "prunes linked-worktree payloads above a small directory budget and protects pointers and common Git administration",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const git = (args: readonly string[]) =>
        execFileSync("git", [...args], {
          cwd: folder,
          env: {
            PATH: process.env.PATH,
            HOME: project,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_TERMINAL_PROMPT: "0",
          },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
      git(["init", "-b", "main"]);
      git([
        "-c",
        "user.name=Sandbox fixture",
        "-c",
        "user.email=sandbox@example.invalid",
        "commit",
        "--allow-empty",
        "-m",
        "fixture",
      ]);
      const worktrees = ["first", "second"].map((name) =>
        join(".claude", "worktrees", name),
      );
      let directories = 0;
      for (const worktree of worktrees) {
        git(["worktree", "add", "--detach", worktree, "HEAD"]);
        const dependencies = join(folder, worktree, "node_modules");
        mkdirSync(dependencies);
        for (let directory = 0; directory < 33; directory += 1) {
          mkdirSync(join(dependencies, `dependency-${String(directory)}`));
          directories += 1;
        }
      }
      expect(directories).toBe(66);
      // A marker inside common administration must not make the scanner prune
      // that administration and lose its real hooks/config protections.
      writeFileSync(join(folder, ".git", ".git"), "not a checkout\n");
      const hook = join(".git", "hooks", "post-checkout");
      writeFileSync(join(folder, hook), "#!/bin/sh\nexit 0\n");
      const configurations = ["first", "second"].map((name) =>
        join(".git", "worktrees", name, "config.worktree"),
      );
      for (const path of configurations)
        writeFileSync(join(folder, path), "# controlled worktree config\n");
      const protectedFiles = [
        join(".git", "config"),
        hook,
        ...configurations,
        ...worktrees.map((path) => join(path, ".git")),
      ];
      const before = protectedFiles.map((path) =>
        readFileSync(join(folder, path), "utf8"),
      );
      // The same discovery owner and guard as production, with a tighter budget.
      // Git names the work tree; its 66 payload directories are not walked.
      expect(sandboxPolicy(project, folder, 64).readOnly).toEqual(
        expect.arrayContaining([
          join(folder, ".git", "config"),
          join(folder, ".git", "hooks"),
          ...configurations.map((path) => join(folder, path)),
          ...worktrees.map((path) => join(folder, path, ".git")),
        ]),
      );
      const pointers = worktrees.map((worktree) => {
        const path = join(folder, worktree, ".git");
        return { path, content: readFileSync(path, "utf8") };
      });
      for (const { path } of pointers) rmSync(path);
      try {
        // Without pointers the checkouts are ordinary untracked payload. Git
        // names the work tree's contents, so the 66 payload directories are
        // never walked, while common administration stays protected.
        expect(sandboxPolicy(project, folder, 64).readOnly).toEqual(
          expect.arrayContaining([
            join(folder, ".git", "config"),
            join(folder, ".git", "hooks"),
            ...configurations.map((path) => join(folder, path)),
          ]),
        );
      } finally {
        for (const { path, content } of pointers) writeFileSync(path, content);
      }
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => false,
      });
      try {
        expect(controls.status().state).toBe("available");
        const result = runContained(
          controls.launch(folder, [
            "/usr/bin/python3",
            "-c",
            [
              "import errno, pathlib",
              `paths = ${JSON.stringify(protectedFiles)}`,
              "for path in paths:",
              "    try: pathlib.Path(path).write_text('escaped')",
              "    except OSError as error: assert error.errno in (errno.EROFS, errno.EPERM, errno.EACCES), (path, error)",
              "    else: raise AssertionError('protected Git write was allowed: ' + path)",
              "pathlib.Path('linked-project-command').write_text('admitted')",
            ].join("\n"),
          ]),
          project,
          folder,
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(
          readFileSync(join(folder, "linked-project-command"), "utf8"),
        ).toBe("admitted");
        expect(
          protectedFiles.map((path) =>
            readFileSync(join(folder, path), "utf8"),
          ),
        ).toEqual(before);
      } finally {
        controls.close();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "asks Git for a work tree's repositories instead of walking ignored payload beyond the budget",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const git = gitIn(project);
      git(folder, ["init", "-b", "main"]);
      writeFileSync(join(folder, ".gitignore"), "node_modules/\n.botanical/\n");
      writeFileSync(join(folder, "tracked.txt"), "tracked\n");
      git(folder, ["add", ".gitignore", "tracked.txt"]);
      commit(git, folder);
      // pnpm-store-shaped ignored payload: far more directories than the
      // budget below, and never searched for Git metadata.
      let directories = 0;
      for (let store = 0; store < 10; store += 1)
        for (let file = 0; file < 10; file += 1) {
          mkdirSync(
            join(
              folder,
              "node_modules",
              ".pnpm",
              `dependency-${String(store)}@1.0.0`,
              `directory-${String(file)}`,
            ),
            { recursive: true },
          );
          directories += 1;
        }
      expect(directories).toBe(100);
      // Git names this untracked, non-ignored independent repository.
      const vendor = join(folder, "vendor", "lib");
      mkdirSync(vendor, { recursive: true });
      git(vendor, ["init", "-b", "main"]);
      // A registered linked worktree inside an ignored tool directory keeps
      // its pointer protected: Git's worktree list, not the ignored walk.
      const worktree = join(folder, ".botanical", "worktrees", "lane");
      git(folder, ["worktree", "add", "--detach", worktree, "HEAD"]);
      // An independent clone inside ignored payload is tool-owned content
      // that is not searched (sandbox-v1.md, ignored-payload trade-off).
      const ignoredClone = join(folder, "node_modules", "from-git");
      mkdirSync(ignoredClone);
      git(ignoredClone, ["init", "-b", "main"]);
      const policy = sandboxPolicy(project, folder, 64);
      expect(policy.immovable).toEqual(
        expect.arrayContaining([
          join(folder, ".git"),
          join(folder, ".git", "worktrees", "lane"),
          join(vendor, ".git"),
        ]),
      );
      expect(policy.readOnly).toEqual(
        expect.arrayContaining([
          join(folder, ".git", "hooks"),
          join(folder, ".git", "config"),
          join(folder, ".git", "worktrees", "lane", "config.worktree"),
          join(vendor, ".git", "hooks"),
          join(vendor, ".git", "config"),
          join(worktree, ".git"),
        ]),
      );
      expect(policy.immovable).not.toContain(join(ignoredClone, ".git"));
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => true,
      });
      try {
        expect(controls.status().state).toBe("available");
        const protectedFiles = [
          join(".git", "hooks", "post-checkout"),
          join(".git", "config"),
          join("vendor", "lib", ".git", "hooks", "post-checkout"),
          join("vendor", "lib", ".git", "config"),
          join(".botanical", "worktrees", "lane", ".git"),
        ];
        const result = runContained(
          controls.launch(folder, [
            "/usr/bin/python3",
            "-c",
            [
              "import errno, pathlib",
              `paths = ${JSON.stringify(protectedFiles)}`,
              "for path in paths:",
              "    try: pathlib.Path(path).write_text('escaped')",
              "    except OSError as error: assert error.errno in (errno.EROFS, errno.EPERM, errno.EACCES), (path, error)",
              "    else: raise AssertionError('protected Git write was allowed: ' + path)",
              "pathlib.Path('node_modules/.pnpm/written').write_text('admitted')",
            ].join("\n"),
          ]),
          project,
          folder,
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(
          readFileSync(
            join(folder, "node_modules", ".pnpm", "written"),
            "utf8",
          ),
        ).toBe("admitted");
      } finally {
        controls.close();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "asks Git from an Agent subfolder of a repository with ignored payload beyond the budget",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const git = gitIn(project);
      git(project, ["init", "-b", "main"]);
      writeFileSync(join(project, ".gitignore"), "node_modules/\n");
      git(project, ["add", ".gitignore"]);
      commit(git, project);
      for (let directory = 0; directory < 100; directory += 1)
        mkdirSync(
          join(folder, "node_modules", `dependency-${String(directory)}`),
          { recursive: true },
        );
      const nested = join(folder, "nested");
      mkdirSync(nested);
      git(nested, ["init", "-b", "main"]);
      const policy = sandboxPolicy(project, folder, 64);
      // The enclosing repository's administration is outside the writable
      // folder and therefore already read-only.
      expect(policy.immovable).toEqual([join(nested, ".git")]);
      expect(policy.readOnly).toEqual(
        expect.arrayContaining([
          join(nested, ".git", "hooks"),
          join(nested, ".git", "config"),
        ]),
      );
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses a commondir redirect to Agent-authored config and keeps host Git working with the placeholder",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const git = gitIn(project);
      git(folder, ["init", "-b", "main"]);
      commit(git, folder);
      const worktree = join(folder, ".claude", "worktrees", "lane");
      git(folder, ["worktree", "add", "--detach", worktree, "HEAD"]);
      const marker = join(project, "fsmonitor-ran");
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => true,
      });
      try {
        // The exploit: an Agent-built common directory whose config runs a
        // command from any host Git that reads the index.
        const result = runContained(
          controls.launch(folder, [
            "/usr/bin/python3",
            "-c",
            [
              "import errno, pathlib, shutil",
              "evil = pathlib.Path('evil').resolve()",
              "shutil.copytree('.git/objects', evil / 'objects')",
              "shutil.copytree('.git/refs', evil / 'refs')",
              "shutil.copy('.git/HEAD', evil / 'HEAD')",
              `(evil / 'config').write_text('[core]\\n\\trepositoryformatversion = 0\\n\\tfsmonitor = "touch ${marker}; false"\\n')`,
              "for path in ('.git/commondir', '.git/worktrees/lane/commondir'):",
              "    try: pathlib.Path(path).write_text(str(evil))",
              "    except OSError as error: assert error.errno in (errno.EROFS, errno.EPERM, errno.EACCES), (path, error)",
              "    else: raise AssertionError('commondir redirect was allowed: ' + path)",
            ].join("\n"),
          ]),
          project,
          folder,
        );
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
      } finally {
        controls.close();
      }
      expect(readFileSync(join(folder, ".git", "commondir"), "utf8")).toBe(".");
      expect(
        readFileSync(
          join(folder, ".git", "worktrees", "lane", "commondir"),
          "utf8",
        ),
      ).toBe("../..\n");
      // Ordinary host Git, fsmonitor not disabled, still uses the real
      // administration and works with the placeholder.
      git(folder, ["status"]);
      git(worktree, ["status"]);
      writeFileSync(join(folder, "file.txt"), "tracked\n");
      git(folder, ["add", "file.txt"]);
      commit(git, folder);
      git(folder, [
        "worktree",
        "add",
        "--detach",
        join(folder, "second"),
        "HEAD",
      ]);
      expect(git(folder, ["worktree", "list", "--porcelain"])).toContain(
        `worktree ${worktree}\n`,
      );
      expect(git(folder, ["rev-parse", "--git-common-dir"]).trim()).toBe(
        join(folder, ".git"),
      );
      expect(existsSync(marker)).toBe(false);
    },
  );

  it.runIf(process.platform === "linux")(
    "parses newline worktree paths and never silently drops a non-UTF-8 name",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const git = gitIn(project);
      git(folder, ["init", "-b", "main"]);
      writeFileSync(join(folder, ".gitignore"), "ignored/\n");
      git(folder, ["add", ".gitignore"]);
      commit(git, folder);
      const worktree = join(folder, "ignored", "new\nline");
      git(folder, ["worktree", "add", "--detach", worktree, "HEAD"]);
      expect(sandboxPolicy(project, folder, 64).readOnly).toContain(
        join(worktree, ".git"),
      );
      // Git reports this repository's raw bytes; a string path cannot name
      // it, so discovery refuses instead of protecting everything else.
      const ascii = join(folder, "nested");
      mkdirSync(ascii);
      git(ascii, ["init", "-b", "main"]);
      renameSync(
        ascii,
        Buffer.concat([Buffer.from(`${folder}/`), Buffer.from([0x63, 0xe9])]),
      );
      expect(() => sandboxPolicy(project, folder, 64)).toThrow("ENOENT");
    },
  );

  it.runIf(process.platform === "linux" && process.getuid?.() !== 0)(
    "refuses discovery when an Agent denies access to a reported worktree's parent",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const git = gitIn(project);
      git(folder, ["init", "-b", "main"]);
      // Ignored: Git never opens it, so only the worktree list names the
      // pointer and Git's own view still succeeds.
      writeFileSync(join(folder, ".gitignore"), "hidden/\n");
      git(folder, ["add", ".gitignore"]);
      commit(git, folder);
      const hidden = join(folder, "hidden");
      const worktree = join(hidden, "lane");
      git(folder, ["worktree", "add", "--detach", worktree, "HEAD"]);
      expect(sandboxPolicy(project, folder, 64).readOnly).toContain(
        join(worktree, ".git"),
      );
      // chmod 000 on a folder directory must not silently drop the pointer.
      chmodSync(hidden, 0o000);
      try {
        expect(() => sandboxPolicy(project, folder, 64)).toThrow("EACCES");
      } finally {
        chmodSync(hidden, 0o755);
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "never protects or binds a Git-reported path that leaves the writable folder",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      const outside = fixture();
      const git = gitIn(project);
      git(folder, ["init", "-b", "main"]);
      commit(git, folder);
      // An outside repository that Git-reported names would reach through a
      // symlinked parent or a rewritten worktree record.
      const outsideRepository = join(outside, "sub");
      mkdirSync(outsideRepository);
      git(outsideRepository, ["init", "-b", "main"]);
      const head = git(folder, ["rev-parse", "HEAD"]).trim();
      git(folder, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${head},link/sub`,
      ]);
      git(folder, ["worktree", "add", "--detach", join(folder, "wt"), "HEAD"]);
      symlinkSync(outside, join(folder, "link"));
      writeFileSync(
        join(folder, ".git", "worktrees", "wt", "gitdir"),
        `${join(outsideRepository, ".git")}\n`,
      );
      const policy = sandboxPolicy(project, folder, 64);
      for (const path of [...policy.immovable, ...policy.readOnly])
        expect(path.startsWith(`${folder}/`), path).toBe(true);
      expect(policy.immovable).not.toContain(
        join(folder, "link", "sub", ".git"),
      );
    },
  );

  it.runIf(process.platform === "linux")(
    "does not charge dependency files to the directory budget and runs a real sandboxed command",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      // pnpm-style hard-linked package payloads: real directory entries, not
      // mocked enumeration. Separate seeds avoid per-inode hard-link limits.
      let files = 0;
      for (let dependency = 0; dependency < 2; dependency += 1) {
        const name = `dependency-${String(dependency)}`;
        const directory = join(
          folder,
          "node_modules",
          ".pnpm",
          `${name}@1.0.0`,
          "node_modules",
          name,
        );
        mkdirSync(directory, { recursive: true });
        const seed = join(directory, "index.js");
        writeFileSync(seed, "export {};\n");
        files += 1;
        for (let file = 0; file < 10; file += 1) {
          linkSync(seed, join(directory, `file-${String(file)}.js`));
          files += 1;
        }
      }
      expect(files).toBe(22);
      // Root + node_modules + .pnpm + three directories per dependency.
      expect(sandboxPolicy(project, folder, 9).writableRoot).toBe(folder);
      expect(() => sandboxPolicy(project, folder, 8)).toThrow(
        "Sandbox Git discovery exceeds 8 directories",
      );
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => false,
      });
      try {
        expect(controls.status().state).toBe("available");
        const command = controls.launch(folder, [
          "/bin/sh",
          "-c",
          "printf admitted > large-project-command",
        ]);
        if (command?.seccompFilter === undefined)
          throw new Error("Large project must launch contained, not fall back");
        const filter = join(project, "filter.bpf");
        writeFileSync(filter, command.seccompFilter);
        const fd = openSync(filter, "r");
        try {
          const result = spawnSync(command.executable, command.args, {
            cwd: folder,
            env: command.environment,
            encoding: "utf8",
            timeout: 5_000,
            stdio: ["ignore", "pipe", "pipe", fd],
          });
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(0);
        } finally {
          closeSync(fd);
        }
        expect(
          readFileSync(join(folder, "large-project-command"), "utf8"),
        ).toBe("admitted");
      } finally {
        controls.close();
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "refuses real command writes to submodule, nested and worktree hooks/config while retaining Git data writes",
    () => {
      const project = fixture();
      const folder = join(project, "agent");
      // Admission happens before these repositories exist. The real launch
      // must discover the newly created metadata, not reuse admission's view.
      const controls = createLocalSandboxControls({
        project,
        folder: "agent",
        required: () => true,
      });
      try {
        const gitDirs = [
          ".git",
          ".git/modules/x",
          ".git/modules/group/y",
          "nested/.git",
          ".hidden/nested/.git",
          ".git/worktrees/n",
        ];
        for (const git of gitDirs) {
          mkdirSync(join(folder, git, "hooks"), { recursive: true });
          writeFileSync(join(folder, git, "HEAD"), "ref: refs/heads/main\n");
          if (git === ".git/worktrees/n")
            writeFileSync(join(folder, git, "commondir"), "../..\n");
          else mkdirSync(join(folder, git, "objects"));
          writeFileSync(join(folder, git, "config"), "original");
          writeFileSync(join(folder, git, "config.worktree"), "original");
        }
        // A worktree record's read-only commondir names the common directory,
        // whose hooks and config Git reads; its own copies are inert.
        const ownCommon = (git: string) => git !== ".git/worktrees/n";
        const protectedFiles = gitDirs.flatMap((git) => [
          ...(ownCommon(git)
            ? [join(git, "hooks", "post-checkout"), join(git, "config")]
            : []),
          join(git, "config.worktree"),
          join(git, "commondir"),
        ]);
        const command = controls.launch(folder, [
          "/usr/bin/python3",
          "-c",
          [
            "import errno, pathlib",
            `paths = ${JSON.stringify(protectedFiles)}`,
            "allowed = []",
            "for path in paths:",
            "    try: pathlib.Path(path).write_text('escaped')",
            "    except OSError as error: assert error.errno in (errno.EROFS, errno.EPERM, errno.EACCES), (path, error)",
            "    else: allowed.append(path)",
            "assert not allowed, 'protected Git writes were allowed: ' + repr(allowed)",
            // These are data, not executable configuration; keep ordinary Git
            // writes, including refs whose names happen to be config or hooks.
            "for git in " + JSON.stringify(gitDirs) + ":",
            "    pathlib.Path(git, 'index').write_text('ordinary Git data')",
            "    refs = pathlib.Path(git, 'refs', 'heads')",
            "    refs.mkdir(parents=True, exist_ok=True)",
            "    for name in ('config', 'hooks'): (refs / name).write_text('ordinary ref')",
          ].join("\n"),
        ]);
        if (command?.seccompFilter === undefined)
          throw new Error(
            "Real Linux Git protection requires the sandbox filter",
          );
        const filter = join(project, "filter.bpf");
        writeFileSync(filter, command.seccompFilter);
        const fd = openSync(filter, "r");
        try {
          const result = spawnSync(command.executable, command.args, {
            cwd: folder,
            env: command.environment,
            encoding: "utf8",
            timeout: 5_000,
            stdio: ["ignore", "pipe", "pipe", fd],
          });
          expect(result.error).toBeUndefined();
          expect(result.status, result.stderr).toBe(0);
        } finally {
          closeSync(fd);
        }
        for (const git of gitDirs) {
          if (ownCommon(git))
            expect(readFileSync(join(folder, git, "config"), "utf8")).toBe(
              "original",
            );
          expect(
            readFileSync(join(folder, git, "config.worktree"), "utf8"),
          ).toBe("original");
        }
      } finally {
        controls.close();
      }
    },
  );
});
