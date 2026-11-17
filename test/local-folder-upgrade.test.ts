import { DatabaseSync } from "node:sqlite";
import {
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { acquireNodeStoreLease } from "@fungi.computer/shiitake/node";
import { initFreshStore } from "./fixtures/fresh-store.js";
import { createLocalServiceOwners } from "../src/private-local-service-owner.js";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import { openPrivateLocalRuntimeHost } from "../src/private-local-runtime-host.js";
import {
  formatLocalFolderUpgradeNotice,
  upgradeLocalFolder,
  upgradeLocalHome,
} from "../src/local-upgrade.js";
import {
  LocalStoreSchemaError,
  readPrivateLocalAgentProfile,
  readPrivateLocalSessionDiscovery,
} from "../src/private-local-session-discovery.js";

/**
 * Real Agent stores a Local host wrote at each Woodstock marker (see that
 * directory's README); never a person's own folder.
 */
const fixtures = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "packages",
  "shiitake",
  "test",
  "fixtures",
  "historical-stores",
);

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0))
    await rm(folder, { recursive: true, force: true });
});

async function folder() {
  const path = await mkdtemp(join(tmpdir(), "fungi-folder-upgrade-"));
  folders.push(path);
  return path;
}

/** A private copy of the fixture saved at `marker`, as Agent `id` of `root`. */
async function store(root: string, id: string, marker: 1 | 2 | 3 | 4 | 5) {
  const path = join(root, ".fungi", "agents", id, "agent.sqlite");
  await mkdir(dirname(path), { recursive: true });
  await copyFile(join(fixtures, `marker-${String(marker)}.agent.sqlite`), path);
  return path;
}

/**
 * A store no build ever wrote: a real marker-3 store re-marked 0, which this
 * build refuses as it would any store it cannot read.
 */
async function unreadableStore(root: string, id: string) {
  const path = await store(root, id, 3);
  const database = new DatabaseSync(path);
  try {
    database.exec("UPDATE woodstock_schema SET version = 0");
  } finally {
    database.close();
  }
  return path;
}

const columnRow = z.object({ name: z.string() });

function identityColumns(path: string): readonly string[] {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return database
      .prepare("PRAGMA table_info(private_local_identity)")
      .all()
      .map((column) => columnRow.parse(column).name);
  } finally {
    database.close();
  }
}

const markerRow = z.object({ version: z.number() });

function markerOf(path: string): number {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return markerRow.parse(
      database.prepare("SELECT version FROM woodstock_schema").get(),
    ).version;
  } finally {
    database.close();
  }
}

describe("a folder with Agent stores from older Fungi releases", () => {
  it.each([0, 7])(
    "keeps refused marker %s byte-identical in place without an archive",
    async (version) => {
      const root = await folder();
      // Synthetic downgrade fixture: real historical data with a future marker,
      // not a claim that we can interpret a future Spore's schema.
      const path = await store(root, "downgraded", 3);
      const database = new DatabaseSync(path);
      database.prepare("UPDATE woodstock_schema SET version = ?").run(version);
      database.close();
      const before = await readFile(path);
      const entries = await readdir(dirname(path));
      await upgradeLocalHome({
        home: root,
        spore: "0.15.1",
        newsPath: join(root, "unused-news.json"),
      });
      const report = await upgradeLocalFolder(root);
      // Compare all bytes natively: deep equality walks 616 KiB as object keys.
      expect((await readFile(path)).equals(before)).toBe(true);
      expect(await readdir(dirname(path))).toEqual(entries);
      await expect(
        lstat(join(root, ".fungi", "archive")),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(report).toMatchObject({
        upgraded: [],
        refused: [
          {
            databasePath: path,
            reason: version === 7 ? "newer" : "unreadable",
          },
        ],
      });
      await expect(
        openPrivateLocalRuntimeHost({
          invocationRoot: root,
          databasePath: path,
          mode: "read-only",
        }),
      ).rejects.toMatchObject({
        name: "LocalStoreSchemaError",
        reason: version === 7 ? "newer" : "unreadable",
      });
      expect((await readFile(path)).equals(before)).toBe(true);
      await expect(
        lstat(join(root, ".fungi", "archive")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("reads the upgradable stores and refuses only the one this build cannot read", async () => {
    const root = await folder();
    const bad = await unreadableStore(root, "bad");
    const upgradable = [
      await store(root, "m1", 1),
      await store(root, "m2", 2),
      await store(root, "m3", 3),
      await store(root, "m4", 4),
      await store(root, "m5", 5),
    ];
    expect(() => readPrivateLocalAgentProfile(bad)).toThrow(
      LocalStoreSchemaError,
    );
    for (const path of upgradable)
      expect(readPrivateLocalAgentProfile(path).name).toBe("Fixture Agent");
    const discovery = await readPrivateLocalSessionDiscovery(root);
    expect(
      discovery.agents
        .filter((agent) => agent.unreadable !== undefined)
        .map((agent) => agent.agentId),
    ).toEqual(["bad"]);
  });

  it("upgrades supported stores and leaves refused stores untouched in place", async () => {
    const root = await folder();
    const unreadable = await unreadableStore(root, "bad");
    const original = await readFile(unreadable);
    const upgradable = [
      await store(root, "m1", 1),
      await store(root, "m2", 2),
      await store(root, "m3", 3),
      await store(root, "m4", 4),
      await store(root, "m5", 5),
    ];
    const report = await upgradeLocalFolder(root);
    expect(report).toEqual({
      refused: [new LocalStoreSchemaError(unreadable)],
      upgraded: ["m1", "m2", "m3", "m4", "m5"].map((id) =>
        join(root, ".fungi", "agents", id),
      ),
    });
    expect(formatLocalFolderUpgradeNotice(report)).toEqual([
      "Upgraded 5 Agent stores to this Fungi (nothing was lost)",
      "Fungi cannot read this Agent store. Its files have not been changed.",
      `  ${unreadable}`,
    ]);
    expect((await readFile(unreadable)).equals(original)).toBe(true);
    await expect(lstat(join(root, ".fungi", "archive"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    for (const path of upgradable) expect(markerOf(path)).toBe(6);

    // The Agents and every Session are still there, now readable by this build.
    const discovery = await readPrivateLocalSessionDiscovery(root);
    expect(discovery.problems).toEqual([]);
    expect(
      discovery.agents
        .filter((agent) => agent.unreadable === undefined)
        .map((agent) => [agent.agentId, agent.name, agent.unreadable]),
    ).toEqual(
      ["m1", "m2", "m3", "m4", "m5"].map((id) => [
        id,
        "Fixture Agent",
        undefined,
      ]),
    );
    expect(discovery.sessions).toHaveLength(15);

    expect(await upgradeLocalFolder(root)).toEqual({
      refused: [new LocalStoreSchemaError(unreadable)],
      upgraded: [],
    });
  });

  it.each([1, 2] as const)(
    "reads and upgrades an identity saved at marker %s, before sandbox modes",
    async (from) => {
      const root = await folder();
      const path = await store(root, "old", from);
      const current = ["archived", "folder", "mode", "writable_folders"];
      // The real store lacks the newer columns (marker 2 already has the
      // archive flag), and reads as what it ran with.
      const missing =
        from === 1 ? current : current.filter((name) => name !== "archived");
      for (const column of missing)
        expect(identityColumns(path)).not.toContain(column);
      const ranWith = {
        name: "Fixture Agent",
        archived: false,
        mode: "full-access",
        folder: ".",
        writableFolders: [],
      };
      expect(readPrivateLocalAgentProfile(path)).toMatchObject(ranWith);

      expect((await upgradeLocalFolder(root)).upgraded).toHaveLength(1);
      expect(identityColumns(path)).toEqual(expect.arrayContaining(current));
      expect(readPrivateLocalAgentProfile(path)).toMatchObject(ranWith);
    },
  );

  it("leaves a live-owned store in place, then upgrades it after its owner releases", async () => {
    const root = await folder();
    const path = await store(root, "live", 3);
    const lease = acquireNodeStoreLease(`${path}.owner.sqlite`);
    try {
      expect(await upgradeLocalFolder(root)).toEqual({
        refused: [],
        upgraded: [],
      });
      expect(markerOf(path)).toBe(3);
    } finally {
      lease.release();
    }
    expect((await upgradeLocalFolder(root)).upgraded).toHaveLength(1);
    expect(markerOf(path)).toBe(6);
  });

  it("leaves refused and upgradable symlinks and their targets in place", async () => {
    const root = await folder();
    const targets = await folder();
    const unreadable = await unreadableStore(targets, "unreadable");
    const upgradable = await store(targets, "upgradable", 3);
    const agents = join(root, ".fungi", "agents");
    await mkdir(agents, { recursive: true });
    await symlink(dirname(unreadable), join(agents, "unreadable"));
    await symlink(dirname(upgradable), join(agents, "upgradable"));
    const original = await readFile(unreadable);
    const report = await upgradeLocalFolder(root);
    expect(report.upgraded).toEqual([]);
    expect(report.refused).toHaveLength(1);
    expect(await readlink(join(agents, "unreadable"))).toBe(
      dirname(unreadable),
    );
    expect((await readFile(unreadable)).equals(original)).toBe(true);
    await expect(lstat(join(root, ".fungi", "archive"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(unreadable)).isFile()).toBe(true);
    expect(markerOf(upgradable)).toBe(3);
    expect((await lstat(join(agents, "upgradable"))).isSymbolicLink()).toBe(
      true,
    );
  });

  it("rolls back the Local identity too when Woodstock cannot upgrade", async () => {
    const root = await folder();
    const path = await store(root, "broken", 1);
    const database = new DatabaseSync(path);
    database.exec(
      "CREATE TABLE idx_session_entries_ancestry (unexpected TEXT)",
    );
    database.close();
    const before = identityColumns(path);
    const report = await upgradeLocalFolder(root);
    expect(report.upgraded).toEqual([]);
    expect(report.refused).toMatchObject([{ reason: "unreadable" }]);
    expect(markerOf(path)).toBe(1);
    expect(identityColumns(path)).toEqual(before);
  });

  it("invalidates a cached current profile when the marker changes", async () => {
    const root = await folder();
    const path = await store(root, "changed", 5);
    expect(readPrivateLocalAgentProfile(path).name).toBe("Fixture Agent");
    const database = new DatabaseSync(path);
    database.exec("UPDATE woodstock_schema SET version = 0");
    database.close();
    expect(() => readPrivateLocalAgentProfile(path)).toThrow(
      LocalStoreSchemaError,
    );
  });

  it("accepts a fresh Woodstock store without writing a marker during a profile read", async () => {
    const root = await folder();
    const path = join(root, ".fungi", "agents", "fresh", "agent.sqlite");
    await mkdir(dirname(path), { recursive: true });
    const database = new DatabaseSync(path);
    initFreshStore(database, "fresh", "fresh");
    database.close();
    const before = await readFile(path);
    expect(readPrivateLocalAgentProfile(path).name).toBe("fresh");
    expect((await readFile(path)).equals(before)).toBe(true);
    expect(await upgradeLocalFolder(root)).toEqual({
      refused: [],
      upgraded: [],
    });
  });
});

async function withModels<A>(
  body: (input: {
    models: ReturnType<typeof createModels>;
    home: string;
    configRoot: ReturnType<typeof capturePrivateLocalConfigRoot>;
  }) => Promise<A>,
) {
  const home = await folder();
  const configRoot = capturePrivateLocalConfigRoot(home);
  await mkdir(configRoot.serviceDirectory, { recursive: true });
  const models = createModels();
  const faux = fauxProvider({
    provider: "faux-local",
    models: [{ id: "offline", name: "Offline" }],
  });
  // A restored loop timer may also ask the model for a reply, in any order.
  faux.setResponses(
    Array.from({ length: 6 }, () =>
      fauxAssistantMessage("Answered after the upgrade."),
    ),
  );
  models.setProvider(faux.provider);
  return body({ models, home, configRoot });
}

describe.each([1, 2, 3, 4, 5] as const)(
  "an Agent saved at Woodstock marker %s",
  (marker) => {
    it.each([true, false])(
      "opens with its history and answers a new prompt (folder pass first: %s)",
      async (passFirst) => {
        const root = await folder();
        const path = await store(root, "agent", marker);
        if (passFirst)
          expect((await upgradeLocalFolder(root)).upgraded).toHaveLength(1);
        await withModels(async ({ models, configRoot }) => {
          const host = await openPrivateLocalRuntimeHost(
            {
              invocationRoot: root,
              databasePath: path,
              configRoot,
              providerId: "faux-local",
              modelId: "offline",
            },
            models,
          );
          try {
            expect(host.name).toBe("Fixture Agent");
            const discovery = await readPrivateLocalSessionDiscovery(root);
            const history = JSON.stringify(
              await Promise.all(
                discovery.sessions.map(async (session) =>
                  host.getSession(session.sessionId).read(),
                ),
              ),
            );
            for (const text of [
              "Fixture prompt one: read the note.",
              "Fixture reply one.",
              "Second session prompt.",
              "Third session reply.",
            ])
              expect(history).toContain(text);

            await host.session.command({
              type: "prompt",
              delivery: "followUp",
              requestId: "after-the-upgrade",
              text: "After the upgrade.",
            });
            const deadline = Date.now() + 30_000;
            let snapshot = JSON.stringify(await host.session.read());
            while (!snapshot.includes("Answered after the upgrade.")) {
              if (Date.now() > deadline)
                throw new Error("No answer after the upgrade");
              await new Promise((resolve) => setTimeout(resolve, 50));
              snapshot = JSON.stringify(await host.session.read());
            }
            expect(snapshot).toContain("After the upgrade.");
            // Streaming text is visible before the run commits its terminal
            // facts. Let both this prompt and the restored loop wake settle
            // before ending the fixture's runtime lifetime.
            while (!(await host.idle()).idle) {
              if (Date.now() > deadline)
                throw new Error("Upgraded Agent did not settle");
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          } finally {
            await host.close();
          }
        });
        expect(markerOf(path)).toBe(6);
      },
    );
  },
);

describe("starting in a folder", () => {
  /** Select as the service does, on a stub model, and report which store it chose. */
  async function selected(root: string) {
    return withModels(async ({ models, configRoot }) => {
      let host:
        Awaited<ReturnType<typeof openPrivateLocalRuntimeHost>> | undefined;
      const owners = createLocalServiceOwners(
        async (options) => {
          host = await openPrivateLocalRuntimeHost(
            { ...options, providerId: "faux-local", modelId: "offline" },
            models,
          );
          return host;
        },
        configRoot.serviceDirectory,
        undefined,
        undefined,
        undefined,
        undefined,
        configRoot,
      );
      try {
        const selection = await owners.select({
          invocationRoot: root,
          mode: "full-access",
        });
        try {
          expect((await selection.session.read()).sessionId).toBe(
            selection.sessionId,
          );
          return selection.databasePath;
        } finally {
          selection.release();
        }
      } finally {
        try {
          const opened = host;
          if (opened !== undefined) {
            // Selection starts the fixture's overdue loop wake too. Keep its
            // lifetime open until durable work settles, not just until the
            // selected Session can be read.
            await expect
              .poll(async () => (await opened.idle()).idle)
              .toBe(true);
          }
        } finally {
          await owners.close();
        }
      }
    });
  }

  it.each([true, false])(
    "continues with the old Agent it upgrades, never a new one (folder pass first: %s)",
    async (passFirst) => {
      const root = await folder();
      const path = await store(root, "only", 4);
      if (passFirst) await upgradeLocalFolder(root);
      expect(await selected(root)).toBe(path);
    },
  );

  it.each([true, false])(
    "starts a fresh Agent when its only store cannot be read (folder pass first: %s)",
    async (passFirst) => {
      const root = await folder();
      const unreadable = await unreadableStore(root, "unreadable");
      if (passFirst)
        expect((await upgradeLocalFolder(root)).refused).toHaveLength(1);
      const chosen = await selected(root);
      expect(chosen).not.toBe(unreadable);
      expect(readPrivateLocalAgentProfile(chosen).archived).toBe(false);
    },
  );
});
