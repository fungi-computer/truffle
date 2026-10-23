import { readFile } from "node:fs/promises";
import { z } from "zod";

const procStartSchema = z.string().regex(/^\d+$/u);

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
