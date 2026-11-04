import { constants, type Dir, type Dirent, type Stats } from "node:fs";
import {
  lstat,
  open,
  opendir,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  matchesGlob,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { correlationKey } from "@fungi.computer/cairn";
import { FilesEditError, type FilesPort } from "@fungi.computer/knapsack";
import { SearchVisibility } from "@fungi.computer/knapsack/files-search";
import {
  imageReadResult,
  imageSniffBytes,
  imageTooLargeMessage,
  sniffImageMimeType,
} from "@fungi.computer/knapsack/files-read";
import type { InvocationContext } from "@fungi.computer/mycelium";
import type { LocalPermissionMode } from "./private-local-permission-mode.js";
import { RE2JS } from "re2js";
import { createPrivateFilesPatch } from "./private-files-patch.js";
import {
  fitLocalImage,
  maximumLocalImageInputBytes,
} from "./local-image-fit.js";
import type { LocalSandboxLaunch } from "./private-invocation-computer.js";

/** Same live authority as exec; the policy module owns protected-path checks. */
export type LocalSandboxWrites = Readonly<{
  assertWrite(paths: readonly string[]): void;
  /** Paths the live mode hides from commands (none in Full access); Files
   * reads, listings and searches treat them as absent. */
  hiddenRecords(): readonly string[];
  launch: LocalSandboxLaunch;
}>;

const readOnlyFilesMessage = "Read-only mode: switch to Workspace to edit";

/** An expected Files refusal, not a proposal for an approval. */
class ReadOnlyFilesRefusal extends FilesEditError {
  constructor(path: string) {
    super("read-only", path, readOnlyFilesMessage);
    this.name = "ReadOnlyFilesRefusal";
    this.message = readOnlyFilesMessage;
  }
}

const maximumFileBytes = 128 * 1_024;

/**
 * Hidden scan work for one glob or grep: directory entries admitted to the
 * walk (gitignored and `.git` entries are never admitted) and file bytes read.
 * The result limit counts returned results; these bound the work behind them.
 */
export type ScanBounds = Readonly<{ candidates: number; bytes: number }>;
const defaultScanBounds: ScanBounds = {
  candidates: 50_000,
  bytes: 64 * 1_024 * 1_024,
};
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
type ListInput = Parameters<FilesPort["list"]>[0];
type GlobInput = Parameters<FilesPort["glob"]>[0];
type GrepInput = Parameters<FilesPort["grep"]>[0];
type SearchOutput = Awaited<ReturnType<FilesPort["list"]>>;
type Found = SearchOutput["results"][number];
type TreeSearch =
  | Readonly<{ kind: "glob"; input: GlobInput }>
  | Readonly<{ kind: "grep"; input: GrepInput }>;
type Search = TreeSearch | Readonly<{ kind: "list"; input: ListInput }>;
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

/** One explicit bound on walked entries and one on bytes read. */
class ScanBudget {
  private bytes = 0;
  private candidates = 0;
  exhausted = false;

  constructor(private readonly bounds: ScanBounds) {}

  admitCandidate(): boolean {
    if (this.candidates === this.bounds.candidates) {
      this.exhausted = true;
      return false;
    }
    this.candidates += 1;
    return true;
  }

  admitBytes(bytes: number): boolean {
    if (bytes > this.bounds.bytes - this.bytes) {
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
  metadata: Stats | Dirent,
  path: string,
): "file" | "directory" | "symlink" {
  if (metadata.isSymbolicLink()) return "symlink";
  if (metadata.isFile()) return "file";
  if (metadata.isDirectory()) return "directory";
  throw new Error(`Files path has an unsupported filesystem type: ${path}`);
}

/** Whether the directory entry carries its own type; some filesystems report none. */
function typed(entry: Dirent): boolean {
  return (
    entry.isFile() ||
    entry.isDirectory() ||
    entry.isSymbolicLink() ||
    entry.isSocket() ||
    entry.isFIFO() ||
    entry.isBlockDevice() ||
    entry.isCharacterDevice()
  );
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
  matches: Found[],
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

type FileHandle = Awaited<ReturnType<typeof open>>;

/**
 * Open a checked pathname and bind the descriptor to that check. A
 * sandboxed child can swap a selected-folder entry (or one of its folders)
 * for a symlink between the containment check and open, so the pathname is
 * re-resolved after open and must still name the object just opened. Every
 * later read or write goes through this descriptor, never the pathname.
 */
async function openChecked(
  path: RootedPath,
  operation: "read" | "list" | "replace",
  context: InvocationContext,
): Promise<Readonly<{ handle: FileHandle; metadata: Stats }>> {
  checkCancellation(context);
  let handle: FileHandle;
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
    const current = await existingRealpath(path.resolved, path.requested);
    const named = current === path.resolved ? await stat(current) : undefined;
    if (named?.dev !== metadata.dev || named.ino !== metadata.ino)
      throw new Error(
        `Files path changed during ${operation}: ${path.requested}`,
      );
    return { handle, metadata };
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

async function openRegularFile(
  path: RootedPath,
  context: InvocationContext,
): Promise<OpenFile> {
  const { handle, metadata } = await openChecked(path, "read", context);
  if (!metadata.isFile()) {
    await handle.close();
    throw new FilesPathError("not-file", path.requested);
  }
  return { handle, size: metadata.size };
}

/**
 * A pathname naming one open descriptor. The kernel resolves it to that
 * object, not to whatever the checked pathname names by now.
 */
function descriptorPath(handle: FileHandle): string {
  return process.platform === "linux"
    ? `/proc/self/fd/${String(handle.fd)}`
    : `/dev/fd/${String(handle.fd)}`;
}

/** One checked directory, read through a descriptor bound to that check. */
type CheckedDirectory = Readonly<{
  entries: Dir;
  /** The bound descriptor's pathname, for looking up one entry. */
  bound: string;
  close: () => Promise<void>;
}>;

async function openCheckedDirectory(
  directory: RootedPath,
  context: InvocationContext,
): Promise<CheckedDirectory> {
  const { handle } = await openChecked(directory, "list", context);
  try {
    const bound = descriptorPath(handle);
    const entries = await opendir(bound);
    return {
      entries,
      bound,
      // Iterating to the end closes the Dir; the descriptor is closed here.
      close: () => handle.close(),
    };
  } catch (cause) {
    await handle.close();
    throw cause;
  }
}

/** Bytes per replacement write; cancellation is checked between them. */
const replaceChunkBytes = 16 * 1_024;

/**
 * Replace one checked file atomically, inside the folder it was checked in.
 * The folder is held by a descriptor bound to that check, so a sandboxed
 * child swapping it (or the leaf) for a symlink cannot redirect the read or
 * the write. The new bytes go to a fresh temporary file in that held folder,
 * are synced, and are renamed over the leaf only while the leaf is still the
 * file that was read; any interruption before the rename leaves it whole.
 */
async function replaceChecked(
  path: RootedPath,
  input: Readonly<{ path: string; expectedContent: string; content: string }>,
  context: InvocationContext,
  admitWrite: () => void,
): Promise<number> {
  const { handle: folder, metadata: folderMetadata } = await openChecked(
    { requested: path.requested, resolved: dirname(path.resolved) },
    "replace",
    context,
  );
  try {
    if (!folderMetadata.isDirectory())
      throw new Error(`Files path changed during replace: ${path.requested}`);
    const held = descriptorPath(folder);
    const leaf = join(held, basename(path.resolved));
    const original = await readHeldLeaf(leaf, path, context);
    if (original.content !== input.expectedContent)
      throw new FilesEditError(
        "conflict",
        input.path,
        "File changed since it was read; read it again before editing",
      );
    const content = utf8.encode(input.content);
    if (content.byteLength > maximumFileBytes) {
      throw new FilesEditError(
        "file-too-large",
        input.path,
        `Result exceeds ${String(maximumFileBytes)} bytes; use files.patch for a small change`,
      );
    }
    checkCancellation(context);
    admitWrite();
    const temporary = join(
      held,
      `.${basename(path.resolved)}.${correlationKey()}.fungi-replace`,
    );
    const staged = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      try {
        await staged.chmod(original.metadata.mode & 0o7777);
        let written = 0;
        while (written < content.byteLength) {
          const next = await staged.write(
            content,
            written,
            Math.min(replaceChunkBytes, content.byteLength - written),
            written,
          );
          written += next.bytesWritten;
          checkCancellation(context);
        }
        await staged.sync();
      } finally {
        await staged.close();
      }
      checkCancellation(context);
      const current = await lstat(leaf);
      if (
        current.dev !== original.metadata.dev ||
        current.ino !== original.metadata.ino
      )
        throw new Error(`Files path changed during replace: ${path.requested}`);
      await rename(temporary, leaf);
    } catch (cause) {
      await discardStaged(temporary, cause);
    }
    await folder.sync();
    return content.byteLength;
  } finally {
    await folder.close();
  }
}

/** The held folder's leaf, opened without following a symlink, and its whole text. */
async function readHeldLeaf(
  leaf: string,
  path: RootedPath,
  context: InvocationContext,
): Promise<Readonly<{ content: string; metadata: Stats }>> {
  checkCancellation(context);
  let handle: FileHandle;
  try {
    handle = await open(leaf, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (cause) {
    if (missingPath(cause))
      throw new FilesPathError("not-found", path.requested);
    // The checked leaf is a regular file; a symlink here was swapped in.
    if (cause instanceof Error && "code" in cause && cause.code === "ELOOP")
      throw new Error(`Files path changed during replace: ${path.requested}`, {
        cause,
      });
    throw cause;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile())
      throw new FilesPathError("not-file", path.requested);
    return {
      content: await readOpenText(
        { handle, size: metadata.size },
        path,
        context,
      ),
      metadata,
    };
  } finally {
    await handle.close();
  }
}

/** Remove an unrenamed temporary file, then report why the replacement stopped. */
async function discardStaged(
  temporary: string,
  cause: unknown,
): Promise<never> {
  try {
    await unlink(temporary);
  } catch (cleanup) {
    if (!missingPath(cleanup))
      throw new AggregateError(
        [cause, cleanup],
        "Files replace stopped and its temporary file remains",
        { cause: cleanup },
      );
  }
  throw cause;
}

/**
 * One canonical invocation root and every pathname decision made beneath it.
 *
 * Same-user containment; each opened file is re-bound to its checked path.
 */
class InvocationRoot {
  static async capture(
    path: string,
    hidden: () => readonly string[],
  ): Promise<InvocationRoot> {
    return new InvocationRoot(await realpath(resolve(path)), hidden);
  }

  private constructor(
    readonly canonicalPath: string,
    private readonly hidden: () => readonly string[],
  ) {}

  /** Whether the live mode hides this path from the Agent, as commands see it. */
  hides(path: string): boolean {
    return this.hidden().some((record) => within(record, path));
  }

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
    // A hidden record is absent to the Agent, exactly as the child's mask shows it.
    if (this.hides(candidate) || this.hides(resolvedPath))
      throw new FilesPathError("not-found", requested);
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
    if (within(this.canonicalPath, candidate)) return;
    throw new FilesPathError("outside-root", requested);
  }
}

function within(root: string, path: string): boolean {
  const fromRoot = relative(root, path);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) &&
      fromRoot !== ".." &&
      !isAbsolute(fromRoot))
  );
}

async function readBytesAt(
  file: OpenFile,
  path: RootedPath,
  position: number,
  length: number,
  context: InvocationContext,
): Promise<Buffer> {
  const buffer = Buffer.alloc(Math.min(length, file.size - position));
  let bytesRead = 0;
  while (bytesRead < buffer.byteLength) {
    checkCancellation(context);
    const next = await file.handle.read(
      buffer,
      bytesRead,
      buffer.byteLength - bytesRead,
      position + bytesRead,
    );
    if (next.bytesRead === 0)
      throw new Error(`Files path changed during read: ${path.requested}`);
    bytesRead += next.bytesRead;
  }
  return buffer;
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
    if (offset === 0) {
      const head = await readBytesAt(file, path, 0, imageSniffBytes, context);
      const mimeType = sniffImageMimeType(head);
      if (mimeType !== undefined) {
        if (file.size > maximumLocalImageInputBytes)
          throw new Error(
            imageTooLargeMessage(
              path.requested,
              file.size,
              maximumLocalImageInputBytes,
            ),
          );
        // Every image is shrunk here, before it becomes an image part.
        return imageReadResult(
          path.requested,
          "image/jpeg",
          await fitLocalImage(
            path.requested,
            await readBytesAt(file, path, 0, file.size, context),
            context.signal,
          ),
        );
      }
    }
    const requestedBytes = Math.min(limit, file.size - offset);
    const buffer = await readBytesAt(
      file,
      path,
      offset,
      requestedBytes,
      context,
    );
    const bytesRead = buffer.byteLength;
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
    return await readOpenText(file, path, context);
  } finally {
    await file.handle.close();
  }
}

/** The whole bounded UTF-8 text of one already-bound open file. */
async function readOpenText(
  file: OpenFile,
  path: RootedPath,
  context: InvocationContext,
): Promise<string> {
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

function slashed(path: string): string {
  return path.split(sep).join("/");
}

async function readGitignore(
  root: InvocationRoot,
  directory: string,
  context: InvocationContext,
): Promise<string | undefined> {
  const candidate = join(directory, ".gitignore");
  try {
    await lstat(candidate);
  } catch (cause) {
    if (missingPath(cause)) return undefined;
    throw cause;
  }
  let resolved: string;
  try {
    resolved = await root.walked(candidate, candidate, context);
  } catch (cause) {
    if (cause instanceof FilesPathError) return undefined;
    throw cause;
  }
  return await readGrepCandidate({ requested: candidate, resolved }, context);
}

function visiblePath(
  root: InvocationRoot,
  visibility: SearchVisibility,
  path: string,
  isDirectory: boolean,
): Promise<boolean> {
  return visibility.visible(
    slashed(relative(root.canonicalPath, path)),
    isDirectory,
  );
}

async function* walkFiles(
  root: InvocationRoot,
  base: RootedPath,
  budget: ScanBudget,
  visibility: SearchVisibility,
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
    const checked = await openCheckedDirectory(
      {
        requested:
          relativeParent === ""
            ? base.requested
            : outputPath(base.requested, relativeParent),
        resolved: directory,
      },
      context,
    );
    try {
      for await (const entry of checked.entries) {
        checkCancellation(context);
        const candidate = join(directory, entry.name);
        if (
          root.hides(candidate) ||
          !(await visiblePath(root, visibility, candidate, entry.isDirectory()))
        )
          continue;
        if (!budget.admitCandidate()) return;
        const relativePath =
          relativeParent === "" ? entry.name : join(relativeParent, entry.name);
        const resolvedPath = await root.walked(
          candidate,
          outputPath(base.requested, relativePath),
          context,
        );
        if (root.hides(resolvedPath)) continue;
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
    } finally {
      await checked.close();
    }
  }

  yield* visit(base.resolved, "", new Set());
}

async function grepFile(
  target: RootedPath,
  input: GrepInput,
  context: InvocationContext,
): Promise<SearchOutput> {
  const matches: Found[] = [];
  const content = await readBoundedText(target, context);
  const limited = appendMatchingLines(
    matches,
    input.path,
    content,
    lineMatcher(input.pattern, input.regex, input.ignoreCase),
    input.limit,
    context,
  );
  return {
    path: input.path,
    results: matches,
    truncated: limited ? "limit" : null,
  };
}

/** One directory level; the entries past the limit are only witnessed, not returned. */
async function listLevel(
  root: InvocationRoot,
  directory: RootedPath,
  input: ListInput,
  visibility: SearchVisibility,
  context: InvocationContext,
): Promise<SearchOutput> {
  const { entries, bound, close } = await openCheckedDirectory(
    directory,
    context,
  );
  try {
    const results: Found[] = [];
    for await (const entry of entries) {
      checkCancellation(context);
      const candidate = join(directory.resolved, entry.name);
      if (
        root.hides(candidate) ||
        !(await visiblePath(root, visibility, candidate, entry.isDirectory()))
      )
        continue;
      if (results.length === input.limit) {
        return { path: input.path, results, truncated: "limit" };
      }
      const path = outputPath(input.path, entry.name);
      results.push({
        path,
        type: entryType(
          typed(entry) ? entry : await lstat(join(bound, entry.name)),
          path,
        ),
      });
    }
    return { path: input.path, results, truncated: null };
  } finally {
    await close();
  }
}

/** One bounded walk for a glob or content search with an optional include glob. */
async function searchTree(
  root: InvocationRoot,
  directory: RootedPath,
  search: TreeSearch,
  bounds: ScanBounds,
  visibility: SearchVisibility,
  context: InvocationContext,
): Promise<SearchOutput> {
  const { input } = search;
  const pathPattern =
    search.kind === "glob" ? search.input.pattern : search.input.include;
  const matchesLine =
    search.kind === "grep"
      ? lineMatcher(
          search.input.pattern,
          search.input.regex,
          search.input.ignoreCase,
        )
      : undefined;
  const results: Found[] = [];
  const budget = new ScanBudget(bounds);
  for await (const entry of walkFiles(
    root,
    directory,
    budget,
    visibility,
    context,
  )) {
    checkCancellation(context);
    if (
      pathPattern !== undefined &&
      !matchesGlob(entry.relativePath, pathPattern)
    )
      continue;
    const path = outputPath(input.path, entry.relativePath);
    if (matchesLine === undefined) {
      if (results.length === input.limit) {
        return { path: input.path, results, truncated: "limit" };
      }
      results.push({
        path,
        type: entry.isDirectory ? "directory" : "file",
      });
      continue;
    }
    // Directories, special files, oversized files and non-text files hold no
    // searchable lines; skipping them is not a cut of the scan.
    if (!entry.isFile || entry.size > maximumFileBytes) continue;
    if (!budget.admitBytes(entry.size)) break;
    const content = await readGrepCandidate(
      { requested: path, resolved: entry.resolvedPath },
      context,
    );
    if (content === undefined) continue;
    if (
      appendMatchingLines(
        results,
        path,
        content,
        matchesLine,
        input.limit,
        context,
      )
    ) {
      return { path: input.path, results, truncated: "limit" };
    }
  }
  return {
    path: input.path,
    results,
    truncated: budget.exhausted ? "scan" : null,
  };
}

async function searchPath(
  root: InvocationRoot,
  search: Search,
  bounds: ScanBounds,
  context: InvocationContext,
): Promise<SearchOutput> {
  const { input } = search;
  const target = await root.existing(input.path, context);
  checkCancellation(context);
  const metadata = await stat(target.resolved);
  const visibility = new SearchVisibility((directory) =>
    readGitignore(root, join(root.canonicalPath, directory), context),
  );
  if (
    !(await visiblePath(
      root,
      visibility,
      target.resolved,
      metadata.isDirectory(),
    ))
  )
    return { path: input.path, results: [], truncated: null };
  if (metadata.isFile()) {
    if (search.kind === "glob")
      throw new Error(
        `Files glob needs a directory path, not a file: ${input.path}`,
      );
    if (search.kind === "grep") {
      if (search.input.include !== undefined)
        throw new Error(
          `Files grep include needs a directory path, not a file: ${input.path}`,
        );
      return await grepFile(target, search.input, context);
    }
    return {
      path: input.path,
      results: [{ path: input.path, type: "file" }],
      truncated: null,
    };
  }
  if (!metadata.isDirectory())
    throw new Error(`Files path is not a file or directory: ${input.path}`);
  if (search.kind === "list")
    return await listLevel(root, target, input, visibility, context);
  return await searchTree(root, target, search, bounds, visibility, context);
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
 * in-root symlinks. Each opened file is re-bound to its checked path, and the
 * live mode's hidden records stay absent, so a sandboxed child cannot steer a
 * host read past either decision. Full access trusts the same-user host.
 */
export async function createPrivateInvocationFilesPort(
  path: string,
  scanBounds: ScanBounds = defaultScanBounds,
  sandbox?: LocalSandboxWrites,
  mode: () => LocalPermissionMode = () => "full-access",
): Promise<FilesPort> {
  const root = await InvocationRoot.capture(
    path,
    () => sandbox?.hiddenRecords() ?? [],
  );
  const write = createWriteQueue();
  const port: FilesPort = {
    assertEditable(requested) {
      if (mode() === "read-only") throw new ReadOnlyFilesRefusal(requested);
    },
    async read(input, context) {
      return await readPage(
        await root.existing(input.path, context),
        input.offset,
        input.limit,
        context,
      );
    },

    async list(input, context) {
      return await searchPath(
        root,
        { kind: "list", input },
        scanBounds,
        context,
      );
    },
    async glob(input, context) {
      return await searchPath(
        root,
        { kind: "glob", input },
        scanBounds,
        context,
      );
    },
    async grep(input, context) {
      return await searchPath(
        root,
        { kind: "grep", input },
        scanBounds,
        context,
      );
    },

    async replace(input, context) {
      return await write(async () => {
        checkCancellation(context);
        port.assertEditable?.(input.path);
        const path = await root.existing(input.path, context);
        const bytes = await replaceChecked(path, input, context, () =>
          sandbox?.assertWrite([path.resolved]),
        );
        return { path: input.path, bytes };
      });
    },
  };
  // The native parser/patch engine still owns patch grammar. Its adapter must
  // accept the launch callback too; never parse patch headers here.
  const patch = await createPrivateFilesPatch(
    root.canonicalPath,
    port.read,
    sandbox?.launch,
  );
  if (patch === undefined) return Object.freeze(port);
  return Object.freeze({
    ...port,
    patch: (
      input: Parameters<NonNullable<FilesPort["patch"]>>[0],
      context: InvocationContext,
    ) =>
      write(async () => {
        checkCancellation(context);
        if (mode() === "read-only")
          throw new ReadOnlyFilesRefusal(root.canonicalPath);
        return patch(input, context);
      }),
  });
}
