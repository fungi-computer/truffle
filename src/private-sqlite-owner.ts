import * as Schema from "effect/Schema";
import { sqliteRowSchema } from "@fungi.computer/shiitake";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type {
  SqliteCursor,
  SqliteOwner,
  SqliteValue,
} from "@fungi.computer/shiitake";

const decodeSqliteRow = Schema.decodeUnknownSync(sqliteRowSchema);

type NativeOutput = null | number | bigint | string | Uint8Array;
export type PrivateSqliteFailureCode =
  "busy" | "locked" | "corrupt" | "not_a_database" | "other";

const sqliteFailureSchema = z.object({
  code: z.literal("ERR_SQLITE_ERROR"),
  errcode: z.number().int(),
});
const sqlitePrimaryCodeMask = 0xff;

/** Decode Node SQLite's structured result code before higher owners sanitize it. */
export function privateSqliteFailureCode(
  cause: unknown,
): PrivateSqliteFailureCode | undefined {
  const parsed = sqliteFailureSchema.safeParse(cause);
  if (!parsed.success) return undefined;
  switch (parsed.data.errcode & sqlitePrimaryCodeMask) {
    case 5:
      return "busy";
    case 6:
      return "locked";
    case 11:
      return "corrupt";
    case 26:
      return "not_a_database";
    default:
      return "other";
  }
}

const readerStatement = /^\s*(?:SELECT|PRAGMA|WITH)\b/iu;

function nativeInput(value: SqliteValue): Uint8Array | string | number | null {
  return value instanceof ArrayBuffer ? new Uint8Array(value) : value;
}

function nativeOutput(value: NativeOutput): SqliteValue {
  if (value === null) return value;
  if (value instanceof Uint8Array) return new Uint8Array(value).slice().buffer;
  if (Object.prototype.toString.call(value) === "[object Number]")
    return Number(value);
  if (Object.prototype.toString.call(value) === "[object String]")
    return String(value);
  return Number(value);
}

function nativeRow(row: Record<string, NativeOutput>) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, nativeOutput(value)]),
  );
}

/** Adapt one synchronous native database to Shiitake's public owner shape. */
export function createPrivateSqliteOwner(
  database: DatabaseSync,
  onFailure?: (code: PrivateSqliteFailureCode) => void,
): SqliteOwner {
  const observeFailure = (cause: unknown): never => {
    const code = privateSqliteFailureCode(cause);
    if (code !== undefined) onFailure?.(code);
    throw cause;
  };
  return Object.freeze({
    sql: Object.freeze({
      exec: (statement: string, ...bindings: SqliteValue[]): SqliteCursor => {
        let rows: Record<string, SqliteValue>[];
        try {
          const prepared = database.prepare(statement);
          const values = bindings.map(nativeInput);
          rows = readerStatement.test(statement)
            ? prepared.all(...values).map(nativeRow)
            : (prepared.run(...values), []);
        } catch (cause) {
          return observeFailure(cause);
        }
        return Object.freeze({
          toArray: () => rows.map((row) => decodeSqliteRow(row)),
          one: () => {
            const row = rows[0];
            if (row === undefined) throw new Error("Expected one SQLite row");
            return decodeSqliteRow(row);
          },
        });
      },
    }),
    transactionSync: <Value>(operation: () => Value): Value => {
      try {
        database.exec("BEGIN");
      } catch (cause) {
        return observeFailure(cause);
      }
      try {
        const value = operation();
        database.exec("COMMIT");
        return value;
      } catch (cause) {
        try {
          database.exec("ROLLBACK");
        } catch (rollbackCause) {
          observeFailure(rollbackCause);
        }
        return observeFailure(cause);
      }
    },
  });
}
