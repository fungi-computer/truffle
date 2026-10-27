import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "bun:test";
import { sleep, spawn, type Subprocess } from "bun";
import { z } from "zod";
import { upgradeLocalHome } from "../src/local-upgrade.js";
import {
  privateLocalServiceVersion,
  readServiceRegistration,
  serviceDirectory,
} from "../src/private-local-service-discovery.js";

const fixture = join(import.meta.dir, "fixtures", "other-protocol-service.ts");
const children: Subprocess[] = [];
let home: string | undefined;
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    await child.exited;
  }
  if (home !== undefined) await rm(home, { recursive: true, force: true });
  home = undefined;
});

it("stops a live protocol-3 lease and removes its record before archiving anything", async () => {
  home = await mkdtemp(join(tmpdir(), "fungi-upgrade-stop-"));
  const directory = await serviceDirectory(join(home, ".fungi", "service"));
  const child = spawn([process.execPath, fixture, directory], {
    env: { ...process.env, HOME: home },
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(child);
  let registration;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    registration = await readServiceRegistration(directory);
    if (registration !== undefined) break;
    await sleep(25);
  }
  expect(registration?.kind).toBe("other-protocol");
  const recordPath = join(directory, "service.json");
  const record = z
    .looseObject({ protocol: z.number(), version: z.string() })
    .parse(JSON.parse(await readFile(recordPath, "utf8")));
  record.protocol = 3;
  record.version = "9".repeat(64);
  await writeFile(recordPath, JSON.stringify(record));
  const upgradeHome = home;
  const newsPath = join(home, "whats-new.json");
  await writeFile(newsPath, JSON.stringify({ release: "0.4.1", lines: [] }));

  await assert.rejects(
    () =>
      upgradeLocalHome({
        home: upgradeHome,
        newsPath,
        spore: "0.3.1",
        installedClientBuildId: () => Promise.resolve("a".repeat(64)),
      }),
    /Restart this window/u,
  );
  expect(child.exitCode).toBeNull();
  const outcome = await upgradeLocalHome({
    home,
    newsPath,
    spore: "0.3.1",
    installedClientBuildId: () => Promise.resolve(privateLocalServiceVersion()),
  });
  expect(outcome.kind).toBe("upgraded");
  if (outcome.kind !== "upgraded") throw new Error("upgrade did not complete");
  expect(outcome.report.from).toEqual({
    kind: "protocol",
    protocol: 3,
    build: "9".repeat(64),
  });
  expect(outcome.report.service).toBe("stopped");
  expect(outcome.report.archive).toBeUndefined();
  await child.exited;
  expect(await readServiceRegistration(directory)).toBeUndefined();
});

it("does not stop the current service on every invocation of a markerless home", async () => {
  home = await mkdtemp(join(tmpdir(), "fungi-upgrade-current-"));
  const directory = await serviceDirectory(join(home, ".fungi", "service"));
  const child = spawn([process.execPath, fixture, directory], {
    env: { ...process.env, HOME: home },
    stdout: "ignore",
    stderr: "ignore",
  });
  children.push(child);
  let registration;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    registration = await readServiceRegistration(directory);
    if (registration !== undefined) break;
    await sleep(25);
  }
  expect(registration?.kind).toBe("other-protocol");
  const recordPath = join(directory, "service.json");
  const record = z
    .looseObject({
      protocol: z.number(),
      version: z.string(),
    })
    .parse(JSON.parse(await readFile(recordPath, "utf8")));
  record.protocol = 4;
  record.version = privateLocalServiceVersion();
  record.baseUrl = "http://127.0.0.1:12345/";
  delete record.endpoint;
  await writeFile(recordPath, JSON.stringify(record));
  expect(
    await upgradeLocalHome({
      home,
      newsPath: join(home, "absent-news.json"),
      spore: "0.3.1",
    }),
  ).toEqual({ kind: "current" });
  expect(child.exitCode).toBeNull();
  expect((await readServiceRegistration(directory))?.kind).toBe("current");
});
