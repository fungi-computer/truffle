import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  readLocalUpgradeNews,
  readPriorInstall,
  upgradeLocalHome,
  writeLocalVersionMarker,
} from "../src/local-upgrade.js";
import { localServiceIds } from "../src/private-local-service-ids.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

it("requires a checked release label but treats invalid optional news as zero lines", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-news-reader-"));
  homes.push(home);
  const path = join(home, "whats-new.json");
  await writeFile(
    path,
    JSON.stringify({ release: "0.4.0", lines: ["x".repeat(121)] }),
  );
  expect(await readLocalUpgradeNews(path)).toEqual({
    release: "0.4.0",
    lines: [],
  });
  await writeFile(path, JSON.stringify({ lines: [] }));
  await expect(readLocalUpgradeNews(path)).rejects.toThrow();
});

it("starts an empty home without an upgrade artifact or marker", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-new-home-"));
  homes.push(home);
  expect(
    await upgradeLocalHome({
      home,
      newsPath: join(home, "missing-news.json"),
      spore: "0.4.1-rehearsal.0",
    }),
  ).toEqual({ kind: "current" });
  await expect(
    readFile(join(home, ".fungi", "version.json")),
  ).rejects.toMatchObject({ code: "ENOENT" });
});

it("orders a prerelease marker against checked news and the installed Spore", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-prerelease-upgrade-"));
  homes.push(home);
  const newsPath = join(home, "whats-new.json");
  const build = "a".repeat(64);
  await writeFile(newsPath, JSON.stringify({ release: "0.4.0", lines: [] }));
  await writeLocalVersionMarker(home, {
    release: "0.3.9-rc.1",
    spore: "0.2.1-candidate.2",
    build,
  });
  expect(
    (
      await upgradeLocalHome({
        home,
        newsPath,
        spore: "0.4.1-rehearsal.0",
      })
    ).kind,
  ).toBe("upgraded");
  expect(
    JSON.parse(await readFile(join(home, ".fungi", "version.json"), "utf8")),
  ).toMatchObject({ release: "0.4.0", spore: "0.4.1-rehearsal.0" });
});

it("accepts valid semver prereleases in a version marker", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-prerelease-marker-"));
  homes.push(home);
  await writeLocalVersionMarker(home, {
    release: "0.3.9-rc.1",
    spore: "0.4.1-rehearsal.0",
    build: "a".repeat(64),
  });
  await expect(readPriorInstall(home)).resolves.toEqual({
    kind: "recorded",
    release: "0.3.9-rc.1",
    spore: "0.4.1-rehearsal.0",
  });
});

it("refuses an invalid semver marker at its path without replacing it", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-invalid-marker-"));
  homes.push(home);
  const marker = join(home, ".fungi", "version.json");
  await mkdir(join(home, ".fungi"), { recursive: true });
  const invalid = JSON.stringify({
    version: 1,
    release: "0.4.0",
    spore: "0.3..0",
    build: "a".repeat(64),
  });
  await writeFile(marker, invalid);
  await expect(readPriorInstall(home)).rejects.toThrow(
    `Cannot read ${marker}: unsupported Fungi version marker`,
  );
  expect(await readFile(marker, "utf8")).toBe(invalid);
});

it("does not mistake the extension owner's archive for a home upgrade", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-extension-archive-home-"));
  homes.push(home);
  const archived = join(
    home,
    ".fungi",
    "archive",
    "unversioned",
    "extensions",
    "installed.json",
  );
  await mkdir(join(home, ".fungi", "archive", "unversioned", "extensions"), {
    recursive: true,
  });
  await writeFile(archived, "earlier registry");
  expect(
    await upgradeLocalHome({
      home,
      newsPath: join(home, "missing-news.json"),
      spore: "0.4.1-rehearsal.0",
    }),
  ).toEqual({ kind: "current" });
  expect(await readFile(archived, "utf8")).toBe("earlier registry");
  await expect(
    readFile(join(home, ".fungi", "version.json")),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("names an old published service by protocol and build, without inventing a version", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-prior-"));
  homes.push(home);
  const directory = join(home, ".fungi", "service");
  await mkdir(directory, { recursive: true });
  const build = "a".repeat(64);
  await writeFile(
    join(directory, "service.json"),
    JSON.stringify({
      protocol: 3,
      version: build,
      serviceId: localServiceIds.service.generate(),
      pid: 12345,
      startedAt: "linux:42",
      baseUrl: "http://127.0.0.1:9999/",
    }),
  );
  await expect(readPriorInstall(home)).resolves.toEqual({
    kind: "protocol",
    protocol: 3,
    build,
  });
  await writeLocalVersionMarker(home, {
    release: "0.4.1",
    spore: "0.3.1",
    build,
  });
  await expect(readPriorInstall(home)).resolves.toEqual({
    kind: "recorded",
    release: "0.4.1",
    spore: "0.3.1",
  });
  expect(
    JSON.parse(await readFile(join(home, ".fungi", "version.json"), "utf8")),
  ).toEqual({
    version: 1,
    release: "0.4.1",
    spore: "0.3.1",
    build,
  });
  await writeFile(join(home, ".fungi", "version.json"), '{"version":2}');
  await expect(readPriorInstall(home)).rejects.toThrow(/version.json/);
});
