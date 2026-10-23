import {
  openPrivateWritableSqliteDatabase,
  type PrivateSqliteDatabase,
} from "./private-sqlite-owner.js";
import { join } from "node:path";
import { z } from "zod";
import {
  readOwnProcessStart,
  readProcessStart,
} from "./private-local-process-identity.js";

const ownerSchema = z.object({
  pid: z.number().int().positive(),
  startedAt: z.string().min(1),
});
export type ServiceLeaseOwner = z.infer<typeof ownerSchema>;

function openLease(directory: string) {
  const database = openPrivateWritableSqliteDatabase(
    join(directory, "owner.sqlite"),
    0,
  );
  try {
    database.exec(
      "CREATE TABLE IF NOT EXISTS service_owner (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, startedAt TEXT NOT NULL)",
    );
    return database;
  } catch (cause) {
    database.close();
    throw cause;
  }
}

function readOwner(
  database: PrivateSqliteDatabase,
): ServiceLeaseOwner | undefined {
  const row = database
    .prepare("SELECT pid, startedAt FROM service_owner WHERE id = 1")
    .get();
  return row === undefined ? undefined : ownerSchema.parse(row);
}

async function ownerIsLive(owner: ServiceLeaseOwner): Promise<boolean> {
  const current = await readProcessStart(owner.pid);
  if (current.kind !== "unverifiable")
    return current.kind === "running" && current.start === owner.startedAt;
  // Without precise identity we may retain a stale claim, but never steal a
  // possibly live one. Signal 0 checks existence; it does not terminate it.
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause) {
      if (cause.code === "ESRCH") return false;
      if (cause.code === "EPERM") return true;
    }
    throw cause;
  }
}

/** The live claim's identity comes from SQLite, never from service.json. */
export async function readServiceLeaseOwner(
  directory: string,
): Promise<ServiceLeaseOwner | undefined> {
  const database = openLease(directory);
  try {
    const owner = readOwner(database);
    return owner !== undefined && (await ownerIsLive(owner))
      ? owner
      : undefined;
  } finally {
    database.close();
  }
}

/**
 * Acquire the one process-owned row and publish its identity in the same
 * transaction. This is a process-lifetime claim, not a heartbeat/timeout lease:
 * only release or proof that the recorded process is gone permits replacement.
 * Committing makes the identity readable by clients while the owner runs.
 */
export async function acquireServiceOwnerLease(directory: string) {
  const own = { pid: process.pid, startedAt: await readOwnProcessStart() };
  const database = openLease(directory);
  let transaction = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transaction = true;
    const owner = readOwner(database);
    if (owner !== undefined && (await ownerIsLive(owner)))
      throw new Error(
        "The Fungi service owner database is locked by a live process",
      );
    database
      .prepare(
        "INSERT OR REPLACE INTO service_owner (id, pid, startedAt) VALUES (1, ?, ?)",
      )
      .run(own.pid, own.startedAt);
    database.exec("COMMIT");
    transaction = false;
  } finally {
    try {
      if (transaction) database.exec("ROLLBACK");
    } finally {
      database.close();
    }
  }
  let released = false;
  return () => {
    if (released) return;
    const database = openLease(directory);
    try {
      database
        .prepare(
          "DELETE FROM service_owner WHERE id = 1 AND pid = ? AND startedAt = ?",
        )
        .run(own.pid, own.startedAt);
      released = true;
    } finally {
      database.close();
    }
  };
}
