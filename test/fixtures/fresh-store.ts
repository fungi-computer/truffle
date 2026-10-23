import { basename, dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Create the identity and model-settings tables a Local host writes at open. */
export function initFreshStore(
  database: DatabaseSync,
  agentId: string,
  name: string | null,
  createdBy: string | null = null,
  archived = false,
): void {
  database.exec(
    "CREATE TABLE IF NOT EXISTS private_local_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), agent_id TEXT NOT NULL UNIQUE, name TEXT, created_by TEXT, archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)), folder TEXT NOT NULL DEFAULT '.', require_sandbox INTEGER NOT NULL DEFAULT 0 CHECK (require_sandbox IN (0, 1)))",
  );
  database
    .prepare(
      "INSERT OR IGNORE INTO private_local_identity (singleton, agent_id, name, created_by, archived) VALUES (1, ?, ?, ?, ?)",
    )
    .run(agentId, name, createdBy, archived ? 1 : 0);
  database.exec(
    "CREATE TABLE IF NOT EXISTS private_local_model_settings (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), model TEXT NOT NULL) STRICT",
  );
  database.exec(
    "INSERT OR IGNORE INTO private_local_model_settings VALUES (1, 'null')",
  );
}

/** An Agent store file at the current schema, named by its directory. */
export function writeFreshStore(
  path: string,
  name: string | null,
  createdBy: string | null = null,
  archived = false,
): void {
  const database = new DatabaseSync(path);
  try {
    initFreshStore(
      database,
      basename(dirname(path)),
      name,
      createdBy,
      archived,
    );
  } finally {
    database.close();
  }
}
