import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const execute = promisify(execFile);
// A compiled launcher cold-starts a Bun process; 2s sat at twice its quiet-box
// time and killed the query on a loaded box.
const queryOptions = { timeout: 10_000, maxBuffer: 4_096 };
const buildId = z.string().regex(/^[a-f0-9]{64}$/u);

function installedLauncherOnPath(): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile("which", ["fungi"], queryOptions, (error, stdout) => {
      if (error === null) resolve(stdout.trim());
      // which exits 1 when nothing named fungi is installed on PATH.
      else if (error.code === 1) resolve(undefined);
      else
        reject(
          new Error("Could not look up the installed fungi launcher", {
            cause: error,
          }),
        );
    });
  });
}

/**
 * Read the installed producer, never the calling window's frozen environment.
 * Undefined means no fungi is installed on PATH, so no client is current.
 */
export async function readInstalledLocalClientBuildId(
  launcher?: string,
): Promise<string | undefined> {
  const found = launcher ?? (await installedLauncherOnPath());
  if (found === undefined) return undefined;
  const installed = await realpath(found);
  if (basename(installed) === "fungi.cjs") {
    // npm replaces cli.js in place. This is the launcher's own identity rule.
    return createHash("sha256")
      .update(await readFile(join(dirname(installed), "cli.js")))
      .digest("hex");
  }
  // Compiled launchers identify their embedded archive, not executable bytes.
  const { stdout } = await execute(
    installed,
    ["--internal-build-id"],
    queryOptions,
  );
  return buildId.parse(JSON.parse(stdout));
}
