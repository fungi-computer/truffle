import { it } from "vitest";
import {
  assertLocalSqliteNestedTransactions,
  assertLocalSqliteOwnedLifetime,
} from "./fixtures/local-sqlite-driver-laws.js";

it(
  "Local's actual Node DatabaseSync owner commits nested transactions",
  assertLocalSqliteNestedTransactions,
);
it(
  "Local's actual Node DatabaseSync stays host-owned and finalizes on host close",
  assertLocalSqliteOwnedLifetime,
);
