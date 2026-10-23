import { test } from "bun:test";
import {
  nativeApprovalDriverReplay,
  nativeApprovalDriverRollback,
} from "./private-sqlite-approval-driver.fixture.js";
test(
  "Local's real Bun driver stages, answers and replays a canonical effect across reopen",
  nativeApprovalDriverReplay,
);
test(
  "Local's real Bun driver rolls back canonical intent and released inner decisions atomically",
  nativeApprovalDriverRollback,
);
