import { access, constants } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";
import * as ChildProcess from "effect/process/ChildProcess";
import type { FilesPatch, FilesPort } from "@fungi.computer/knapsack";
import type { InvocationContext } from "@fungi.computer/mycelium";
import { parsePatch } from "diff";
import * as Stream from "effect/Stream";
import {
  runPrivateInvocationProcess,
  type LocalSandboxLaunch,
} from "./private-invocation-computer.js";

function patchExecutable(): string {
  if (process.env.FUNGI_BUNDLED_CLI) {
    const name = `@fungi.computer/spore-native-${process.platform}-${process.arch}`;
    try {
      return createRequire(process.env.FUNGI_BUNDLED_CLI).resolve(
        `${name}/bin/fungi-apply-patch`,
      );
    } catch (cause) {
      throw new Error(
        `Missing ${name}; reinstall Fungi with npm optional dependencies enabled`,
        { cause },
      );
    }
  }
  return fileURLToPath(
    new URL("../native/bin/fungi-apply-patch", import.meta.url),
  );
}
const maximumPatchBytes = 128 * 1024;
const mismatchExitCode = 23;
const formatExitCode = 24;

/** Read-only recovery guidance for rejected standard unified-diff input. */
async function unifiedDiffContext(
  patch: string,
  read: FilesPort["read"],
  context: InvocationContext,
): Promise<string> {
  try {
    const unified = patch
      .replace(/^\*\*\* Begin Patch\r?\n/u, "")
      .replace(/\r?\n\*\*\* End Patch\s*$/u, "");
    const file = parsePatch(unified)[0];
    const hunk = file?.hunks[0];
    const path = file?.oldFileName.replace(/^a\//u, "");
    if (path === undefined || hunk === undefined || path === "/dev/null")
      return "\nInclude *** Update File: path/to/file before @@ to identify the target.\n";
    const current = await read(
      { path, offset: 0, limit: maximumPatchBytes },
      context,
    );
    if ("image" in current) throw new Error(`${path} is an image, not text`);
    const lines = current.content.split(/\r?\n/u);
    const from = Math.min(
      Math.max(0, hunk.oldStart - 3),
      Math.max(0, lines.length - 7),
    );
    const nearby = lines
      .slice(from, from + 7)
      .map(
        (line, index) =>
          `  ${String(from + index + 1)}: ${line.length > 160 ? line.slice(0, 160) + "…" : line}`,
      );
    return `\nCurrent lines in ${path.slice(0, 160)}:\n${nearby.join("\n")}\n${current.truncated ? "File preview is truncated at 128 KiB.\n" : ""}`;
  } catch (cause) {
    context.signal.throwIfAborted();
    return `\nCurrent file preview unavailable: ${cause instanceof Error ? cause.message.slice(0, 512) : "unified diff could not be decoded"}\n`;
  }
}

/** Advertise only a packaged native engine; never install tools during a model call. */
export async function createPrivateFilesPatch(
  root: string,
  read: FilesPort["read"],
  sandbox?: LocalSandboxLaunch,
): Promise<FilesPatch | undefined> {
  const executable = patchExecutable();
  try {
    await access(executable, constants.X_OK);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
  return async ({ patch }, context) => {
    context.signal.throwIfAborted();
    const bytes = new TextEncoder().encode(patch);
    if (bytes.byteLength > maximumPatchBytes)
      throw new Error("Patch exceeds the 128 KiB input bound");
    const launch = sandbox?.(root, [executable]);
    const env: NodeJS.ProcessEnv = { ...process.env, ...launch?.environment };
    if (launch !== undefined) {
      delete env.XDG_RUNTIME_DIR;
      delete env.DBUS_SESSION_BUS_ADDRESS;
    }
    const command = ChildProcess.make(
      launch?.executable ?? executable,
      launch?.args ?? [],
      {
        cwd: root,
        env,
        extendEnv: false,
        stdin: Stream.make(bytes),
        additionalFds:
          launch?.seccompFilter === undefined
            ? undefined
            : {
                fd3: {
                  type: "input",
                  stream: Stream.make(launch.seccompFilter),
                },
              },
      },
    );
    const result = await runPrivateInvocationProcess(
      command,
      context.signal,
      30_000,
    );
    if (result.status === "deadline_exceeded")
      return {
        status: "failed",
        exitCode: result.exitCode,
        stdout: result.stdout,
        stderr: `${result.stderr}\n${result.message} Earlier patch writes may remain.`,
        truncated: result.truncated,
      };
    if (result.status === "failed" && result.exitCode === formatExitCode)
      return {
        ...result,
        stderr:
          result.stderr + (await unifiedDiffContext(patch, read, context)),
      };
    return result.status === "failed" && result.exitCode === mismatchExitCode
      ? { ...result, error: { kind: "mismatch" as const } }
      : result;
  };
}
