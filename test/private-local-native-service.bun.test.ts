import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { sleep } from "bun";
import { createModels } from "@earendil-works/pi-ai";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { capturePrivateLocalConfigRoot } from "../dist/private-local-config-root.js";
import { openPrivateLocalRuntimeHost } from "../dist/private-local-runtime-host.js";
import {
  readServiceRecord,
  serviceDirectory,
} from "../dist/private-local-service-discovery.js";
import { runPrivateLocalService } from "../dist/private-local-service-listener.js";
import { createPrivateLocalServiceManager } from "../dist/private-local-service.js";

const nativeNames = [
  "fungi-apply-patch",
  "fungi-bwrap",
  "fungi-seccomp.bpf",
  "fungi-seccomp-workspace.bpf",
];

/** All paths, executable bytes and environment are disposable; never launch fungi. */
async function isolatedInstall() {
  const root = await mkdtemp(join(tmpdir(), "fungi-native-service-"));
  const home = join(root, "home");
  const runtime = join(root, "runtime");
  const install = join(root, "install");
  const source = join(import.meta.dir, "..", "native", "bin");
  const packageBin = join(
    install,
    "node_modules",
    "@fungi.computer",
    `spore-native-${process.platform}-${process.arch}`,
    "bin",
  );
  await mkdir(home);
  await mkdir(runtime, { mode: 0o700 });
  await mkdir(packageBin, { recursive: true });
  for (const name of nativeNames)
    await copyFile(join(source, name), join(packageBin, name));
  await mkdir(join(install, "dist"));
  const cli = join(install, "dist", "cli.js");
  await writeFile(
    cli,
    `if (process.argv[2] !== '--internal-service') throw new Error('Not the service');\nprocess.argv.splice(2, 1);\nawait import(${JSON.stringify(new URL("../dist/private-local-service-process.js", import.meta.url).href)});\n`,
  );
  // Synthetic installed Spore release: no Local test imports the TUI manifest.
  const version = "0.4.0";
  await writeFile(
    join(install, "package.json"),
    JSON.stringify({ name: "@fungi.computer/spore", version }),
  );
  const saved = new Map(
    [
      "HOME",
      "XDG_RUNTIME_DIR",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_DATA_HOME",
      "FUNGI_BUNDLED_CLI",
      "FUNGI_SPORE_VERSION",
      "FUNGI_LAUNCHER",
    ].map((key) => [key, process.env[key]]),
  );
  process.env.HOME = home;
  process.env.XDG_RUNTIME_DIR = runtime;
  process.env.XDG_CONFIG_HOME = join(home, "config");
  process.env.XDG_CACHE_HOME = join(home, "cache");
  process.env.XDG_DATA_HOME = join(home, "data");
  process.env.FUNGI_BUNDLED_CLI = cli;
  process.env.FUNGI_SPORE_VERSION = version;
  delete process.env.FUNGI_LAUNCHER;
  const configRoot = capturePrivateLocalConfigRoot(home);
  const directory = await serviceDirectory(configRoot.serviceDirectory);
  const patch = join(packageBin, "fungi-apply-patch");
  return {
    root,
    runtime,
    directory,
    patch,
    packageBin,
    version,
    configRoot,
    async staged() {
      const names = await readdir(join(runtime, "fungi"));
      return names.filter((name) => name.startsWith("native-"));
    },
    async close() {
      for (const [key, value] of saved) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const failure of ["missing", "mismatched"] as const)
  it.skipIf(process.platform !== "linux")(
    `real Local startup refuses a ${failure} native package before discovery, even without selecting a sandbox mode`,
    async () => {
      const fixture = await isolatedInstall();
      try {
        if (failure === "missing")
          await rm(join(fixture.packageBin, ".."), { recursive: true });
        else await writeFile(fixture.patch, "tampered native executable");
        await assert.rejects(
          runPrivateLocalService(
            fixture.directory,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            fixture.configRoot,
          ),
          (cause: unknown) => {
            assert.ok(cause instanceof Error);
            assert.equal(
              cause.message,
              `Fungi's native package for ${process.platform}-${process.arch} is missing or doesn't match this version. Reinstall: npm i -g @fungi.computer/spore@${fixture.version}`,
            );
            return true;
          },
        );
        expect(await readServiceRecord(fixture.directory)).toBeUndefined();
        expect(existsSync(join(fixture.directory, "owner.lock"))).toBe(false);
        expect(existsSync(join(fixture.runtime, "fungi"))).toBe(false);
      } finally {
        await fixture.close();
      }
    },
  );

for (const failure of ["missing", "mismatched"] as const)
  it.skipIf(process.platform !== "linux")(
    `detached service start reports a ${failure} native package to its caller`,
    async () => {
      const fixture = await isolatedInstall();
      try {
        if (failure === "missing")
          await rm(join(fixture.packageBin, ".."), { recursive: true });
        else await writeFile(fixture.patch, "tampered native executable");
        await assert.rejects(
          createPrivateLocalServiceManager({
            home: join(fixture.root, "home"),
            directory: fixture.directory,
            executable: process.execPath,
          }).start(),
          (cause: unknown) => {
            assert.ok(cause instanceof Error);
            assert.equal(
              cause.message,
              `Fungi's native package for ${process.platform}-${process.arch} is missing or doesn't match this version. Reinstall: npm i -g @fungi.computer/spore@${fixture.version}`,
            );
            return true;
          },
        );
        expect(await readServiceRecord(fixture.directory)).toBeUndefined();
        expect(
          (await readdir(fixture.directory)).filter((name) =>
            name.startsWith(".native-startup-refusal-"),
          ),
        ).toEqual([]);
      } finally {
        await fixture.close();
      }
    },
  );

it.skipIf(process.platform !== "linux")(
  "one service-owned native copy survives two Agents and is removed at service stop",
  async () => {
    const fixture = await isolatedInstall();
    const models = createModels();
    const provider = fauxProvider({
      provider: "native-once-service",
      models: [{ id: "native-once-model" }],
    });
    models.setProvider(provider.provider);
    const running = runPrivateLocalService(
      fixture.directory,
      (options) =>
        openPrivateLocalRuntimeHost(
          {
            ...options,
            providerId: "native-once-service",
            modelId: "native-once-model",
          },
          models,
        ),
      undefined,
      undefined,
      undefined,
      undefined,
      fixture.configRoot,
    );
    let published = false;
    let signaled = false;
    try {
      let record;
      for (let attempt = 0; attempt < 200; attempt++) {
        record = await readServiceRecord(fixture.directory);
        if (record !== undefined) break;
        await sleep(25);
      }
      assert.ok(record, "Real Local service never published discovery");
      published = true;
      const stage = await fixture.staged();
      expect(stage).toHaveLength(1);
      const staged = stage[0];
      assert.ok(staged);
      const stagedPatch = join(
        fixture.runtime,
        "fungi",
        staged,
        "fungi-apply-patch",
      );
      expect(existsSync(stagedPatch)).toBe(true);
      // Changing the installed bytes now cannot change the verified service copy.
      await writeFile(fixture.patch, "tampered after service start");
      const manager = createPrivateLocalServiceManager({
        directory: fixture.directory,
        home: fixture.configRoot.home,
      });
      for (const name of ["first", "second"]) {
        const project = join(fixture.root, name);
        await mkdir(join(project, ".git"), { recursive: true });
        const connection = await manager.connect({
          invocationRoot: project,
          mode: "workspace",
        });
        try {
          expect(await connection.sandboxStatus()).toMatchObject({
            mode: "workspace",
            available: true,
          });
          expect(await fixture.staged()).toEqual(stage);
          expect(existsSync(stagedPatch)).toBe(true);
        } finally {
          await connection.close();
        }
      }
      signaled = true;
      process.emit("SIGTERM", "SIGTERM");
      await running;
      expect(existsSync(stagedPatch)).toBe(false);
      expect(await fixture.staged()).toEqual([]);
      expect(await readServiceRecord(fixture.directory)).toBeUndefined();
    } finally {
      if (published && !signaled) process.emit("SIGTERM", "SIGTERM");
      try {
        await running;
      } finally {
        await fixture.close();
      }
    }
  },
  30_000,
);
