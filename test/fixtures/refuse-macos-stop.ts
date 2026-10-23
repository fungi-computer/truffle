import assert from "node:assert/strict";
import { createPrivateLocalServiceManager } from "../../src/private-local-service.js";

const directory = process.argv[2];
if (directory === undefined) throw new Error("fixture requires its directory");
// Exercise the real stop path's platform refusal in an isolated client.
Object.defineProperty(process, "platform", { value: "darwin" });
await assert.rejects(
  createPrivateLocalServiceManager({ directory }).stop(),
  /cannot verify.*sub-second precision on darwin.*refuses to signal/u,
);
