import { DatabaseSync } from "node:sqlite";
import {
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  formatLocalUpgradeNotice,
  upgradeLocalHome,
} from "../src/local-upgrade.js";
import { readPrivateLocalSessionDiscovery } from "../src/private-local-session-discovery.js";
import { localServiceIds } from "../src/private-local-service-ids.js";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

function oldStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE private_local_identity (name TEXT)");
  db.close();
}

it("archives only refused home artifacts, keeps symlink targets, and resumes without overwriting", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-upgrade-"));
  homes.push(home);
  const agents = join(home, ".fungi", "agents");
  const extensions = join(home, ".fungi", "extensions");
  await mkdir(join(agents, "old-agent"), { recursive: true });
  await mkdir(extensions, { recursive: true });
  oldStore(join(agents, "old-agent", "agent.sqlite"));
  const target = join(home, "linked-agent");
  await mkdir(target);
  oldStore(join(target, "agent.sqlite"));
  await symlink(target, join(agents, "linked-agent"));
  const installed =
    '{"extensions":{"old":{"current":"v1","revisions":{"v1":{"source":"./tools/x"}}}}}';
  await writeFile(join(extensions, "installed.json"), installed);
  const activations =
    '{"projects":{},"agents":{"old":{"x":{"revision":"v1","capabilities":[]}}}}';
  await writeFile(join(extensions, "activations.json"), activations);
  const archive = join(home, ".fungi", "archive", "unversioned");
  const oldArchive = join(archive, "agents", "old-agent");
  await mkdir(oldArchive, { recursive: true });
  await writeFile(join(oldArchive, "keep"), "earlier archive");
  const newsPath = join(home, "whats-new.json");
  await writeFile(
    newsPath,
    JSON.stringify({ release: "0.4.1", lines: ["A change."] }),
  );

  const first = await upgradeLocalHome({ home, newsPath, spore: "0.3.1" });
  expect(first.kind).toBe("upgraded");
  if (first.kind !== "upgraded") throw new Error("expected upgrade");
  expect(first.report.archive).toBe(archive);
  expect(first.report.archived).toHaveLength(3);
  expect(formatLocalUpgradeNotice(first.report)).toContain(
    "Archived 2 Agent stores and extension activations to",
  );
  expect(formatLocalUpgradeNotice(first.report)).toContain(
    `  Extension activations: ${join(archive, "extensions", "activations.json")}`,
  );
  expect(await readFile(join(oldArchive, "keep"), "utf8")).toBe(
    "earlier archive",
  );
  expect(
    await readFile(join(archive, "agents", "old-agent-2", "agent.sqlite")),
  ).toBeTruthy();
  expect(await readlink(join(archive, "agents", "linked-agent"))).toBe(target);
  expect((await lstat(join(target, "agent.sqlite"))).isFile()).toBe(true);
  expect(await readFile(join(extensions, "installed.json"), "utf8")).toBe(
    installed,
  );
  expect(
    await readFile(join(archive, "extensions", "activations.json"), "utf8"),
  ).toBe(activations);
  expect(
    await readFile(join(home, ".fungi", "version.json"), "utf8"),
  ).toContain("0.4.1");
  expect(await upgradeLocalHome({ home, newsPath, spore: "0.3.1" })).toEqual({
    kind: "current",
  });
});

it("leaves a corrupt Agent store for discovery's problem row without blocking CLI pre-dispatch", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-corrupt-home-"));
  homes.push(home);
  const database = join(home, ".fungi", "agents", "broken", "agent.sqlite");
  await mkdir(join(home, ".fungi", "agents", "broken"), {
    recursive: true,
  });
  const corrupt = "not a database";
  await writeFile(database, corrupt);
  expect(
    await upgradeLocalHome({
      home,
      newsPath: join(home, "not-needed.json"),
      spore: "0.3.1",
    }),
  ).toEqual({ kind: "current" });
  expect(await readFile(database, "utf8")).toBe(corrupt);
  const discovery = await readPrivateLocalSessionDiscovery(home);
  expect(discovery.problems).toEqual([{ kind: "corrupt" }]);
  expect(discovery.agents).toMatchObject([
    { agentId: "broken", databasePath: database },
  ]);
});

it("archives truncated activation JSON as reader-refused without blocking dispatch", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-truncated-activations-"));
  homes.push(home);
  const extensions = join(home, ".fungi", "extensions");
  await mkdir(extensions, { recursive: true });
  const source = join(extensions, "activations.json");
  const truncated = "{ truncated";
  await writeFile(source, truncated);
  const newsPath = join(home, "whats-new.json");
  await writeFile(newsPath, JSON.stringify({ release: "0.4.1", lines: [] }));
  const outcome = await upgradeLocalHome({ home, newsPath, spore: "0.3.1" });
  expect(outcome.kind).toBe("upgraded");
  if (outcome.kind !== "upgraded") throw new Error("expected upgrade");
  const archived = join(
    home,
    ".fungi",
    "archive",
    "unversioned",
    "extensions",
    "activations.json",
  );
  expect(outcome.report.archived).toEqual([
    { kind: "extension-activations", from: source, to: archived },
  ]);
  expect(await readFile(archived, "utf8")).toBe(truncated);
  expect(await upgradeLocalHome({ home, newsPath, spore: "0.3.1" })).toEqual({
    kind: "current",
  });
});

it("resumes an interrupted protocol-3 archive under its original slug after the service record is removed", async () => {
  const home = await mkdtemp(join(tmpdir(), "fungi-resumed-archive-"));
  homes.push(home);
  const root = join(home, ".fungi");
  const agents = join(root, "agents");
  const service = join(root, "service");
  await mkdir(service, { recursive: true });
  const first = join(agents, "a-first");
  const blocked = join(agents, "z-blocked");
  await mkdir(first, { recursive: true });
  await mkdir(blocked, { recursive: true });
  oldStore(join(first, "agent.sqlite"));
  oldStore(join(blocked, "agent.sqlite"));
  const build = "a".repeat(64);
  const record = join(service, "service.json");
  await writeFile(
    record,
    JSON.stringify({
      protocol: 3,
      version: build,
      serviceId: localServiceIds.service.generate(),
      pid: 12345,
      startedAt: "linux:42",
      baseUrl: "http://127.0.0.1:9999/",
    }),
  );
  const archive = join(root, "archive", "protocol-3-aaaaaaaaaaaa");
  for (const suffix of ["", "-2", "-3", "-4", "-5", "-6", "-7", "-8", "-9"]) {
    const occupied = join(archive, "agents", `z-blocked${suffix}`);
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, "keep"), "earlier archived store");
  }
  const newsPath = join(home, "whats-new.json");
  await writeFile(newsPath, JSON.stringify({ release: "0.4.1", lines: [] }));
  await expect(
    upgradeLocalHome({
      home,
      newsPath,
      spore: "0.3.1",
      stopService: async () => {
        expect(
          JSON.parse(
            await readFile(join(root, ".upgrade-in-progress.json"), "utf8"),
          ),
        ).toMatchObject({
          version: 1,
          prior: { kind: "protocol", protocol: 3, build },
        });
        await unlink(record);
        return { kind: "stopped" };
      },
    }),
  ).rejects.toThrow(
    `Cannot archive ${blocked} under ${join(archive, "agents")}`,
  );
  expect(
    await readFile(join(archive, "agents", "a-first", "agent.sqlite")),
  ).toBeTruthy();
  await expect(readFile(record)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(join(root, "version.json"))).rejects.toMatchObject({
    code: "ENOENT",
  });

  await rm(join(archive, "agents", "z-blocked-9"), {
    recursive: true,
  });
  const resumed = await upgradeLocalHome({ home, newsPath, spore: "0.3.1" });
  expect(resumed.kind).toBe("upgraded");
  if (resumed.kind !== "upgraded") throw new Error("expected resumed upgrade");
  expect(resumed.report.from).toEqual({ kind: "protocol", protocol: 3, build });
  expect(resumed.report.archive).toBe(archive);
  expect(resumed.report.archived).toEqual([
    {
      kind: "agent-store",
      from: blocked,
      to: join(archive, "agents", "z-blocked-9"),
    },
  ]);
  expect(formatLocalUpgradeNotice(resumed.report)).toContain(
    `  ${archive} (nothing was deleted)`,
  );
  expect(
    await readFile(join(archive, "agents", "a-first", "agent.sqlite")),
  ).toBeTruthy();
  await expect(
    readFile(join(root, ".upgrade-in-progress.json")),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("does not claim a protocol when the prior installation was unrecorded", () => {
  expect(
    formatLocalUpgradeNotice({
      from: { kind: "unrecorded" },
      to: "0.4.1",
      service: "absent",
      archive: undefined,
      archived: [],
      whatsNew: [],
    }),
  ).toEqual(["Upgraded an earlier Fungi → 0.4.1"]);
});
