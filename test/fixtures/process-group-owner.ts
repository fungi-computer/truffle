import { createPrivateLocalComputerProcesses } from "../../src/private-local-computer-processes.js";

// A stand-in service: owns one running command group, reports it, then waits
// to be killed without any chance to run its own cleanup.
const root = process.argv[2];
const home = process.argv[3];
if (root === undefined || home === undefined)
  throw new Error("Missing fixture directories");
const processes = createPrivateLocalComputerProcesses(root, home);
const started = await processes
  .scope("fixture")
  .start({ kind: "shell", command: "sleep 600" }, root, process.env.PATH ?? "");
console.log(JSON.stringify({ id: started.id }));
await new Promise<void>(() => undefined);
