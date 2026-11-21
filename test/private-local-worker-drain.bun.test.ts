import { stat } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "bun:test";
import { sleep, spawn } from "bun";
import {
  readServiceRecord,
  serviceDirectory,
} from "../src/private-local-service-discovery.js";

const fixture = join(import.meta.dir, "fixtures", "worker-drain-service.ts");

async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return false;
    throw cause;
  }
}

it("SIGTERM drains the service, removing its record and lease, while a sandbox is alive", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-worker-drain-"));
  const directory = await serviceDirectory(join(home, ".fungi", "service"));
  const child = spawn([process.execPath, fixture, directory], {
    env: { ...process.env, HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  try {
    for (
      let attempt = 0;
      attempt < 400 && (await readServiceRecord(directory)) === undefined;
      attempt += 1
    )
      await sleep(25);
    expect(await readServiceRecord(directory)).toBeDefined();
    child.kill("SIGTERM");
    const code = await child.exited;
    expect({ code, stderr: await stderr }).toMatchObject({ code: 0 });
    expect(await readServiceRecord(directory)).toBeUndefined();
    expect(await exists(join(directory, "owner.lock"))).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

it("SIGTERM before the listener is ready still drains it, leaving no record or lease", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-worker-early-stop-"));
  const directory = await serviceDirectory(join(home, ".fungi", "service"));
  const child = spawn([process.execPath, fixture, directory], {
    env: { ...process.env, HOME: home, FIXTURE_START_DELAY_MS: "1500" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new Response(child.stderr).text();
  try {
    // The worker has loaded and is holding the listener back; no record exists.
    for (
      let attempt = 0;
      attempt < 400 && !(await exists(join(directory, "..", "starting")));
      attempt += 1
    )
      await sleep(25);
    expect(await readServiceRecord(directory)).toBeUndefined();
    child.kill("SIGTERM");
    const code = await Promise.race([child.exited, sleep(20_000)]);
    expect({ code, stderr: code === 0 ? "" : await stderr }).toMatchObject({
      code: 0,
    });
    expect(await readServiceRecord(directory)).toBeUndefined();
    expect(await exists(join(directory, "owner.lock"))).toBe(false);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    await rm(home, { recursive: true, force: true });
  }
}, 40_000);
