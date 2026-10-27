import assert from "node:assert/strict";
import { createPrivateLocalServiceManager } from "../../src/private-local-service.js";

const directory = process.argv[2];
if (directory === undefined) throw new Error("fixture requires its directory");
// This fixture's argv lacks --internal-service <directory>, so macOS cannot
// corroborate its lease identity even though its PID and lease row agree.
Object.defineProperty(process, "platform", { value: "darwin" });
await assert.rejects(
  createPrivateLocalServiceManager({ directory }).stop(),
  /command line does not identify this service.*No process was signalled/u,
);
