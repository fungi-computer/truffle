import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";

import { readPrivateLocalAgentProfile } from "../src/private-local-session-discovery.js";

const areas: string[] = [];
afterEach(async () => {
  await Promise.all(
    areas.splice(0).map((area) => rm(area, { recursive: true, force: true })),
  );
});

async function store() {
  const area = await mkdtemp(join(tmpdir(), "fungi-profile-cache-"));
  areas.push(area);
  const path = join(area, "agent.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE private_local_identity (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      agent_id TEXT NOT NULL UNIQUE,
      name TEXT,
      created_by TEXT,
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
      folder TEXT NOT NULL DEFAULT '.',
      mode TEXT NOT NULL CHECK (mode IN ('full-access', 'workspace', 'read-only')),
      writable_folders TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE private_local_model_settings (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), model TEXT NOT NULL) STRICT;
    INSERT INTO private_local_identity (singleton, agent_id, name, created_by, mode)
      VALUES (1, 'agent', 'first', 'maker', 'full-access');
    INSERT INTO private_local_model_settings VALUES (1, 'null');
  `);
  return { path, database };
}

it("answers an unchanged store from memory and rereads it after a write", async () => {
  const { path, database } = await store();
  try {
    const first = readPrivateLocalAgentProfile(path);
    expect(first).toMatchObject({
      name: "first",
      createdBy: "maker",
      archived: false,
    });
    // Same file version: the listing reuses the profile without reopening.
    expect(readPrivateLocalAgentProfile(path)).toBe(first);

    database.exec(
      "UPDATE private_local_identity SET name = 'second', archived = 1",
    );
    const second = readPrivateLocalAgentProfile(path);
    expect(second).not.toBe(first);
    expect(second).toMatchObject({ name: "second", archived: true });
  } finally {
    database.close();
  }
});
