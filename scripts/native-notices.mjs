import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { URL } from "node:url";

const noticeName =
  /^(licen[sc]es?|copying|copyright|notice|third.party.notices)([._-]|$)/i;

export async function noticeFiles(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!noticeName.test(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isFile()) result.push(path);
    else if (entry.isDirectory()) {
      for (const child of await readdir(path, { withFileTypes: true })) {
        if (child.isFile()) result.push(resolve(path, child.name));
      }
    }
  }
  return result.sort();
}

// Cache the actual compiler closure's texts with its binary. Absolute Cargo
// source paths cannot serve as packaging inputs after a cross-worktree cache hit.
export async function nativeNotices(artifacts, sourceRoot) {
  const packages = new Map();
  for (const artifact of artifacts) {
    const name = new URL(artifact.package_id).hash.slice(1);
    if (!name) throw new Error("Native artifact has no Cargo package identity");
    const directory = dirname(artifact.manifest_path);
    const root = directory.startsWith(sourceRoot + "/")
      ? sourceRoot
      : directory;
    packages.set(name, {
      name,
      texts: await Promise.all(
        (await noticeFiles(root)).map((file) => readFile(file, "utf8")),
      ),
    });
  }
  return [...packages.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}
