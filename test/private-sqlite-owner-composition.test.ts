import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import { expect, it } from "vitest";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import {
  createPrivateSqliteOwner,
  observePrivateSqliteOwner,
  type PrivateSqliteFailureCode,
} from "../src/private-sqlite-owner.js";

it("Local reports native SQL failures, rolls back the operation and leaves connection lifetime with its host", () => {
  const database = new DatabaseSync(":memory:");
  const failures: PrivateSqliteFailureCode[] = [];
  const owner = createPrivateSqliteOwner(database, (code) => {
    failures.push(code);
  });
  database.exec("CREATE TABLE effects (value TEXT)");
  try {
    let nativeFailure: unknown;
    assert.throws(
      () => {
        owner.transactionSync(() => {
          owner.sql.exec("INSERT INTO effects VALUES (?)", "rolled back");
          try {
            owner.sql.exec("SELECT * FROM missing");
          } catch (cause) {
            nativeFailure = cause;
            throw cause;
          }
        });
      },
      (cause: unknown) => cause === nativeFailure,
    );
    expect(failures).toContain("other");
    expect(
      owner.sql.exec("SELECT count(*) AS count FROM effects").one(),
    ).toEqual({
      count: 0,
    });
    expect(database.prepare("SELECT 42 AS value").get()?.value).toBe(42);
  } finally {
    database.close();
  }
});

it("Local reporting preserves the maintained owner's nested savepoints on the same host-owned connection", () => {
  const database = new DatabaseSync(":memory:");
  const failures: PrivateSqliteFailureCode[] = [];
  const owner = observePrivateSqliteOwner(fromNodeSqlite(database), (code) => {
    failures.push(code);
  });
  database.exec("CREATE TABLE effects (value TEXT)");
  try {
    owner.transactionSync(() => {
      owner.sql.exec("INSERT INTO effects VALUES (?)", "outer");
      let nativeFailure: unknown;
      assert.throws(
        () => {
          owner.transactionSync(() => {
            owner.sql.exec("INSERT INTO effects VALUES (?)", "inner");
            try {
              owner.sql.exec("SELECT * FROM missing");
            } catch (cause) {
              nativeFailure = cause;
              throw cause;
            }
          });
        },
        (cause: unknown) => cause === nativeFailure,
      );
      expect(failures).toContain("other");
      expect(database.isTransaction).toBe(true);
      expect(owner.sql.exec("SELECT value FROM effects").toArray()).toEqual([
        { value: "outer" },
      ]);
    });
    expect(database.isTransaction).toBe(false);
    expect(database.prepare("SELECT value FROM effects").all()).toEqual([
      { value: "outer" },
    ]);
    const failure = new Error("host operation failed");
    assert.throws(
      () =>
        owner.transactionSync(() => {
          owner.transactionSync(() => {
            owner.sql.exec("INSERT INTO effects VALUES (?)", "released inner");
          });
          throw failure;
        }),
      (cause: unknown) => cause === failure,
    );
    expect(database.prepare("SELECT value FROM effects").all()).toEqual([
      { value: "outer" },
    ]);
  } finally {
    database.close();
  }
});
