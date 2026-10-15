import { execFile as execFileCallback } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const excludeEntry = ".fungi/";

/** Keep generated project state out of Git without changing tracked ignore rules. */
export async function ensurePrivateLocalGitExclude(
  projectRoot: string,
): Promise<void> {
  let common: string;
  try {
    const result = await execFile("git", ["rev-parse", "--git-common-dir"], {
      cwd: projectRoot,
    });
    common = resolve(projectRoot, result.stdout.trim());
  } catch (cause) {
    // A non-Git project still keeps its local Fungi store.
    if (cause instanceof Error && "code" in cause && cause.code === 128) return;
    throw cause;
  }

  const info = join(common, "info");
  await mkdir(info, { recursive: true });
  const exclude = join(info, "exclude");
  const current = await readFile(exclude, "utf8").catch((cause: unknown) => {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return "";
    throw cause;
  });
  if (current.split(/\r?\n/u).some((line) => line.trim() === excludeEntry))
    return;
  await appendFile(
    exclude,
    `${current !== "" && !current.endsWith("\n") ? "\n" : ""}${excludeEntry}\n`,
  );
}
