import { closeSync, fstatSync, openSync, type Stats } from "node:fs";
import fsPromises, {
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";

import { resolvePrivateLocalCreateStore } from "../src/private-local-runtime-host.js";

const originalLstat = fsPromises.lstat;
const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function temporaryProject() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-local-create-receipt-")),
  );
  roots.push(root);
  return root;
}

it("resolves two concurrent creates when the journal stat observes its unlink", async () => {
  const root = await temporaryProject();
  const journalPath = join(
    root,
    ".fungi",
    "agents",
    "local-agent-create-receipts.sqlite-journal",
  );
  const atJournal = Promise.withResolvers<undefined>();
  const journalMetadata = Promise.withResolvers<Stats>();
  let held = false;
  vi.spyOn(fsPromises, "lstat").mockImplementation(async (path, options) => {
    if (path === journalPath && !held) {
      held = true;
      atJournal.resolve(undefined);
      return journalMetadata.promise;
    }
    return originalLstat(path, options);
  });
  syncBuiltinESMExports();

  let observedUnlink = false;
  function observeCommit() {
    const spy = vi.spyOn(DatabaseSync.prototype, "exec");
    spy.mockImplementation(function (this: DatabaseSync, sql: string) {
      // Forward through the restored method with its real SQLite receiver.
      spy.mockRestore();
      if (sql !== "COMMIT") {
        this.exec(sql);
        observeCommit();
        return;
      }
      // Hold an inode reference while the other real SQLite create commits.
      // Replaying its real, zero-link stat at the paused lstat boundary makes
      // the kernel's lookup/unlink/getattr ordering deterministic; no fake Stats.
      const descriptor = openSync(journalPath, "r");
      try {
        this.exec(sql);
        const metadata = fstatSync(descriptor);
        expect(metadata.isFile()).toBe(true);
        expect(metadata.nlink).toBe(0);
        observedUnlink = true;
        journalMetadata.resolve(metadata);
      } finally {
        closeSync(descriptor);
      }
    });
  }
  observeCommit();

  const first = resolvePrivateLocalCreateStore(root, "paused-create");
  await atJournal.promise;
  const stores = await Promise.all([
    first,
    resolvePrivateLocalCreateStore(root, "committing-create"),
  ]);
  expect(observedUnlink).toBe(true);
  expect(new Set(stores.map(({ agentId }) => agentId)).size).toBe(2);
  await expect(
    resolvePrivateLocalCreateStore(root, "paused-create"),
  ).resolves.toEqual(stores[0]);
  await expect(
    resolvePrivateLocalCreateStore(root, "committing-create"),
  ).resolves.toEqual(stores[1]);
});

it.each(["receipt", "journal"])(
  "still refuses a planted hard link, symlink or directory at the %s path",
  async (kind) => {
    const root = await temporaryProject();
    const outside = await temporaryProject();
    const original = join(outside, "untouched");
    await writeFile(original, "not a Local receipt");
    const agents = join(root, ".fungi", "agents");
    await mkdir(agents, { recursive: true });
    const path = join(
      agents,
      `local-agent-create-receipts.sqlite${kind === "journal" ? "-journal" : ""}`,
    );
    for (const plant of [
      () => link(original, path),
      () => symlink(original, path),
      () => mkdir(path),
    ]) {
      await plant();
      await expect(
        resolvePrivateLocalCreateStore(root, `refused-${kind}`),
      ).rejects.toThrow(
        "Local Agent create receipt is not a unique project file",
      );
      expect(await readFile(original, "utf8")).toBe("not a Local receipt");
      await rm(path, { recursive: true });
    }
  },
);

// Await the receipts as the completion signal; 640 SQLite commits can outlast
// Vitest's default five seconds when other gate builds share the host.
it("resolves concurrent creates while each commit removes the SQLite journal", async () => {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "fungi-local-create-receipt-")),
  );
  roots.push(root);
  const agentIds = new Set<string>();
  // Every commit deletes the rollback journal that a concurrent create may have
  // just observed. Many parallel creates widen that window without timing hooks.
  for (let round = 0; round < 40; round += 1) {
    const stores = await Promise.all(
      Array.from({ length: 16 }, (_, index) =>
        resolvePrivateLocalCreateStore(
          root,
          `request-${String(round)}-${String(index)}`,
        ),
      ),
    );
    for (const { agentId } of stores) agentIds.add(agentId);
  }
  expect(agentIds.size).toBe(40 * 16);
}, 60_000);
