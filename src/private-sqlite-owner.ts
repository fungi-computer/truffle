import * as Schema from "effect/Schema";
import { sqliteRowSchema } from "@fungi.computer/shiitake";
import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { z } from "zod";
import type {
  SqliteCursor,
  SqliteOwner,
  SqliteValue,
} from "@fungi.computer/shiitake";

const decodeSqliteRow = Schema.decodeUnknownSync(sqliteRowSchema);

export type NativeOutput = null | number | bigint | string | Uint8Array;
export type NativeInput = null | number | string | Uint8Array;

/** Bun keeps its native transaction and deterministic statement-close APIs. */
export type PrivateBunSqliteDatabase = {
  readonly isTransaction: boolean;
  exec: (statement: string) => void;
  prepare: (statement: string) => {
    all: (...bindings: NativeInput[]) => Record<string, NativeOutput>[];
    get: (
      ...bindings: NativeInput[]
    ) => Record<string, NativeOutput> | undefined;
    run: (...bindings: NativeInput[]) => { changes: number | bigint };
  };
  transactionSync: SqliteOwner["transactionSync"];
  close: () => void;
};

/** The actual Node connection or Local's explicit native Bun adapter. */
export type PrivateSqliteDatabase = DatabaseSync | PrivateBunSqliteDatabase;

const bunSqlite = Object.hasOwn(process.versions, "bun")
  ? await import("bun:sqlite")
  : undefined;

/**
 * How long a reader waits out a live runtime's commit. Stores use a rollback
 * journal, so a commit briefly locks readers out; a reader that gives up at
 * once would read a busy store as an unreadable one.
 */
const readBusyTimeoutMs = 250;

/**
 * How long a store's writer waits out a reader's shared lock before its
 * commit fails. Status reads and the Board read a live store; a reader holds
 * its lock for one statement, so this bounds a rare wait, never a hang.
 */
export const storeWriteBusyTimeoutMs = 2_000;

/**
 * A listing owns this database until its existing finally close. Bun's
 * node:sqlite prepare/close leaves native statements alive until GC. Native
 * close(true) on the native Bun driver explicitly finalizes every statement
 * before releasing the connection, including when a read or decoding fails.
 */
export function openPrivateReadOnlySqliteDatabase(
  path: string,
  timeout = readBusyTimeoutMs,
): PrivateSqliteDatabase {
  return openPrivateSqliteDatabase(path, true, timeout);
}

/** Writable connections own their statements through deterministic close. */
export function openPrivateWritableSqliteDatabase(
  path: string,
  timeout: number,
): PrivateSqliteDatabase {
  return openPrivateSqliteDatabase(path, false, timeout);
}

function openPrivateSqliteDatabase(
  path: string,
  readOnly: boolean,
  timeout: number,
): PrivateSqliteDatabase {
  if (bunSqlite === undefined)
    return new DatabaseSync(path, { readOnly, timeout });
  const database = new bunSqlite.Database(path, {
    readonly: readOnly,
    create: !readOnly,
    strict: true,
  });
  try {
    database.run(`PRAGMA busy_timeout = ${String(timeout)}`);
    if (!readOnly) database.run("PRAGMA foreign_keys = ON");
  } catch (cause) {
    database.close(true);
    throw cause;
  }
  return {
    get isTransaction() {
      return database.inTransaction;
    },
    exec: (statement) => {
      database.run(statement);
    },
    prepare: (statement) => {
      const query = database.prepare<
        Record<string, NativeOutput>,
        NativeInput[]
      >(statement);
      return {
        all: (...bindings) => query.all(...bindings),
        get: (...bindings) => query.get(...bindings) ?? undefined,
        run: (...bindings) => query.run(...bindings),
      };
    },
    transactionSync: (operation) => database.transaction(operation)(),
    close: () => {
      database.close(true);
    },
  };
}

export type PrivateSqliteFailureCode =
  "busy" | "locked" | "corrupt" | "not_a_database" | "other";

const sqliteFailureSchema = z.union([
  z
    .object({
      code: z.literal("ERR_SQLITE_ERROR"),
      errcode: z.number().int(),
    })
    .transform((failure) => failure.errcode),
  z
    .object({
      code: z.string().startsWith("SQLITE_"),
      errno: z.number().int(),
    })
    .transform((failure) => failure.errno),
]);
const sqlitePrimaryCodeMask = 0xff;

/** Decode the maintained drivers' structured result codes before sanitizing. */
export function privateSqliteFailureCode(
  cause: unknown,
): PrivateSqliteFailureCode | undefined {
  const parsed = sqliteFailureSchema.safeParse(cause);
  if (!parsed.success) return undefined;
  switch (parsed.data & sqlitePrimaryCodeMask) {
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

/**
 * Keep Local's native failure reporting around a host-supplied SQL owner.
 * The supplied owner retains transaction mechanics and connection lifetime.
 */
export function observePrivateSqliteOwner(
  owner: SqliteOwner,
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
        try {
          return owner.sql.exec(statement, ...bindings);
        } catch (cause) {
          return observeFailure(cause);
        }
      },
    }),
    transactionSync: <Value>(operation: () => Value): Value => {
      try {
        return owner.transactionSync(operation);
      } catch (cause) {
        return observeFailure(cause);
      }
    },
  });
}

/** Adapt one synchronous native database to Shiitake's public owner shape. */
export function createPrivateSqliteOwner(
  database: PrivateSqliteDatabase,
  onFailure?: (code: PrivateSqliteFailureCode) => void,
): SqliteOwner {
  if (database instanceof DatabaseSync)
    return observePrivateSqliteOwner(fromNodeSqlite(database), onFailure);
  return observePrivateSqliteOwner(
    {
      sql: {
        exec: (statement, ...bindings) => {
          const prepared = database.prepare(statement);
          const values = bindings.map(nativeInput);
          const rows = readerStatement.test(statement)
            ? prepared.all(...values).map(nativeRow)
            : (prepared.run(...values), []);
          return Object.freeze({
            toArray: () => rows.map((row) => decodeSqliteRow(row)),
            one: () => {
              const row = rows[0];
              if (row === undefined) throw new Error("Expected one SQLite row");
              return decodeSqliteRow(row);
            },
          });
        },
      },
      transactionSync: database.transactionSync,
    },
    onFailure,
  );
}
