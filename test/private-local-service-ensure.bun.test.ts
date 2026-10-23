import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sleep, spawn, spawnSync, type Subprocess } from "bun";

import {
  createPrivateLocalServiceManager,
  LocalServiceUpdated,
} from "../src/private-local-service.js";
import {
  acquireServiceLock,
  readServiceRegistration,
  serviceDirectory,
} from "../src/private-local-service-discovery.js";

const sourceService = join(
  import.meta.dir,
  "..",
  "src",
  "private-local-service-process.ts",
);
const otherProtocolService = join(
  import.meta.dir,
  "fixtures",
  "other-protocol-service.ts",
);
const olderBuild = "a".repeat(64);

async function installedPrefix() {
  const prefix = join(home, "prefix");
  const bin = join(prefix, "bin");
  const dist = join(prefix, "dist");
  const temporary = join(home, "tmp");
  await Promise.all([
    mkdir(bin, { recursive: true }),
    mkdir(dist, { recursive: true }),
    mkdir(temporary),
  ]);
  const launcher = join(dist, "fungi.cjs");
  const cli = join(dist, "cli.js");
  // The installed-build reader keys on this launcher's name and its adjacent
  // cli.js; it never runs the launcher. Keep TUI's launcher out of Local tests.
  await writeFile(
    launcher,
    '#!/usr/bin/env node\nthrow new Error("fixture launcher is never run");\n',
    { mode: 0o755 },
  );
  await symlink(launcher, join(bin, "fungi"));
  const fixture = pathToFileURL(
    join(import.meta.dir, "fixtures/installed-service-client.ts"),
  ).href;
  const install = async (build: string) => {
    await writeFile(
      cli,
      `import { run } from ${JSON.stringify(fixture)};\nawait run();\n// ${build}\n`,
    );
    return createHash("sha256")
      .update(await readFile(cli))
      .digest("hex");
  };
  const env = {
    ...process.env,
    HOME: home,
    TMPDIR: temporary,
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_CACHE_HOME: join(home, "cache"),
    XDG_DATA_HOME: join(home, "data"),
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    FUNGI_LAUNCHER: launcher,
  };
  let clientCount = 0;
  const client = async (mode = "fresh") => {
    const ready = join(home, `client-ready-${String(clientCount++)}`);
    const child = spawn([process.execPath, cli, directory, ready, mode], {
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
    });
    children.push(child);
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (await Bun.file(ready).exists()) return child;
      if (child.exitCode !== null)
        throw new Error("Installed fixture client exited before admission");
      await sleep(25);
    }
    throw new Error("Installed fixture client did not capture its identity");
  };
  return { cli, env, install, client };
}

let home: string;
let directory: string;
let previousHome: string | undefined;
let clientVersion: string;
let installed: Awaited<ReturnType<typeof installedPrefix>>;
const previousEnvironment = new Map<string, string | undefined>();
const children: Subprocess[] = [];

beforeEach(async () => {
  // Every service these tests start, directly or through ensure, runs in a
  // throwaway HOME with its own installed prefix.
  home = await mkdtemp(join(tmpdir(), "fungi-ensure-home-"));
  directory = await serviceDirectory(join(home, ".fungi", "service"));
  previousHome = process.env.HOME;
  for (const key of [
    "FUNGI_BUNDLED_BUILD_ID",
    "FUNGI_BUNDLED_CLI",
    "FUNGI_LAUNCHER",
    "PATH",
  ])
    previousEnvironment.set(key, process.env[key]);
  process.env.HOME = home;
  delete process.env.FUNGI_BUNDLED_BUILD_ID;
  installed = await installedPrefix();
  clientVersion = await installed.install("current installed entry");
  process.env.FUNGI_BUNDLED_BUILD_ID = clientVersion;
  process.env.FUNGI_BUNDLED_CLI = installed.cli;
  process.env.FUNGI_LAUNCHER = installed.env.FUNGI_LAUNCHER;
  process.env.PATH = installed.env.PATH;
});

afterEach(async () => {
  try {
    await createPrivateLocalServiceManager({ directory }).stop();
  } finally {
    for (const child of children.splice(0)) {
      child.kill("SIGKILL");
      await child.exited;
    }
    process.env.HOME = previousHome;
    for (const [key, value] of previousEnvironment) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    previousEnvironment.clear();
    await rm(home, { recursive: true, force: true });
  }
});

/** Start a service process directly, as another client's build would. */
async function startOtherService(
  entry: string,
  env: Record<string, string> = {},
) {
  const child = spawn([process.execPath, entry, directory], {
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  children.push(child);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const registration = await readServiceRegistration(directory);
    if (registration !== undefined && registration.kind !== "unidentified")
      return { child, registration };
    await sleep(25);
  }
  throw new Error("The other service did not register");
}

describe("every client start ensures a service of its own build", () => {
  it("a stale loaded client never stops the service matching the installed launcher and asks to restart its window", async () => {
    await installed.install("previous installed entry");
    const stale = await installed.client();
    const installedVersion = await installed.install("current installed entry");
    const running = await startOtherService(sourceService, {
      ...installed.env,
      FUNGI_BUNDLED_BUILD_ID: installedVersion,
    });
    await stale.stdin.write("ensure\n");
    await stale.stdin.end();
    const result = z
      .object({ kind: z.string(), message: z.string().optional() })
      .parse(await new Response(stale.stdout).json());
    await stale.exited;
    expect(result).toMatchObject({
      kind: "updated",
      message: "The Fungi service was updated. Restart this window.",
    });
    expect(running.child.exitCode).toBeNull();
    expect(await readServiceRegistration(directory)).toEqual(
      running.registration,
    );
  }, 30_000);

  it("the current installed client still replaces a service belonging to the previous installed entry", async () => {
    const previousVersion = await installed.install("previous installed entry");
    const previous = await startOtherService(sourceService, {
      ...installed.env,
      FUNGI_BUNDLED_BUILD_ID: previousVersion,
    });
    const currentVersion = await installed.install("current installed entry");
    const current = await installed.client();
    await current.stdin.write("ensure\n");
    await current.stdin.end();
    const result = z
      .object({
        kind: z.literal("started"),
        service: z.object({
          version: z.string(),
          serviceId: z.string(),
          pid: z.number(),
        }),
      })
      .parse(await new Response(current.stdout).json());
    await current.exited;
    expect(result.service.version).toBe(currentVersion);
    expect(result.service.pid).not.toBe(previous.child.pid);
    await previous.child.exited;
    expect(await readServiceRegistration(directory)).toMatchObject({
      kind: "current",
      record: result.service,
    });
  }, 30_000);

  it("a previously connected stale client also asks to restart rather than accepting the installed replacement", async () => {
    await installed.install("previous installed entry");
    const stale = await installed.client("reached");
    const before = await readServiceRegistration(directory);
    const currentVersion = await installed.install("current installed entry");
    const current = await installed.client();
    await current.stdin.write("ensure\n");
    await current.stdin.end();
    const replacement = z
      .object({
        kind: z.literal("started"),
        service: z.object({ version: z.string(), serviceId: z.string() }),
      })
      .parse(await new Response(current.stdout).json());
    await current.exited;
    expect(replacement.service.version).toBe(currentVersion);
    expect(before?.kind).toBe("current");
    if (before?.kind === "current")
      expect(replacement.service.serviceId).not.toBe(before.record.serviceId);
    await stale.stdin.write("ensure\n");
    await stale.stdin.end();
    const result = z
      .object({ kind: z.string() })
      .parse(await new Response(stale.stdout).json());
    await stale.exited;
    expect(result.kind).toBe("updated");
    expect(await readServiceRegistration(directory)).toMatchObject({
      kind: "current",
      record: replacement.service,
    });
  }, 30_000);
  it("replaces a stale service (an older version in service.json) on start", async () => {
    const stale = await startOtherService(sourceService, {
      FUNGI_BUNDLED_BUILD_ID: olderBuild,
    });
    expect(stale.registration).toMatchObject({
      kind: "current",
      record: { version: olderBuild, pid: stale.child.pid },
    });
    const started = await createPrivateLocalServiceManager({
      directory,
    }).start();
    expect(started).toMatchObject({ protocol: 3, version: clientVersion });
    expect(started.pid).not.toBe(stale.child.pid);
    await stale.child.exited;
    expect(stale.child.signalCode).toBeNull();
    const registration = await readServiceRegistration(directory);
    expect(registration?.kind).toBe("current");
    // The live answer is the registration plus its mandatory diagnostics.
    if (registration?.kind === "current")
      expect(started).toEqual({
        ...registration.record,
        diagnostics: { state: "active" },
      });
  }, 30_000);

  it("reuses a service of this build: the same PID answers every client", async () => {
    const first = await createPrivateLocalServiceManager({ directory }).start();
    const second = await createPrivateLocalServiceManager({
      directory,
    }).start();
    expect(second).toEqual(first);
    expect(second.pid).not.toBe(process.pid);
  }, 30_000);

  it("two clients starting at once against a stale service make exactly one replacement, and both reach it", async () => {
    const stale = await startOtherService(sourceService, {
      FUNGI_BUNDLED_BUILD_ID: olderBuild,
    });
    const clients = [
      createPrivateLocalServiceManager({ directory }),
      createPrivateLocalServiceManager({ directory }),
    ];
    const [first, second] = await Promise.all(
      clients.map((client) => client.start()),
    );
    expect(second).toEqual(first);
    expect(first).toMatchObject({ version: clientVersion });
    expect(first?.pid).not.toBe(stale.child.pid);
    await stale.child.exited;
    // Exactly one service process serves this directory: the replacement.
    const serving = spawnSync(["pgrep", "-f", directory])
      .stdout.toString()
      .split("\n")
      .filter((line) => line !== "");
    expect(serving).toEqual([String(first?.pid)]);
    // Both clients go on to use it.
    const discovered = await Promise.all(
      clients.map((client) => client.discover(home)),
    );
    expect(discovered.map(({ sessions }) => sessions)).toEqual([[], []]);
    expect(await clients[1]?.status()).toEqual(first);
  }, 30_000);

  it("replaces a service of another protocol on start", async () => {
    const other = await startOtherService(otherProtocolService);
    expect(other.registration.kind).toBe("other-protocol");
    const started = await createPrivateLocalServiceManager({
      directory,
    }).start();
    expect(started).toMatchObject({ protocol: 3, version: clientVersion });
    await other.child.exited;
    expect(other.child.exitCode).toBe(0);
  }, 30_000);
});

describe("a running client", () => {
  it("meets a service of another protocol with exactly one restart message", async () => {
    const window = createPrivateLocalServiceManager({ directory });
    await window.start();
    // A later release's client replaces the service this window reached.
    expect(
      await createPrivateLocalServiceManager({ directory }).stop(),
    ).toEqual({ kind: "stopped" });
    await startOtherService(otherProtocolService);
    const restart = {
      name: new LocalServiceUpdated().name,
      message: "The Fungi service was updated. Restart this window.",
    };
    await assert.rejects(window.status(), restart);
    await assert.rejects(window.start(), restart);
    await assert.rejects(
      window.connect({ invocationRoot: home, sessionId: "main" }),
      restart,
    );
  }, 30_000);

  it("asks to restart instead of accepting another installed build with the same protocol", async () => {
    const window = createPrivateLocalServiceManager({ directory });
    await window.start();
    await createPrivateLocalServiceManager({ directory }).stop();
    const installedVersion = await installed.install("next installed entry");
    const replacement = await startOtherService(sourceService, {
      FUNGI_BUNDLED_BUILD_ID: installedVersion,
    });
    await assert.rejects(window.start(), new LocalServiceUpdated());
    expect(replacement.child.exitCode).toBeNull();
    expect(await readServiceRegistration(directory)).toEqual(
      replacement.registration,
    );
  }, 30_000);
});

describe("a service.json no protocol wrote", () => {
  it("is cleared when no service owns it, then replaced on start", async () => {
    await Bun.write(
      join(directory, "service.json"),
      JSON.stringify({
        serviceId: "pre-protocol",
        baseUrl: "http://127.0.0.1:9/",
      }),
    );
    const started = await createPrivateLocalServiceManager({
      directory,
    }).start();
    expect(started.version).toBe(clientVersion);
  }, 30_000);

  it("names the live owner it cannot identify instead of a decode error", async () => {
    await Bun.write(join(directory, "service.json"), "{ not json");
    const release = await acquireServiceLock(directory, "owner");
    try {
      await assert.rejects(
        createPrivateLocalServiceManager({ directory }).start(),
        /cannot identify.*End that Fungi service process/u,
      );
    } finally {
      await release();
    }
  });
});
