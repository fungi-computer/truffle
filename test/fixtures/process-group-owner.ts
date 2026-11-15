import { createPrivateLocalComputerProcesses } from "../../src/private-local-computer-processes.js";

// A stand-in service: owns one running command group, reports it, then waits
// to be killed without any chance to run its own cleanup. It can never outlive
// its test: it exits when its parent closes its stdin pipe (the parent died or
// let go) and, regardless, after a hard timeout well above any test budget.
// Exiting runs the process manager's exit hook, which ends the command group.
const hardTimeoutMs = 120_000;
const root = process.argv[2];
const home = process.argv[3];
if (root === undefined || home === undefined)
  throw new Error("Missing fixture directories");
const processes = createPrivateLocalComputerProcesses(root, home);
const started = await processes
  .scope("fixture")
  .start({ kind: "shell", command: "sleep 600" }, root, process.env.PATH ?? "");
console.log(JSON.stringify({ id: started.id }));
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
process.stdin.resume();
// A real timer, not a loop: it is the hard cap and keeps the event loop alive.
setTimeout(() => process.exit(0), hardTimeoutMs);
