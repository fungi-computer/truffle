import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  createLocalSandboxControls,
  probeLocalSandbox,
} from "../src/private-local-sandbox.js";
import { LocalSandboxUnavailable } from "../src/private-local-containment.js";
import { createNativePayloadStaging } from "../src/private-local-native-staging.js";
import {
  linuxSandboxProfile,
  sandboxPolicy,
} from "../src/private-local-sandbox-policy.js";

it.runIf(process.platform === "linux")(
  "one service copy survives Agent and probe cleanup until its own close",
  () => {
    const first = mkdtempSync(join(tmpdir(), "fungi-native-agent-"));
    const second = mkdtempSync(join(tmpdir(), "fungi-native-agent-"));
    const projects = [first, second];
    const runtime = mkdtempSync(join(tmpdir(), "fungi-native-service-"));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtime;
    for (const project of projects) mkdirSync(join(project, "agent"));
    let owner: ReturnType<typeof createNativePayloadStaging> | undefined;
    let controls: ReturnType<typeof createLocalSandboxControls> | undefined;
    try {
      owner = createNativePayloadStaging(first);
      const shared = owner;
      expect(probeLocalSandbox(second, "agent", shared)).toBeUndefined();
      controls = createLocalSandboxControls({
        project: first,
        folder: "agent",
        mode: () => "workspace",
        native: shared,
      });
      const agent2 = createLocalSandboxControls({
        project: second,
        folder: "agent",
        mode: () => "workspace",
        native: shared,
      });
      try {
        const firstExecutable = controls.launch(join(first, "agent"), [
          "/usr/bin/true",
        ])?.executable;
        const secondExecutable = agent2.launch(join(second, "agent"), [
          "/usr/bin/true",
        ])?.executable;
        if (secondExecutable === undefined)
          throw new Error("Workspace must launch through the shared copy");
        expect(firstExecutable).toBe(secondExecutable);
        controls.close();
        expect(existsSync(secondExecutable)).toBe(true);
        expect(
          agent2.launch(join(second, "agent"), ["/usr/bin/true"])?.executable,
        ).toBe(secondExecutable);
        shared.close();
        expect(existsSync(secondExecutable)).toBe(false);
      } finally {
        agent2.close();
      }
    } finally {
      controls?.close();
      owner?.close();
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      for (const project of projects) rmSync(project, { recursive: true });
      rmSync(runtime, { recursive: true });
    }
  },
);

it.runIf(process.platform === "linux")(
  "failed Agent admission cleans its temp without closing the shared native copy",
  () => {
    const first = mkdtempSync(join(tmpdir(), "fungi-native-owner-"));
    const runtime = mkdtempSync(join(tmpdir(), "fungi-native-runtime-"));
    const otherRuntime = mkdtempSync(join(tmpdir(), "fungi-native-other-"));
    mkdirSync(join(first, "agent"));
    mkdirSync(join(runtime, "agent"));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtime;
    let owner: ReturnType<typeof createNativePayloadStaging> | undefined;
    try {
      owner = createNativePayloadStaging(first);
      const policy = linuxSandboxProfile(
        sandboxPolicy(first, join(first, "agent")),
        "workspace",
        join(first, "agent"),
        { HOME: join(first, "home") },
        join(first, "home"),
      );
      const executable = owner.linux(policy).executable;
      process.env.XDG_RUNTIME_DIR = otherRuntime;
      expect(() =>
        createLocalSandboxControls({
          project: runtime,
          folder: "agent",
          mode: () => "workspace",
          native: owner,
        }),
      ).toThrow(/Native files must be outside the Agent project/u);
      expect(existsSync(executable)).toBe(true);
      expect(readdirSync(join(otherRuntime, "fungi", "tmp"))).toEqual([]);
      owner.close();
      expect(existsSync(executable)).toBe(false);
    } finally {
      owner?.close();
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      for (const path of [first, runtime, otherRuntime])
        rmSync(path, { recursive: true });
    }
  },
);

it.runIf(process.platform === "linux")(
  "verifies installed native bytes at owner creation and never rereads them on commands",
  () => {
    const project = mkdtempSync(join(tmpdir(), "fungi-native-once-"));
    const agent = join(project, "agent");
    mkdirSync(agent);
    const runtime = mkdtempSync(join(tmpdir(), "fungi-native-once-runtime-"));
    const previous = process.env.XDG_RUNTIME_DIR;
    process.env.XDG_RUNTIME_DIR = runtime;
    let reads = 0;
    try {
      const owner = createNativePayloadStaging(project, (path) => {
        reads += 1;
        return readFileSync(path);
      });
      try {
        const atStartup = reads;
        expect(atStartup).toBeGreaterThanOrEqual(4);
        const sandbox = sandboxPolicy(project, agent);
        const modes: readonly ("workspace" | "read-only")[] = [
          "workspace",
          "read-only",
        ];
        for (const mode of modes) {
          const profile = linuxSandboxProfile(
            sandbox,
            mode,
            runtime,
            { HOME: join(project, "home") },
            join(project, "home"),
          );
          for (let index = 0; index < 3; index++) {
            const payload = owner.linux(profile);
            expect(payload.executable).toContain("fungi-bwrap");
            owner.probeFilter(payload.seccompFilter);
          }
        }
        expect(reads).toBe(atStartup);
      } finally {
        owner.close();
      }
    } finally {
      if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previous;
      rmSync(project, { recursive: true });
      rmSync(runtime, { recursive: true });
    }
  },
);

it.runIf(process.platform === "linux")(
  "refuses tampered packaged native bytes before the owner can serve a command",
  () => {
    const project = mkdtempSync(join(tmpdir(), "fungi-native-tamper-"));
    const install = mkdtempSync(join(tmpdir(), "fungi-native-install-"));
    const agent = join(project, "agent");
    mkdirSync(agent);
    const bin = join(
      install,
      "node_modules",
      `@fungi.computer/spore-native-${process.platform}-${process.arch}`,
      "bin",
    );
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
    writeFileSync(join(bin, "fungi-seccomp.bpf"), "tampered");
    const cli = join(install, "cli.cjs");
    writeFileSync(cli, "");
    const previous = process.env.FUNGI_BUNDLED_CLI;
    process.env.FUNGI_BUNDLED_CLI = cli;
    try {
      expect(() => createNativePayloadStaging(project)).toThrow(
        /fungi-seccomp.bpf digest mismatch/,
      );
    } finally {
      if (previous === undefined) delete process.env.FUNGI_BUNDLED_CLI;
      else process.env.FUNGI_BUNDLED_CLI = previous;
      rmSync(project, { recursive: true });
      rmSync(install, { recursive: true });
    }
  },
);

it.runIf(process.platform === "linux")(
  "unsupported Workspace refuses before Files can stage or execute a native helper",
  () => {
    const project = mkdtempSync(join(tmpdir(), "fungi-native-read-project-"));
    const install = mkdtempSync(join(tmpdir(), "fungi-native-read-install-"));
    const runtime = mkdtempSync(join(tmpdir(), "fungi-native-read-runtime-"));
    const previousCli = process.env.FUNGI_BUNDLED_CLI;
    const previousRuntime = process.env.XDG_RUNTIME_DIR;
    let sourceReads = 0;
    try {
      const folder = join(project, "agent");
      mkdirSync(folder);
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
      process.env.FUNGI_BUNDLED_CLI = cli;
      process.env.XDG_RUNTIME_DIR = runtime;
      expect(() =>
        createLocalSandboxControls({
          project,
          folder: "agent",
          mode: () => "workspace",
          platform: "unsupported",
          readNativePatchSource: (path) => {
            if (path === helper) sourceReads += 1;
            throw new Error("Unsupported backend must not read native helper");
          },
        }),
      ).toThrow(LocalSandboxUnavailable);
      expect(sourceReads).toBe(0);
    } finally {
      if (previousCli === undefined) delete process.env.FUNGI_BUNDLED_CLI;
      else process.env.FUNGI_BUNDLED_CLI = previousCli;
      if (previousRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
      else process.env.XDG_RUNTIME_DIR = previousRuntime;
      for (const path of [project, install, runtime])
        rmSync(path, { recursive: true });
    }
  },
);
