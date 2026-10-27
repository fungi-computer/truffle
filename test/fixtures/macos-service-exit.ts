import assert from "node:assert/strict";
import { join } from "node:path";
import { spawn, sleep } from "bun";
import { identifyLocalServiceProcess } from "../../src/private-local-process-identity.js";
import { createPrivateLocalServiceManager } from "../../src/private-local-service.js";
import { readServiceRegistration } from "../../src/private-local-service-discovery.js";

const directory = process.argv[2];
const mode = process.argv[3];
if (directory === undefined || (mode !== "identity" && mode !== "stop"))
  throw new Error("fixture requires service directory and identity|stop");

// The lease owner really exists; only this inspecting client impersonates
// darwin. Its argv contains the service marker ps must corroborate.
const child = spawn(
  [
    process.execPath,
    join(import.meta.dir, "other-protocol-service.ts"),
    directory,
    "--internal-service",
    directory,
  ],
  { stdout: "ignore", stderr: "inherit" },
);
try {
  let registration;
  for (let attempt = 0; attempt < 160; attempt += 1) {
    registration = await readServiceRegistration(directory);
    if (registration?.kind === "other-protocol") break;
    await sleep(25);
  }
  assert.equal(registration?.kind, "other-protocol");
  const claim = {
    pid: child.pid,
    startedAt: registration.lifecycle.startedAt,
    directory,
  };
  Object.defineProperty(process, "platform", { value: "darwin" });
  assert.deepEqual(await identifyLocalServiceProcess(claim), {
    kind: "ours",
    evidence: "command-line",
  });
  assert.deepEqual(
    await identifyLocalServiceProcess({
      ...claim,
      directory: `${directory}-foreign`,
    }),
    { kind: "other" },
  );
  if (mode === "stop") {
    assert.deepEqual(
      await createPrivateLocalServiceManager({ directory }).stop(),
      { kind: "stopped" },
    );
  } else {
    child.kill("SIGTERM");
  }
  await child.exited;
  assert.deepEqual(await identifyLocalServiceProcess(claim), { kind: "gone" });
} finally {
  child.kill("SIGKILL");
  await child.exited;
}
