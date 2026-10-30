import {
  closeSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import {
  establishLocalSandbox,
  LocalSandboxUnavailable,
  type SandboxCommand,
} from "../src/private-local-containment.js";
import {
  sandboxPolicy,
  linuxSandboxProfile,
} from "../src/private-local-sandbox-policy.js";
import { linuxSandboxCommand } from "../src/private-local-linux-sandbox.js";
import { createLocalSandboxControls } from "../src/private-local-sandbox.js";
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

// Native sandbox qualification: real startup probes and contained processes.
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
  120_000,
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
      expect(readFileSync(rules, "utf8")).toBe('{"version":1,"prefixes":[]}\n');
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
