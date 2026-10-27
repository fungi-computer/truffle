import { setTimeout as delay } from "node:timers/promises";
import { identifyLocalServiceProcess } from "./private-local-process-identity.js";
import {
  readServiceLeaseOwner,
  type ServiceLeaseOwner,
} from "./private-local-service-lease.js";

/** How long a SIGTERM'd service may drain its owners before it is killed. */
const terminationGraceMs = 5_000;
const terminationPollMs = 50;

/**
 * Whether `service` is still the process running under its PID. A PID whose
 * start differs is refused. A separate read and signal still has a race window.
 */
async function isServiceProcess(
  directory: string,
  service: ServiceLeaseOwner,
): Promise<boolean> {
  const current = await identifyLocalServiceProcess({ ...service, directory });
  if (current.kind === "other" && process.platform !== "linux")
    throw new Error(
      `Cannot safely stop Fungi service pid ${String(service.pid)} in ${directory}: its command line does not identify this service. No process was signalled.`,
    );
  return current.kind === "ours";
}

/** Signal `pid`; false when it has already exited. */
function signalService(pid: number, signal: "SIGTERM" | "SIGKILL"): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
      return false;
    if (cause instanceof Error && "code" in cause && cause.code === "EPERM")
      throw new Error(
        `The Fungi service process ${String(pid)} belongs to another user, so fungi stop may not signal it. Stop it as that user (for example \`sudo kill ${String(pid)}\`), then retry.`,
        { cause },
      );
    throw cause;
  }
}

/** Signal `service` only while its PID still names that same process. */
async function signalIfStillRunning(
  directory: string,
  service: ServiceLeaseOwner,
  signal: "SIGTERM" | "SIGKILL",
): Promise<boolean> {
  const owner = await readServiceLeaseOwner(directory);
  if (owner?.pid !== service.pid || owner.startedAt !== service.startedAt)
    return false;
  return (
    (await isServiceProcess(directory, owner)) &&
    signalService(owner.pid, signal)
  );
}

async function exitedWithin(
  directory: string,
  service: ServiceLeaseOwner,
  ms: number,
): Promise<boolean> {
  const deadline = Date.now() + ms;
  for (;;) {
    if (!(await isServiceProcess(directory, service))) return true;
    if (Date.now() >= deadline) return false;
    await delay(terminationPollMs);
  }
}

/**
 * SIGTERM the service, wait up to five seconds for it to exit, then SIGKILL.
 * A hung owner drain can no longer leave a discoverable but unusable service.
 * Each signal first checks that the PID still names the recorded process.
 */
export async function terminatePrivateLocalService(
  directory: string,
  service: ServiceLeaseOwner,
): Promise<"stopped" | "killed"> {
  // A listener run inside its caller (tests, embedded hosts) would otherwise
  // be SIGKILLed together with that caller.
  if (service.pid === process.pid)
    throw new Error(
      "The Fungi service runs inside this process; stop it from within instead of with fungi stop.",
    );
  if (!(await signalIfStillRunning(directory, service, "SIGTERM")))
    return "stopped";
  if (await exitedWithin(directory, service, terminationGraceMs))
    return "stopped";
  if (!(await signalIfStillRunning(directory, service, "SIGKILL")))
    return "stopped";
  if (await exitedWithin(directory, service, terminationGraceMs))
    return "killed";
  throw new Error(
    `Local service process ${String(service.pid)} is still running after SIGKILL`,
  );
}
