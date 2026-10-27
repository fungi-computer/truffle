import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { z } from "zod";

const procStartSchema = z.string().regex(/^\d+$/u);
const execFileAsync = promisify(execFile);

/** Signal 0 checks existence, not identity; EPERM is still a live process. */
function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause) {
      if (cause.code === "ESRCH") return true;
      if (cause.code === "EPERM") return false;
    }
    throw cause;
  }
}

export type ServiceProcessIdentity =
  | Readonly<{ kind: "ours"; evidence: "start-time" | "command-line" }>
  | Readonly<{ kind: "other" }>
  | Readonly<{ kind: "gone" }>;

/**
 * A process-start discriminator. `unverifiable` means no sufficiently precise
 * reader is implemented on this platform.
 */
export type ProcessStart =
  | Readonly<{ kind: "running"; start: string }>
  | Readonly<{ kind: "gone" }>
  | Readonly<{ kind: "unverifiable" }>;

/**
 * Linux reads proc(5)'s `starttime` (field 22 of `/proc/<pid>/stat`, in clock
 * ticks since boot). macOS's ps lstart is only second-resolution and is not
 * accepted as signal authority. No sub-second macOS reader is implemented.
 */
export async function readProcessStart(pid: number): Promise<ProcessStart> {
  if (process.platform === "linux") {
    let stat: string;
    try {
      stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
    } catch (cause) {
      // The process may exit after procfs opened stat but before it was read.
      if (
        cause instanceof Error &&
        "code" in cause &&
        (cause.code === "ENOENT" || cause.code === "ESRCH")
      )
        return { kind: "gone" };
      throw cause;
    }
    // Field 2 is the parenthesised command name, which may itself contain
    // spaces or parentheses; the fields after its last `)` are plain.
    const start = procStartSchema.safeParse(
      stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
    );
    return start.success
      ? { kind: "running", start: `linux:${start.data}` }
      : { kind: "unverifiable" };
  }
  return { kind: "unverifiable" };
}

/** Never signal a PID merely because a lease names it. */
export async function identifyLocalServiceProcess(
  claim: Readonly<{ pid: number; startedAt: string; directory: string }>,
): Promise<ServiceProcessIdentity> {
  const start = await readProcessStart(claim.pid);
  if (start.kind === "gone") return { kind: "gone" };
  if (start.kind === "running")
    return start.start === claim.startedAt
      ? { kind: "ours", evidence: "start-time" }
      : { kind: "other" };
  if (process.platform !== "darwin") return { kind: "other" };
  if (processIsGone(claim.pid)) return { kind: "gone" };
  // ps is only a corroborating channel after the caller has checked the
  // matching service.json and owner.sqlite lease. Its output is bounded; an
  // unreadable or different argv never grants signal authority.
  let argv: string;
  try {
    ({ stdout: argv } = await execFileAsync(
      "ps",
      ["-p", String(claim.pid), "-o", "args="],
      { timeout: 2_000, maxBuffer: 4_096 },
    ));
  } catch {
    return processIsGone(claim.pid) ? { kind: "gone" } : { kind: "other" };
  }
  const marker = `--internal-service ${claim.directory}`;
  const offset = argv.indexOf(marker);
  return offset >= 0 &&
    (offset === 0 || /\s/u.test(argv[offset - 1] ?? "")) &&
    (offset + marker.length === argv.trimEnd().length ||
      /\s/u.test(argv[offset + marker.length] ?? ""))
    ? { kind: "ours", evidence: "command-line" }
    : { kind: "other" };
}

/** The owner's start discriminator; an unverifiable marker never permits signalling. */
export async function readOwnProcessStart(): Promise<string> {
  const own = await readProcessStart(process.pid);
  if (own.kind === "unverifiable") return "unverifiable";
  if (own.kind === "gone")
    throw new Error(
      "The Fungi service cannot read its own process start time.",
    );
  return own.start;
}
