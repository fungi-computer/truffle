import { it } from "vitest";
import { assertLocalApprovalProjection } from "./fixtures/local-approval-projection.js";

it(
  "the Local form projects the submitted ledger record and host-computed rights, separately from its ephemeral id",
  assertLocalApprovalProjection,
);
