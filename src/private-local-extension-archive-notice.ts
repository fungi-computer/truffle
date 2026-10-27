import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import writeFileAtomic from "write-file-atomic";
import { z } from "zod";

export const extensionArchiveNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(214)
  .refine((name) => /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/iu.test(name));
const noticeSchema = z.strictObject({
  version: z.literal(3),
  slug: z.literal("unversioned"),
  filename: z.string().regex(/^installed(?:-[2-9])?\.json$/u),
  names: z.array(extensionArchiveNameSchema).max(20),
  additionalNameCount: z.number().int().min(0),
  shown: z.boolean(),
});

const deferredHomes = new Set<string>();

function absent(cause: unknown) {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "ENOENT" || cause.code === "ENOTDIR")
  );
}

export function deferExtensionArchiveNotices(home: string) {
  deferredHomes.add(resolve(home));
}

export function extensionArchiveNoticesAreDeferred(home: string) {
  return deferredHomes.has(resolve(home));
}

export async function acquireExtensionOwnerLock(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  return lockfile.lock(root, {
    realpath: false,
    lockfilePath: join(root, ".owner.lock"),
    stale: 30_000,
    update: 10_000,
    retries: { retries: 20, factor: 1.2, minTimeout: 25, maxTimeout: 100 },
  });
}

function formatNotice(notice: z.infer<typeof noticeSchema>) {
  const archivePath = `~/.fungi/archive/${notice.slug}/extensions/${notice.filename}`;
  if (notice.names.length === 0)
    return `Extensions from an earlier version were set aside, but no extension names could be read. Re-add each with: fungi extension add <its source>. Archived registry: ${archivePath}.`;
  const more =
    notice.additionalNameCount > 0
      ? `, and ${notice.additionalNameCount.toString()} more`
      : "";
  return `Extensions from an earlier version were set aside: ${notice.names.join(", ")}${more}. Re-add each with: fungi extension add <its source>. Archived registry: ${archivePath}.`;
}

export async function writeExtensionArchiveNotice(
  home: string,
  slug: "unversioned",
  filename: string,
  names: readonly string[],
) {
  const notice = noticeSchema.parse({
    version: 3,
    slug,
    filename,
    names: names.slice(0, 20),
    additionalNameCount: Math.max(0, names.length - 20),
    shown: false,
  });
  const directory = join(
    resolve(home),
    ".fungi",
    "archive",
    slug,
    "extensions",
  );
  await writeFileAtomic(
    join(directory, `${filename}.notice.json`),
    `${JSON.stringify(notice)}\n`,
    { encoding: "utf8", fsync: true, mode: 0o600 },
  );
}

export async function takePendingExtensionArchiveNoticesUnderOwnerLock(
  home: string,
) {
  const directory = join(
    resolve(home),
    ".fungi",
    "archive",
    "unversioned",
    "extensions",
  );
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (cause) {
    if (absent(cause)) return [];
    throw cause;
  }
  const notices: string[] = [];
  for (const name of names
    .filter((candidate) =>
      /^installed(?:-[2-9])?\.json\.notice\.json$/u.test(candidate),
    )
    .sort()) {
    const path = join(directory, name);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path, "utf8"));
    } catch (cause) {
      if (absent(cause) || cause instanceof SyntaxError) continue;
      throw cause;
    }
    const parsed = noticeSchema.safeParse(value);
    if (!parsed.success || parsed.data.shown) continue;
    const archivedName = name.replace(/\.notice\.json$/u, "");
    if (parsed.data.filename !== archivedName) continue;
    await writeFileAtomic(
      path,
      `${JSON.stringify({ ...parsed.data, shown: true })}\n`,
      { encoding: "utf8", fsync: true, mode: 0o600 },
    );
    notices.push(formatNotice(parsed.data));
  }
  return notices;
}

export async function takePendingExtensionArchiveNotices(home: string) {
  const root = join(resolve(home), ".fungi", "extensions");
  const release = await acquireExtensionOwnerLock(root);
  try {
    return await takePendingExtensionArchiveNoticesUnderOwnerLock(home);
  } finally {
    await release();
  }
}
