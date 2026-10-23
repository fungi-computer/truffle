import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Schema from "effect/Schema";
import { expect, expectTypeOf, it } from "vitest";
import type { SqliteRow, SqliteValue } from "@fungi.computer/shiitake";
import {
  createPrivateSqliteOwner,
  openPrivateReadOnlySqliteDatabase,
  openPrivateWritableSqliteDatabase,
  privateSqliteFailureCode,
} from "../src/private-sqlite-owner.js";

it("preserves writable timeout, foreign keys, transaction state and changed rows", () => {
  const database = openPrivateWritableSqliteDatabase(":memory:", 125);
  try {
    expect(database.prepare("PRAGMA busy_timeout").get()?.timeout).toBe(125);
    expect(database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    database.exec("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
    database.exec(
      "CREATE TABLE child (parent_id INTEGER REFERENCES parent(id))",
    );
    expect(database.prepare("SELECT * FROM parent").get()).toBeUndefined();
    expect(() =>
      database.prepare("INSERT INTO child VALUES (?)").run(1),
    ).toThrow();
    expect(database.isTransaction).toBe(false);
    database.exec("BEGIN IMMEDIATE");
    expect(database.isTransaction).toBe(true);
    expect(
      database.prepare("INSERT INTO parent VALUES (?)").run(1).changes,
    ).toBe(1);
    database.exec("ROLLBACK");
    expect(database.isTransaction).toBe(false);
    expect(database.prepare("SELECT * FROM parent").get()).toBeUndefined();
  } finally {
    database.close();
  }
});

it("keeps the read-only driver's scalars, bindings and errors at the same owner boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "local-readonly-sqlite-"));
  const path = join(root, "agent.sqlite");
  const writer = new DatabaseSync(path);
  writer.exec("CREATE TABLE facts (text TEXT)");
  writer.close();
  const database = openPrivateReadOnlySqliteDatabase(path);
  try {
    const owner = createPrivateSqliteOwner(database);
    expect(
      owner.sql
        .exec(
          "SELECT ? AS bytes, ? AS label, ? AS count",
          new Uint8Array([1, 2]).buffer,
          "read-only",
          42,
        )
        .one(),
    ).toEqual({
      bytes: new Uint8Array([1, 2]).buffer,
      label: "read-only",
      count: 42,
    });
    expect(database.prepare("SELECT text FROM facts").get()).toBeUndefined();
    expect(() =>
      owner.sql.exec("INSERT INTO facts VALUES ('refused')"),
    ).toThrow();
    assert.throws(
      () => database.prepare("SELECT * FROM missing").all(),
      (cause: unknown) => privateSqliteFailureCode(cause) === "other",
    );
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

it("returns the shared native row grammar for every SQLite scalar", () => {
  using database = new DatabaseSync(":memory:");
  const owner = createPrivateSqliteOwner(database);
  const row = owner.sql
    .exec(
      "SELECT ? AS bytes, ? AS label, ? AS count, NULL AS missing",
      new Uint8Array([1, 2]).buffer,
      "native",
      42,
    )
    .one();
  expectTypeOf(row).toEqualTypeOf<SqliteRow>();
  expectTypeOf(owner.sql.exec).parameters.toEqualTypeOf<
    [statement: string, ...bindings: SqliteValue[]]
  >();
  expect(row).toEqual({
    bytes: new Uint8Array([1, 2]).buffer,
    label: "native",
    count: 42,
    missing: null,
  });
  expect(
    owner.sql.exec("SELECT 1 AS count UNION ALL SELECT 2").toArray(),
  ).toEqual([{ count: 1 }, { count: 2 }]);
  expect(() => owner.sql.exec("SELECT 1 WHERE 0").one()).toThrow(
    "Expected exactly one SQLite row; got 0",
  );
});

it("requires the query owner's schema to qualify a selected projection", () => {
  using database = new DatabaseSync(":memory:");
  const owner = createPrivateSqliteOwner(database);
  const decodeCount = Schema.decodeUnknownSync(
    Schema.Struct({ count: Schema.Number }),
  );
  expect(decodeCount(owner.sql.exec("SELECT 42 AS count").one())).toEqual({
    count: 42,
  });
  expect(() =>
    decodeCount(owner.sql.exec("SELECT 'invalid' AS count").one()),
  ).toThrow(Schema.SchemaError);
});
