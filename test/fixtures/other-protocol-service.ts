// A Local service from a later release that speaks another protocol: it holds
// the lifetime lease and records its lifecycle fields in a shape this client
// does not read. SIGTERM releases its lease and ends it.
import writeFileAtomic from "write-file-atomic";
import { localServiceIds } from "../../src/private-local-service-ids.js";
import { readOwnProcessStart } from "../../src/private-local-process-identity.js";
import {
  acquireServiceLock,
  privateLocalServiceProtocol,
  recordPath,
  serviceDirectory,
} from "../../src/private-local-service-discovery.js";

const argument = process.argv[2];
if (argument === undefined) throw new Error("fixture requires its directory");
const directory = await serviceDirectory(argument);
const release = await acquireServiceLock(directory, "owner");
await writeFileAtomic(
  recordPath(directory),
  JSON.stringify({
    protocol: privateLocalServiceProtocol + 1,
    version: "a-later-release",
    serviceId: localServiceIds.service.generate(),
    pid: process.pid,
    startedAt: await readOwnProcessStart(),
    endpoint: { socket: "a shape this client cannot decode" },
  }),
  { mode: 0o600 },
);
// Hold the lease until SIGTERM, then release it and exit as a service would.
const alive = setInterval(() => undefined, 60_000);
process.once("SIGTERM", () => {
  clearInterval(alive);
  void release();
});
