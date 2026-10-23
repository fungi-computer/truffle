import {
  closeSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  establishLocalSandbox,
  type SandboxCommand,
} from "../src/private-local-containment.js";
import {
  localAgentFolderSchema,
  resolveAgentFolder,
  sandboxPolicy,
} from "../src/private-local-sandbox-policy.js";
import { linuxSandboxCommand } from "../src/private-local-linux-sandbox.js";
import { createLocalSandboxControls } from "../src/private-local-sandbox.js";
import { createPrivateInvocationFilesPort } from "../src/private-invocation-files.js";

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
      // Without checkout pruning these 66 payload directories alone exceed it.
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
        expect(() => sandboxPolicy(project, folder, 64)).toThrow(
          "Sandbox Git discovery exceeds 64 directories",
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
        const protectedFiles = gitDirs.flatMap((git) => [
          join(git, "hooks", "post-checkout"),
          join(git, "config"),
          join(git, "config.worktree"),
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
