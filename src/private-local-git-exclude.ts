import { appendFile, mkdir, readFile } from "node:fs/promises";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gitDirectories } from "./private-local-sandbox-policy.js";

const excludeEntry = ".fungi/";

/** Keep generated project state out of Git without changing tracked ignore rules. */
export async function ensurePrivateLocalGitExclude(
  projectRoot: string,
): Promise<void> {
  const root = realpathSync(projectRoot);
  // Never append as the host to a common dir selected by a planted .git.
  // Git's read-only answer alone cannot authorize a host write.
  const git = gitDirectories(root, root);
  if (git === undefined) return;
  const marker = join(root, ".git");
  const entry = lstatSync(marker, { throwIfNoEntry: false });
  if (entry?.isDirectory()) {
    if (realpathSync(marker) !== git.common || git.worktree !== git.common)
      return;
  } else if (entry?.isFile()) {
    if (dirname(git.worktree) !== join(git.common, "worktrees")) return;
    // A real linked worktree's Git-owned backlink must point to this marker.
    const backlink = readFileSync(join(git.worktree, "gitdir"), "utf8");
    if (
      !backlink.endsWith("\n") ||
      backlink.split("\n").length !== 2 ||
      resolve(git.worktree, backlink.trimEnd()) !== marker
    )
      return;
  } else return;
  const info = join(git.common, "info");
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
