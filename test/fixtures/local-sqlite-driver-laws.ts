import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPrivateSqliteOwner,
  openPrivateWritableSqliteDatabase,
  type PrivateSqliteFailureCode,
} from "../../src/private-sqlite-owner.js";

/** The production opener selects the real driver of the current runtime. */
export function assertLocalSqliteNestedTransactions() {
  const database = openPrivateWritableSqliteDatabase(":memory:", 0);
  try {
    assert.equal(
      database instanceof DatabaseSync,
      !Object.hasOwn(process.versions, "bun"),
    );
    const failures: PrivateSqliteFailureCode[] = [];
    const owner = createPrivateSqliteOwner(database, (code) => {
      failures.push(code);
    });
    owner.sql.exec("CREATE TABLE effects (value TEXT)");
    assert.doesNotThrow(() => {
      owner.transactionSync(() => {
        owner.sql.exec("INSERT INTO effects VALUES (?)", "outer");
        owner.transactionSync(() => {
          owner.sql.exec("INSERT INTO effects VALUES (?)", "inner");
        });
      });
    }, "the actual Local driver must commit nested synchronous transactions");
    assert.deepEqual(
      owner.sql.exec("SELECT value FROM effects ORDER BY rowid").toArray(),
      [{ value: "outer" }, { value: "inner" }],
    );
    const failure = new Error("outer host operation aborted");
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
    assert.deepEqual(
      owner.sql.exec("SELECT value FROM effects ORDER BY rowid").toArray(),
      [{ value: "outer" }, { value: "inner" }],
    );
    owner.transactionSync(() => {
      let nativeFailure: unknown;
      assert.throws(
        () => {
          owner.transactionSync(() => {
            owner.sql.exec(
              "INSERT INTO effects VALUES (?)",
              "rolled back inner",
            );
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
      assert.ok(failures.includes("other"));
      assert.equal(database.isTransaction, true);
      owner.sql.exec("INSERT INTO effects VALUES (?)", "outer survived");
    });
    assert.equal(database.isTransaction, false);
    assert.deepEqual(
      owner.sql.exec("SELECT value FROM effects ORDER BY rowid").toArray(),
      [{ value: "outer" }, { value: "inner" }, { value: "outer survived" }],
    );
  } finally {
    database.close();
  }
}

export function assertLocalSqliteOwnedLifetime() {
  const root = mkdtempSync(join(tmpdir(), "local-driver-lifetime-"));
  const path = join(root, "agent.sqlite");
  try {
    const database = openPrivateWritableSqliteDatabase(path, 0);
    const held = database.prepare("SELECT 42 AS value");
    try {
      const owner = createPrivateSqliteOwner(database);
      owner.sql.exec("CREATE TABLE effects (value TEXT)");
      owner.transactionSync(() => {
        owner.sql.exec("INSERT INTO effects VALUES (?)", "committed");
      });
      assert.equal(
        held.get()?.value,
        42,
        "the owner must not close the host's connection",
      );
    } finally {
      database.close();
    }
    assert.throws(() => held.all(), "host close must finalize held statements");
    assert.throws(() => database.prepare("SELECT 1").get());
    const reopened = openPrivateWritableSqliteDatabase(path, 0);
    try {
      assert.deepEqual(
        createPrivateSqliteOwner(reopened)
          .sql.exec("SELECT value FROM effects")
          .toArray(),
        [{ value: "committed" }],
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
