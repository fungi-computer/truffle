import { test } from "bun:test";
import { assertLocalApprovalProjection } from "./fixtures/local-approval-projection.js";
import {
  assertLocalSqliteNestedTransactions,
  assertLocalSqliteOwnedLifetime,
} from "./fixtures/local-sqlite-driver-laws.js";

test(
  "Local's native Bun wrapper commits nested transactions",
  assertLocalSqliteNestedTransactions,
);
test(
  "Local's native Bun wrapper stays host-owned and finalizes on host close",
  assertLocalSqliteOwnedLifetime,
);
test(
  "Local's native Bun owner supports real canonical submit/get projection",
  assertLocalApprovalProjection,
);
