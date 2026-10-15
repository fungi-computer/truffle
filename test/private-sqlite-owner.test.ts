import { DatabaseSync } from "node:sqlite";
import * as Schema from "effect/Schema";
import { expect, expectTypeOf, it } from "vitest";
import type { SqliteRow, SqliteValue } from "@fungi.computer/shiitake";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";

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
    "Expected one SQLite row",
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
