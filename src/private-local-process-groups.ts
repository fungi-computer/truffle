import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { logEvent } from "./log-event.js";
import { promisify } from "node:util";
import {
  readProcessStart,
  type ProcessStart,
} from "./private-local-process-identity.js";

const execFileAsync = promisify(execFile);

/** `ps -o lstart=` in the C locale, e.g. `Thu Nov 12 10:00:00 2026`. */
const macStartPattern =
  /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [ 1-3]\d \d\d:\d\d:\d\d \d{4}$/u;

/**
 * Parse `ps -o lstart= -p <pid>` output. Empty output means no such process;
 * anything else that is not a start time is unverifiable, never a match.
 */
export function parseMacProcessStart(output: string): ProcessStart {
  const text = output.trim();
  if (text === "") return { kind: "gone" };
  return macStartPattern.test(text)
    ? { kind: "running", start: `darwin:${text}` }
    : { kind: "unverifiable" };
}

async function readMacPs(pid: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "lstart=", "-p", String(pid)],
      {
        timeout: 2_000,
        maxBuffer: 4_096,
        env: { ...process.env, LC_ALL: "C" },
      },
    );
    return stdout;
  } catch (cause) {
    // ps exits 1 with no output when the PID does not exist.
    if (cause instanceof Error && "code" in cause && cause.code === 1)
      return "";
    throw cause;
  }
}

/**
 * Start-time marker for process-group identity. macOS `lstart` has one-second
 * resolution, so it only guards group records here (a reused PID must also
 * start in the same second); it is not accepted as service signal authority.
 */
export async function readGroupProcessStart(
  pid: number,
  platform: NodeJS.Platform = process.platform,
  readPs: (pid: number) => Promise<string> = readMacPs,
): Promise<ProcessStart> {
  if (platform === "linux") return readProcessStart(pid);
  if (platform === "darwin") return parseMacProcessStart(await readPs(pid));
  return { kind: "unverifiable" };
}

/**
 * Each command the service starts runs in its own process group, so a killed
 * service (SIGKILL, watchdog exit, crash) leaves it running. Every group is
 * recorded here with the start time of its leader and of the owning service,
 * so a later stop or start can end exactly those groups and never a process
 * that merely reuses a PID.
 */
const groupRecordSchema = z.strictObject({
  groupId: z.number().int().min(2),
  /** `readGroupProcessStart` marker of the group leader when it was spawned. */
  leaderStart: z.string(),
  ownerPid: z.number().int().positive(),
  /** `readGroupProcessStart` marker of the owning service process. */
  ownerStart: z.string(),
});
type PrivateLocalProcessGroupRecord = z.output<typeof groupRecordSchema>;

const recordName = /^local_process_[A-Za-z0-9_-]+\.json$/u;

function directory(home: string): string {
  return join(home, ".fungi", "process-groups");
}

function recordPath(home: string, id: string): string {
  return join(directory(home), `${id}.json`);
}

function isErrno(cause: unknown, code: string): boolean {
  return cause instanceof Error && "code" in cause && cause.code === code;
}

/** Record a freshly spawned group; an unverifiable platform records nothing. */
export async function writeProcessGroupRecord(
  home: string,
  id: string,
  groupId: number,
): Promise<void> {
  const leader = await readGroupProcessStart(groupId);
  const owner = await readGroupProcessStart(process.pid);
  if (leader.kind !== "running" || owner.kind !== "running") return;
  await mkdir(directory(home), { recursive: true, mode: 0o700 });
  await writeFile(
    recordPath(home, id),
    JSON.stringify(
      groupRecordSchema.parse({
        groupId,
        leaderStart: leader.start,
        ownerPid: process.pid,
        ownerStart: owner.start,
      }),
    ),
    { mode: 0o600 },
  );
}

export async function removeProcessGroupRecord(
  home: string,
  id: string,
): Promise<void> {
  await rm(recordPath(home, id), { force: true });
}

function signalGroup(groupId: number, signal: "SIGKILL"): void {
  try {
    process.kill(-groupId, signal);
  } catch (cause) {
    if (!isErrno(cause, "ESRCH") && !isErrno(cause, "EPERM")) throw cause;
  }
}

/**
 * Kill the recorded groups of services that no longer run, then drop their
 * records. `owner` limits the sweep to one just-stopped service; omitted, it
 * covers every dead owner (service start). A live owner's groups are never
 * touched. A group whose leader PID now has a different start time was reused
 * and is left alone. Returns how many groups were signalled.
 */
export async function reapOrphanedProcessGroups(
  home: string,
  owner?: Readonly<{ pid: number; startedAt: string }>,
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(directory(home));
  } catch (cause) {
    if (isErrno(cause, "ENOENT")) return 0;
    throw cause;
  }
  let reaped = 0;
  for (const name of names) {
    if (!recordName.test(name)) continue;
    const path = join(directory(home), name);
    let record: PrivateLocalProcessGroupRecord;
    try {
      record = groupRecordSchema.parse(
        JSON.parse(await readFile(path, "utf8")),
      );
    } catch (cause) {
      logEvent("process-groups.record", cause);
      await rm(path, { force: true });
      continue;
    }
    if (
      owner !== undefined &&
      (record.ownerPid !== owner.pid || record.ownerStart !== owner.startedAt)
    )
      continue;
    const service = await readGroupProcessStart(record.ownerPid);
    if (service.kind === "running" && service.start === record.ownerStart)
      continue;
    const leader = await readGroupProcessStart(record.groupId);
    // A gone leader with living members still owns the group id: the kernel
    // does not reuse a PID that is a live process group. A running leader
    // must be the recorded one.
    if (leader.kind !== "running" || leader.start === record.leaderStart) {
      signalGroup(record.groupId, "SIGKILL");
      reaped += 1;
    }
    await rm(path, { force: true });
  }
  return reaped;
}
