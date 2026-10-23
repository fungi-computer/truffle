import { it } from "vitest";
import {
  nativeApprovalDriverReplay,
  nativeApprovalDriverRollback,
} from "./private-sqlite-approval-driver.fixture.js";
it(
  "Local's real Node driver stages, answers and replays a canonical effect across reopen",
  nativeApprovalDriverReplay,
);
it(
  "Local's real Node driver rolls back canonical intent and released inner decisions atomically",
  nativeApprovalDriverRollback,
);
