import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { serve, sleep, spawn, type Subprocess } from "bun";

import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import { localServiceIds } from "../src/private-local-service-ids.js";
import { readProcessStart } from "../src/private-local-process-identity.js";
import { readServiceLeaseOwner } from "../src/private-local-service-lease.js";
import {
  acquireServiceLock,
  privateLocalServiceProtocol,
  readServiceRegistration,
  serviceDirectory,
} from "../src/private-local-service-discovery.js";
import { becomeCurrentInstalledClient } from "./fixtures/current-installed-client.js";

const otherProtocolService = join(
  import.meta.dir,
  "fixtures",
  "other-protocol-service.ts",
);

let home: string;
let directory: string;
let stranger: Subprocess;
let restoreClient: () => void;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "fungi-identity-"));
  directory = await serviceDirectory(join(home, ".fungi", "service"));
  // Replacement, and so its lease identity check, belongs to the installed
  // client; a stale window asks to restart before reaching it.
  restoreClient = await becomeCurrentInstalledClient(home);
  // An unrelated process that now holds a PID a stale record names.
  stranger = spawn(["sleep", "60"], { stdout: "ignore", stderr: "ignore" });
});

afterEach(async () => {
  restoreClient();
  stranger.kill("SIGKILL");
  await stranger.exited;
  await rm(home, { recursive: true, force: true });
});

/** The stranger is untouched: still running, never signalled. */
async function expectStrangerUntouched() {
  await Promise.race([stranger.exited, delay(200)]);
  expect(stranger.exitCode).toBeNull();
  expect(stranger.signalCode).toBeNull();
}

describe("fungi stop signals only the verified lease owner", () => {
  it("refuses a forged record naming a live stranger's real PID and start while another process owns the lease", async () => {
    const start = await readProcessStart(stranger.pid);
    if (start.kind !== "running") throw new Error("stranger did not start");
    const release = await acquireServiceLock(directory, "owner");
    try {
      const ownStart = await readProcessStart(process.pid);
      if (ownStart.kind !== "running") throw new Error("owner did not start");
      expect(await readServiceLeaseOwner(directory)).toEqual({
        pid: process.pid,
        startedAt: ownStart.start,
      });
      await writeFile(
        join(directory, "service.json"),
        JSON.stringify({
          protocol: privateLocalServiceProtocol + 1,
          version: "forged",
          serviceId: localServiceIds.service.generate(),
          pid: stranger.pid,
          startedAt: start.start,
        }),
      );
      const manager = createPrivateLocalServiceManager({
        directory,
        executable: join(directory, "must-not-spawn"),
      });
      for (const attempt of [() => manager.stop(), () => manager.start()])
        await assert.rejects(attempt(), /lease owner.*does not match/u);
      await expectStrangerUntouched();
    } finally {
      await release();
    }
  }, 20_000);

  it("never signals a stranger that reused a stale record's PID while a starting service holds the lease", async () => {
    await writeFile(
      join(directory, "service.json"),
      JSON.stringify({
        protocol: privateLocalServiceProtocol + 1,
        version: "a-later-release",
        serviceId: localServiceIds.service.generate(),
        pid: stranger.pid,
        // When the recorded service, long gone, started.
        startedAt: "linux:1",
      }),
    );
    // A successor takes the lease before it publishes its own record.
    const successor = await acquireServiceLock(directory, "owner");
    try {
      const manager = createPrivateLocalServiceManager({
        directory,
        executable: join(directory, "must-not-spawn"),
      });
      for (const attempt of [() => manager.start(), () => manager.stop()])
        await assert.rejects(attempt(), /lease owner.*does not match/u);
      await expectStrangerUntouched();
    } finally {
      await successor();
    }
    // With no owner left, the stale record is only cleaned up.
    expect(
      await createPrivateLocalServiceManager({ directory }).stop(),
    ).toEqual({ kind: "not-running", recordCleaned: true });
    await expectStrangerUntouched();
  });

  it("never signals a stranger whose PID a handshake claims with another start time", async () => {
    const serviceId = localServiceIds.service.generate();
    const server = serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (): Response =>
        Response.json({ ...record, diagnostics: { state: "active" } }),
    });
    const record = {
      protocol: privateLocalServiceProtocol,
      version: "source",
      serviceId,
      pid: stranger.pid,
      startedAt: "linux:1",
      baseUrl: server.url.origin,
    };
    await writeFile(join(directory, "service.json"), JSON.stringify(record));
    try {
      expect(
        await createPrivateLocalServiceManager({ directory }).stop(),
      ).toEqual({ kind: "not-running", recordCleaned: true });
      await expectStrangerUntouched();
    } finally {
      await server.stop(true);
    }
  });

  for (const protocol of [
    privateLocalServiceProtocol,
    privateLocalServiceProtocol + 1,
  ]) {
    it(`does not trust a real stranger start without a lease owner (protocol ${String(protocol)})`, async () => {
      const start = await readProcessStart(stranger.pid);
      if (start.kind !== "running") throw new Error("stranger did not start");
      const server = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (): Response =>
          Response.json({ ...record, diagnostics: { state: "active" } }),
      });
      const record = {
        protocol,
        version: "source",
        serviceId: localServiceIds.service.generate(),
        pid: stranger.pid,
        startedAt: start.start,
        baseUrl: server.url.origin,
      };
      try {
        await writeFile(
          join(directory, "service.json"),
          JSON.stringify(record),
        );
        expect(
          await createPrivateLocalServiceManager({ directory }).stop(),
        ).toEqual({
          kind: "not-running",
          recordCleaned: true,
        });
        await expectStrangerUntouched();
      } finally {
        await server.stop(true);
      }
    });
  }

  it("refuses uncorroborated service argv on macOS, then stops the verified owner on Linux", async () => {
    const owner = spawn([process.execPath, otherProtocolService, directory], {
      stdout: "inherit",
      stderr: "inherit",
    });
    try {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (
          (await readServiceRegistration(directory))?.kind === "other-protocol"
        )
          break;
        await sleep(25);
      }
      const start = await readProcessStart(owner.pid);
      expect(start.kind).toBe("running");
      const macClient = spawn(
        [
          process.execPath,
          join(import.meta.dir, "fixtures", "refuse-macos-stop.ts"),
          directory,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect({
        exitCode: await macClient.exited,
        stdout: await new Response(macClient.stdout).text(),
        stderr: await new Response(macClient.stderr).text(),
      }).toEqual({ exitCode: 0, stdout: "", stderr: "" });
      expect(owner.exitCode).toBeNull();
      expect(owner.signalCode).toBeNull();
      const registration = await readServiceRegistration(directory);
      if (registration?.kind !== "other-protocol")
        throw new Error("owner did not register");
      // A file and HTTP response cannot grant authority; nor does a failed
      // HTTP probe revoke the verified live lease owner's identity.
      await writeFile(
        join(directory, "service.json"),
        JSON.stringify({
          serviceId: registration.lifecycle.serviceId,
          pid: registration.lifecycle.pid,
          startedAt: registration.lifecycle.startedAt,
          protocol: privateLocalServiceProtocol,
          version: "source",
          baseUrl: "http://127.0.0.1:9",
        }),
      );
      expect(
        await createPrivateLocalServiceManager({ directory }).stop(),
      ).toEqual({ kind: "stopped" });
      await owner.exited;
      expect(owner.exitCode).toBe(0);
      expect(await readServiceRegistration(directory)).toBeUndefined();
      await expectStrangerUntouched();
    } finally {
      owner.kill("SIGKILL");
      await owner.exited;
    }
  }, 30_000);

  for (const mode of ["identity", "stop"] as const) {
    it(`corroborates a macOS service and recognizes its exit (${mode})`, async () => {
      const client = spawn(
        [
          process.execPath,
          join(import.meta.dir, "fixtures", "macos-service-exit.ts"),
          directory,
          mode,
        ],
        { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
      );
      const result = {
        exitCode: await client.exited,
        stdout: await new Response(client.stdout).text(),
        stderr: await new Response(client.stderr).text(),
      };
      expect(result).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    }, 30_000);
  }
});
