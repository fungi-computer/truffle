import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

import { resolvePrivateLocalCreateStore } from "../src/private-local-runtime-host.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

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
