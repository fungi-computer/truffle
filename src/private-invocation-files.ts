import { lstat, open, opendir, realpath, stat } from "node:fs/promises";
import {
  isAbsolute,
  join,
  matchesGlob,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { FilesEditError, type FilesPort } from "@fungi.computer/knapsack";
import type { InvocationContext } from "@fungi.computer/mycelium";
import { RE2JS } from "re2js";
import { createPrivateFilesPatch } from "./private-files-patch.js";
import writeFileAtomic from "write-file-atomic";

const maximumFileBytes = 128 * 1_024;
const maximumScanBytes = maximumFileBytes;
const maximumScanCandidates = 256;
const utf8 = new TextEncoder();

type RootedPath = Readonly<{
  requested: string;
  resolved: string;
}>;

type WalkEntry = Readonly<{
  relativePath: string;
  resolvedPath: string;
  isDirectory: boolean;
  isFile: boolean;
  size: number;
}>;

type LineMatcher = (line: string) => boolean;
type GrepMatch = Readonly<{ path: string; line: number; text: string }>;
type GrepInput = Parameters<FilesPort["grep"]>[0];
type GrepOutput = Awaited<ReturnType<FilesPort["grep"]>>;
type OpenFile = Readonly<{
  handle: Awaited<ReturnType<typeof open>>;
  size: number;
}>;

/** Safe Files path failures surfaced across the workerd binding boundary. */
export class FilesPathError extends Error {
  readonly code: "ENOENT" | undefined;

  constructor(
    readonly reason: "outside-root" | "not-found" | "not-file",
    requested: string,
  ) {
    const description = {
      "outside-root": "Files path resolves outside the invocation root",
      "not-found": "Files path does not exist",
      "not-file": "Files path is not a file",
    }[reason];
    super(`${description}: ${requested}`);
    this.name = "FilesPathError";
    // Optional instruction and skill reads retain Node's missing-file signal.
    this.code = reason === "not-found" ? "ENOENT" : undefined;
  }
}

function missingPath(cause: unknown): boolean {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}

async function existingRealpath(
  candidate: string,
  requested: string,
): Promise<string> {
  try {
    return await realpath(candidate);
  } catch (cause) {
    if (missingPath(cause)) throw new FilesPathError("not-found", requested);
    throw cause;
  }
}

/** One maximum result page and one maximum read page bound hidden scan work. */
class ScanBudget {
  private bytes = 0;
  private candidates = 0;
  exhausted = false;

  admitCandidate(): boolean {
    if (this.candidates === maximumScanCandidates) {
      this.exhausted = true;
      return false;
    }
    this.candidates += 1;
    return true;
  }

  admitBytes(bytes: number): boolean {
    if (bytes > maximumScanBytes - this.bytes) {
      this.exhausted = true;
      return false;
    }
    this.bytes += bytes;
    return true;
  }
}

function checkCancellation(context: InvocationContext): void {
  context.signal.throwIfAborted();
}

// Grep skips unsupported text; filesystem failures are reported separately.
class FilesTextError extends Error {}

function decodeUtf8(data: Uint8Array, path: string, moreBytesRemain = false) {
  try {
    const content = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(data, { stream: moreBytesRemain });
    const bytes = utf8.encode(content).byteLength;
    if (bytes === 0 && data.byteLength > 0) {
      throw new Error(`Files read cannot advance a UTF-8 page: ${path}`);
    }
    return { content, bytes };
  } catch (cause) {
    throw new FilesTextError(`Files path is not valid UTF-8: ${path}`, {
      cause,
    });
  }
}

function entryType(
  metadata: Awaited<ReturnType<typeof lstat>>,
  path: string,
): "file" | "directory" | "symlink" {
  if (metadata.isSymbolicLink()) return "symlink";
  if (metadata.isFile()) return "file";
  if (metadata.isDirectory()) return "directory";
  throw new Error(`Files path has an unsupported filesystem type: ${path}`);
}

function outputPath(parent: string, child: string): string {
  if (isAbsolute(parent)) return resolve(parent, child);
  return parent === "." ? child : normalize(join(parent, child));
}

function lineMatcher(
  pattern: string,
  regex: boolean,
  ignoreCase: boolean,
): LineMatcher {
  if (regex) {
    let compiled: RE2JS;
    try {
      compiled = RE2JS.compile(
        pattern,
        ignoreCase ? RE2JS.CASE_INSENSITIVE : 0,
      );
    } catch (cause) {
      throw new Error("Files grep pattern is not supported by RE2", { cause });
    }
    return (line) => compiled.test(line);
  }
  if (!ignoreCase) return (line) => line.includes(pattern);
  const foldedPattern = pattern.toLowerCase();
  return (line) => line.toLowerCase().includes(foldedPattern);
}

function appendMatchingLines(
  matches: GrepMatch[],
  path: string,
  content: string,
  matchesLine: LineMatcher,
  limit: number,
  context: InvocationContext,
): boolean {
  const lines = content.split(/\r\n|\n|\r/u);
  if (content.endsWith("\n") || content.endsWith("\r")) lines.pop();

  for (const [index, line] of lines.entries()) {
    checkCancellation(context);
    if (!matchesLine(line)) continue;
    if (matches.length === limit) return true;
    matches.push({ path, line: index + 1, text: line });
  }
  return false;
}

async function openRegularFile(
  path: RootedPath,
  context: InvocationContext,
): Promise<OpenFile> {
  checkCancellation(context);
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path.resolved, "r");
  } catch (cause) {
    if (missingPath(cause))
      throw new FilesPathError("not-found", path.requested);
    throw cause;
  }
  try {
    checkCancellation(context);
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new FilesPathError("not-file", path.requested);
    return { handle, size: metadata.size };
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

/**
 * One canonical invocation root and every pathname decision made beneath it.
 *
 * This is same-user containment, not an OS sandbox against pathname races.
 */
class InvocationRoot {
  static async capture(path: string): Promise<InvocationRoot> {
    return new InvocationRoot(await realpath(resolve(path)));
  }

  private constructor(readonly canonicalPath: string) {}

  async existing(
    requested: string,
    context: InvocationContext,
  ): Promise<RootedPath> {
    checkCancellation(context);
    const candidate = isAbsolute(requested)
      ? resolve(requested)
      : resolve(this.canonicalPath, requested);
    this.assertContained(candidate, requested);
    const resolvedPath = await existingRealpath(candidate, requested);
    this.assertContained(resolvedPath, requested);
    return { requested, resolved: resolvedPath };
  }

  async walked(
    candidate: string,
    requested: string,
    context: InvocationContext,
  ): Promise<string> {
    checkCancellation(context);
    const resolvedPath = await existingRealpath(candidate, requested);
    this.assertContained(resolvedPath, requested);
    return resolvedPath;
  }

  private assertContained(candidate: string, requested: string): void {
    const fromRoot = relative(this.canonicalPath, candidate);
    if (
      fromRoot === "" ||
      (!fromRoot.startsWith(`..${sep}`) &&
        fromRoot !== ".." &&
        !isAbsolute(fromRoot))
    ) {
      return;
    }
    throw new FilesPathError("outside-root", requested);
  }
}

async function readPage(
  path: RootedPath,
  offset: number,
  limit: number,
  context: InvocationContext,
) {
  const file = await openRegularFile(path, context);
  try {
    if (offset > file.size)
      throw new Error(`Files read offset exceeds file size: ${path.requested}`);
    if (offset === file.size) {
      return {
        path: path.requested,
        content: "",
        offset,
        nextOffset: null,
        truncated: false,
      };
    }
    const requestedBytes = Math.min(limit, file.size - offset);
    const buffer = Buffer.alloc(requestedBytes);
    let bytesRead = 0;
    while (bytesRead < requestedBytes) {
      checkCancellation(context);
      const next = await file.handle.read(
        buffer,
        bytesRead,
        requestedBytes - bytesRead,
        offset + bytesRead,
      );
      if (next.bytesRead === 0)
        throw new Error(`Files path changed during read: ${path.requested}`);
      bytesRead += next.bytesRead;
    }
    const page = decodeUtf8(
      buffer,
      path.requested,
      offset + bytesRead < file.size,
    );
    const nextOffset = offset + page.bytes;
    return {
      path: path.requested,
      content: page.content,
      offset,
      nextOffset: nextOffset < file.size ? nextOffset : null,
      truncated: nextOffset < file.size,
    };
  } finally {
    await file.handle.close();
  }
}

async function readBoundedText(
  path: RootedPath,
  context: InvocationContext,
): Promise<string> {
  const file = await openRegularFile(path, context);
  try {
    if (file.size > maximumFileBytes) {
      throw new FilesTextError(
        `Files path exceeds the ${String(maximumFileBytes)}-byte bound: ${path.requested}`,
      );
    }
    const buffer = Buffer.alloc(maximumFileBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.byteLength) {
      checkCancellation(context);
      const next = await file.handle.read(
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        bytesRead,
      );
      if (next.bytesRead === 0) break;
      bytesRead += next.bytesRead;
    }
    if (bytesRead > maximumFileBytes) {
      throw new FilesTextError(
        `Files path exceeds the ${String(maximumFileBytes)}-byte bound: ${path.requested}`,
      );
    }
    return decodeUtf8(buffer.subarray(0, bytesRead), path.requested).content;
  } finally {
    await file.handle.close();
  }
}

async function readGrepCandidate(
  path: RootedPath,
  context: InvocationContext,
): Promise<string | undefined> {
  try {
    return await readBoundedText(path, context);
  } catch (cause) {
    checkCancellation(context);
    if (cause instanceof FilesTextError) return undefined;
    console.error("Local file search candidate unavailable", cause);
    return undefined;
  }
}

async function* walkFiles(
  root: InvocationRoot,
  base: RootedPath,
  budget: ScanBudget,
  context: InvocationContext,
): AsyncGenerator<WalkEntry> {
  async function* visit(
    directory: string,
    relativeParent: string,
    ancestors: ReadonlySet<string>,
  ): AsyncGenerator<WalkEntry> {
    if (ancestors.has(directory)) return;
    const childAncestors = new Set(ancestors).add(directory);
    checkCancellation(context);
    const handle = await opendir(directory);
    for await (const entry of handle) {
      checkCancellation(context);
      if (!budget.admitCandidate()) return;
      const relativePath =
        relativeParent === "" ? entry.name : join(relativeParent, entry.name);
      const candidate = join(directory, entry.name);
      const resolvedPath = await root.walked(
        candidate,
        outputPath(base.requested, relativePath),
        context,
      );
      checkCancellation(context);
      const metadata = await stat(resolvedPath);
      const walkedEntry = {
        relativePath,
        resolvedPath,
        isDirectory: metadata.isDirectory(),
        isFile: metadata.isFile(),
        size: metadata.size,
      };
      yield walkedEntry;
      if (walkedEntry.isDirectory) {
        yield* visit(resolvedPath, relativePath, childAncestors);
        if (budget.exhausted) return;
      }
    }
  }

  yield* visit(base.resolved, "", new Set());
}

async function grepFile(
  target: RootedPath,
  input: GrepInput,
  matchesLine: LineMatcher,
  context: InvocationContext,
): Promise<GrepOutput> {
  const matches: GrepMatch[] = [];
  const content = await readBoundedText(target, context);
  return {
    path: input.path,
    matches,
    truncated: appendMatchingLines(
      matches,
      input.path,
      content,
      matchesLine,
      input.limit,
      context,
    ),
  };
}

async function grepDirectory(
  root: InvocationRoot,
  target: RootedPath,
  input: GrepInput,
  matchesLine: LineMatcher,
  context: InvocationContext,
): Promise<GrepOutput> {
  const matches: GrepMatch[] = [];
  const budget = new ScanBudget();
  let incomplete = false;
  for await (const entry of walkFiles(root, target, budget, context)) {
    if (entry.isDirectory) continue;
    if (!entry.isFile) {
      incomplete = true;
      continue;
    }
    const logicalPath = outputPath(input.path, entry.relativePath);
    if (entry.size > maximumFileBytes) {
      incomplete = true;
      continue;
    }
    if (!budget.admitBytes(entry.size)) break;
    const content = await readGrepCandidate(
      { requested: logicalPath, resolved: entry.resolvedPath },
      context,
    );
    if (content === undefined) {
      incomplete = true;
      continue;
    }
    if (
      appendMatchingLines(
        matches,
        logicalPath,
        content,
        matchesLine,
        input.limit,
        context,
      )
    ) {
      return { path: input.path, matches, truncated: true };
    }
  }
  return {
    path: input.path,
    matches,
    truncated: incomplete || budget.exhausted,
  };
}

async function grepPath(
  root: InvocationRoot,
  input: GrepInput,
  context: InvocationContext,
): Promise<GrepOutput> {
  const target = await root.existing(input.path, context);
  checkCancellation(context);
  const targetMetadata = await stat(target.resolved);
  const matchesLine = lineMatcher(input.pattern, input.regex, input.ignoreCase);
  if (targetMetadata.isFile())
    return await grepFile(target, input, matchesLine, context);
  if (targetMetadata.isDirectory())
    return await grepDirectory(root, target, input, matchesLine, context);
  throw new Error(`Files path is not a file or directory: ${input.path}`);
}

function createWriteQueue() {
  let tail = Promise.resolve();
  return async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    const previous = tail;
    const gate = Promise.withResolvers<undefined>();
    tail = previous.then(() => gate.promise);
    await previous;
    try {
      return await operation();
    } finally {
      gate.resolve(undefined);
    }
  };
}

/**
 * Construct the private local Files port for one captured invocation root.
 *
 * Resolved paths stay under the captured canonical root, including admitted
 * in-root symlinks. This is trusted same-user containment, not protection from
 * a same-user process racing pathname resolution.
 */
export async function createPrivateInvocationFilesPort(
  path: string,
): Promise<FilesPort> {
  const root = await InvocationRoot.capture(path);
  const write = createWriteQueue();
  const port: FilesPort = {
    async read(input, context) {
      return await readPage(
        await root.existing(input.path, context),
        input.offset,
        input.limit,
        context,
      );
    },

    async list(input, context) {
      const directory = await root.existing(input.path, context);
      checkCancellation(context);
      const handle = await opendir(directory.resolved);
      const entries = [];
      for await (const entry of handle) {
        checkCancellation(context);
        if (entries.length === input.limit) {
          return { path: input.path, entries, truncated: true };
        }
        const metadata = await lstat(join(directory.resolved, entry.name));
        const path = outputPath(input.path, entry.name);
        entries.push({
          path,
          name: entry.name,
          type: entryType(metadata, path),
          size: metadata.size,
          modifiedAt: metadata.mtimeMs,
        });
      }
      return { path: input.path, entries, truncated: false };
    },

    async glob(input, context) {
      const directory = await root.existing(input.path, context);
      const matches = [];
      const budget = new ScanBudget();
      for await (const entry of walkFiles(root, directory, budget, context)) {
        checkCancellation(context);
        if (!matchesGlob(entry.relativePath, input.pattern)) continue;
        if (matches.length === input.limit) {
          return { path: input.path, matches, truncated: true };
        }
        matches.push(outputPath(input.path, entry.relativePath));
      }
      return { path: input.path, matches, truncated: budget.exhausted };
    },

    async grep(input, context) {
      return await grepPath(root, input, context);
    },

    async replace(input, context) {
      return await write(async () => {
        checkCancellation(context);
        const path = await root.existing(input.path, context);
        const current = await readBoundedText(path, context);
        if (current !== input.expectedContent)
          throw new FilesEditError(
            "conflict",
            input.path,
            "File changed since it was read; read it again before editing",
          );
        const bytes = utf8.encode(input.content).byteLength;
        if (bytes > maximumFileBytes) {
          throw new FilesEditError(
            "file-too-large",
            input.path,
            `Result exceeds ${String(maximumFileBytes)} bytes; use files.patch for a small change`,
          );
        }
        checkCancellation(context);
        await writeFileAtomic(path.resolved, input.content, {
          encoding: "utf8",
        });
        return { path: input.path, bytes };
      });
    },
  };
  const patch = await createPrivateFilesPatch(root.canonicalPath, port.read);
  if (patch === undefined) return Object.freeze(port);
  return Object.freeze({
    ...port,
    patch: (
      input: Parameters<NonNullable<FilesPort["patch"]>>[0],
      context: InvocationContext,
    ) => write(() => patch(input, context)),
  });
}
