import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createWoodstockStorageConformance } from "@fungi.computer/shiitake/storage-conformance";
import { it } from "vitest";

import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";

/** The local host's own owner over a file database opened as the host opens it. */
const cases = createWoodstockStorageConformance((use) => {
  const directory = mkdtempSync(join(tmpdir(), "woodstock-conformance-"));
  const database = new DatabaseSync(join(directory, "shiitake.sqlite"), {
    timeout: 0,
  });
  try {
    database.exec("PRAGMA foreign_keys = ON");
    use(createPrivateSqliteOwner(database));
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
  return Promise.resolve();
});

for (const conformance of cases) it(conformance.name, conformance.run);
