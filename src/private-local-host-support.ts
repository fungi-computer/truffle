import { z } from "zod";

const nodeReportSchema = z.looseObject({
  header: z.looseObject({ glibcVersionRuntime: z.string().optional() }),
});

/** The glibc line below which the OS sandbox's native package cannot run. */
const sandboxGlibc = { major: 2, minor: 35 } as const;

export type NativeSandboxHost =
  | Readonly<{ kind: "supported" }>
  | Readonly<{ kind: "unsupported"; reason: string }>;

/** The glibc the running process links, when Node or Bun reports one. */
function runningGlibc(): string | undefined {
  return process.platform === "linux"
    ? nodeReportSchema.parse(process.report.getReport()).header
        .glibcVersionRuntime
    : undefined;
}

/**
 * Whether this host can run the OS sandbox. The Spore launcher
 * (`apps/tui/scripts/fungi.cjs`) applies the same line before the CLI starts.
 * A Linux host older than glibc 2.35 runs Full access only, and never uses the
 * native package, whether or not npm installed it. An unreadable glibc is not
 * proof the host cannot sandbox: the launcher already refused musl.
 */
export function nativeSandboxHost(
  platform: string = process.platform,
  glibc: string | undefined = runningGlibc(),
): NativeSandboxHost {
  if (platform !== "linux" || glibc === undefined) return { kind: "supported" };
  const [major, minor] = glibc.split(".").map(Number);
  if (
    major === undefined ||
    minor === undefined ||
    Number.isNaN(major) ||
    Number.isNaN(minor) ||
    major > sandboxGlibc.major ||
    (major === sandboxGlibc.major && minor >= sandboxGlibc.minor)
  )
    return { kind: "supported" };
  return {
    kind: "unsupported",
    reason: `The OS sandbox needs glibc ${String(sandboxGlibc.major)}.${String(sandboxGlibc.minor)} or newer and this host has glibc ${glibc}. Full access runs without it; Workspace and Read-only are not available here.`,
  };
}
