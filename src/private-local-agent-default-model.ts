import type { PrivateSqliteDatabase } from "./private-sqlite-owner.js";
import { z } from "zod";
import {
  parseModelPreferenceJson,
  type ModelPreference,
} from "@fungi.computer/shiitake/model-preference";

/** The one module that owns the Agent default's table SQL. */
const settingsTable = "private_local_model_settings";
const storedModelSchema = z.string().optional();

/** Create the Agent default's table in a store this host owns. */
export function ensureAgentDefaultModelTable(
  database: PrivateSqliteDatabase,
): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${settingsTable} (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), model TEXT NOT NULL) STRICT`,
  );
}

/** Keep an Agent's first default; later changes go through the writer. */
export function seedAgentDefaultModel(
  database: PrivateSqliteDatabase,
  model: ModelPreference | null,
): void {
  database
    .prepare(`INSERT OR IGNORE INTO ${settingsTable} VALUES (1, ?)`)
    .run(JSON.stringify(model));
}

/** The stored default as written (JSON text); undefined when the row is missing. */
export function readAgentDefaultModelJson(
  database: PrivateSqliteDatabase,
): string | undefined {
  return storedModelSchema.parse(
    database
      .prepare(`SELECT model FROM ${settingsTable} WHERE singleton = 1`)
      .get()?.model,
  );
}

/** Read the Agent default a store holds; null when none is set. */
export function readAgentDefaultModel(
  database: PrivateSqliteDatabase,
): ModelPreference | null {
  return parseModelPreferenceJson(readAgentDefaultModelJson(database));
}

/** Replace the Agent default, thinking level included. */
export function writeAgentDefaultModel(
  database: PrivateSqliteDatabase,
  model: ModelPreference,
): void {
  database
    .prepare(`UPDATE ${settingsTable} SET model = ? WHERE singleton = 1`)
    .run(JSON.stringify(model));
}
