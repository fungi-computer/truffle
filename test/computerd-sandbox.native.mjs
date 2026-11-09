import assert from "node:assert/strict";
import { mkdir, mkdtemp, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { log } from "node:console";
import { TextDecoder } from "node:util";
import { URL, fileURLToPath } from "node:url";
import { newWebSocketRpcSession } from "@fungi.computer/capnweb";
import { startLocalComputerd } from "../dist/private-local-computer-backend.js";

const scratch = fileURLToPath(new URL("../.botanical/", import.meta.url));
await mkdir(scratch, { recursive: true });
const folder = await mkdtemp(join(scratch, "computerd-sandbox-"));
const daemon = await startLocalComputerd({ root: folder });
const rpc = newWebSocketRpcSession(`ws://127.0.0.1:${daemon.port}/ws`);
async function exec(source) {
  const result = await rpc.shell.exec({ source, cwd: folder });
  let output = "";
  let code;
  for await (const event of result.events) {
    if (event.name === "exit") code = event.code;
    else output += new TextDecoder().decode(event.value);
  }
  return { code, output };
}
try {
  const denied = await exec("touch ~/x");
  assert.equal(denied.code, 1);
  log("PASS touch ~/x denied by Workspace sandbox");
  const outside = await exec("touch ../outside-x");
  assert.ok(Number.isSafeInteger(outside.code));
  assert.notEqual(
    outside.code,
    0,
    "the existing parent directory is outside the writable folder",
  );
  const writable = await exec("touch ./x");
  assert.equal(writable.code, 0, writable.output);
  await access(join(folder, "x"));
  log("PASS touch ./x writes inside Computer folder");
  const hello = await exec("echo hello");
  assert.equal(hello.code, 0);
  assert.equal(hello.output.trim(), "hello");
  log("PASS echo hello outputs hello and exits 0");
} finally {
  rpc[Symbol.dispose]();
  await daemon.stop();
  await rm(folder, { recursive: true, force: true });
}
