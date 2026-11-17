import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { logEvent } from "./log-event.js";

const execFileAsync = promisify(execFile);

/**
 * A command the Computer starts is its own session leader, and its session id
 * is its pid. A process may leave the leader's process group (timeout(1) calls
 * setpgid) but not its session, so the session is what still holds every
 * process the command started. Signal it with the platform's pkill, never by
 * reading process tables here: procps pkill and BSD pkill both take `-s`.
 *
 * pkill and pgrep exit 0 when they matched a process, 1 when none matched. A
 * host without them still has the group signal, so a missing tool is logged and
 * reads as "nothing matched", never a failed Stop.
 */
function checked(sessionId: number): string {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 1)
    throw new Error("Refusing to signal an unsafe session id");
  return String(sessionId);
}

function hasCode(cause: unknown, code: number | string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

function missingTool(tool: "pkill" | "pgrep"): false {
  logEvent("process-sessions.tool", new Error(`${tool} is not installed`));
  return false;
}

/** Signal every process of one session; false when none could be matched. */
export async function signalSession(
  sessionId: number,
  signal: "TERM" | "KILL",
): Promise<boolean> {
  try {
    await execFileAsync("pkill", [`-${signal}`, "-s", checked(sessionId)], {
      timeout: 5_000,
    });
    return true;
  } catch (cause) {
    if (hasCode(cause, 1)) return false;
    if (hasCode(cause, "ENOENT")) return missingTool("pkill");
    throw cause;
  }
}

/** Synchronous form for a host that is itself exiting. */
export function signalSessionNow(
  sessionId: number,
  signal: "TERM" | "KILL",
): boolean {
  const result = spawnSync("pkill", [`-${signal}`, "-s", checked(sessionId)], {
    timeout: 5_000,
  });
  if (result.error !== undefined) {
    if (hasCode(result.error, "ENOENT")) return missingTool("pkill");
    throw result.error;
  }
  return result.status === 0;
}

/** Whether any process of the session still exists. */
export async function sessionAlive(sessionId: number): Promise<boolean> {
  try {
    await execFileAsync("pgrep", ["-s", checked(sessionId)], {
      timeout: 5_000,
    });
    return true;
  } catch (cause) {
    if (hasCode(cause, 1)) return false;
    if (hasCode(cause, "ENOENT")) return missingTool("pgrep");
    throw cause;
  }
}
