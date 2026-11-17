import { z } from "zod";
import type { PrivateSqliteDatabase } from "./private-sqlite-owner.js";

/** The Agent identity table as the current host writes it. */
export const localIdentityDefinition = `
  CREATE TABLE IF NOT EXISTS private_local_identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    agent_id TEXT NOT NULL UNIQUE,
    name TEXT,
    created_by TEXT,
    archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
    folder TEXT NOT NULL DEFAULT '.',
    mode TEXT NOT NULL CHECK (mode IN ('full-access', 'workspace', 'read-only')),
    writable_folders TEXT NOT NULL DEFAULT '[]'
  )
`;

/** Every Agent store has these; a table without them is not an identity table. */
export const identityBaselineColumns = ["agent_id", "name", "created_by"];

/**
 * What an identity written before a column existed means. Agents from before
 * sandbox requirements, folders and the archive flag ran unsandboxed in their
 * own folder and were not archived. A later require_sandbox flag takes
 * precedence over that default and becomes Workspace mode.
 */
const legacyIdentityValues = {
  archived: "0",
  folder: "'.'",
  mode: "'full-access'",
  writable_folders: "'[]'",
} as const;

const legacyIdentityColumns = [
  "archived",
  "folder",
  "mode",
  "writable_folders",
] as const;
type LegacyIdentityColumn = (typeof legacyIdentityColumns)[number];
const columnRow = z.object({ name: z.string() });

function identityValue(
  columns: readonly string[],
  column: LegacyIdentityColumn,
): string {
  if (columns.includes(column)) return column;
  if (column === "mode" && columns.includes("require_sandbox"))
    return "CASE require_sandbox WHEN 1 THEN 'workspace' WHEN 0 THEN 'full-access' END";
  return legacyIdentityValues[column];
}

export function identityColumnNames(
  database: PrivateSqliteDatabase,
): readonly string[] {
  return database
    .prepare("PRAGMA table_info(private_local_identity)")
    .all()
    .map((column) => columnRow.parse(column).name);
}

/** Column expressions that read an older identity row as the current one. */
function identityExpressions(columns: readonly string[]): string {
  const present = (column: LegacyIdentityColumn) =>
    `${identityValue(columns, column)} AS ${column}`;
  return ["name", "created_by", ...legacyIdentityColumns.map(present)].join(
    ", ",
  );
}

/** Read the one identity row, filling a column an older store lacks. */
export function selectIdentitySql(columns: readonly string[]): string {
  return `SELECT ${identityExpressions(columns)} FROM private_local_identity WHERE singleton = 1`;
}

/**
 * Rebuild an identity table written before the archive flag, folder, mode or
 * writable folders existed, keeping its row and filling those as above. The
 * caller holds the store's write transaction. Reports whether it changed.
 */
export function upgradeLocalIdentity(database: PrivateSqliteDatabase): boolean {
  const columns = identityColumnNames(database);
  if (columns.length === 0) return false;
  if (legacyIdentityColumns.every((column) => columns.includes(column)))
    return false;
  if (!identityBaselineColumns.every((column) => columns.includes(column)))
    return false;
  const retired = "private_local_identity_before_modes";
  database.exec(`ALTER TABLE private_local_identity RENAME TO ${retired}`);
  database.exec(localIdentityDefinition);
  database.exec(
    `INSERT INTO private_local_identity
       (singleton, agent_id, name, created_by, archived, folder, mode, writable_folders)
     SELECT singleton, agent_id, name, created_by,
            ${legacyIdentityColumns.map((column) => identityValue(columns, column)).join(", ")}
       FROM ${retired}`,
  );
  database.exec(`DROP TABLE ${retired}`);
  return true;
}
