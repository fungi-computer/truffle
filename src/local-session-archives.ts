import { createHash } from "node:crypto";
import { link, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

import type {
  ArchiveReceiptV1,
  ArchiveWriteError,
  ArchiveWriter,
  ArchiveWriteV1,
} from "@fungi.computer/zookeeper";
import { archiveSessionSegment } from "@fungi.computer/zookeeper";
import { nanoid } from "@fungi.computer/cairn";
import { Effect } from "effect";
import { z } from "zod";

const MAX_CHUNK_BYTES = 64 * 1024;
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

type FailureReason = ArchiveWriteError["reason"];

/** Internal control flow: carries the reason a write was refused. */
class ArchiveRefusal extends Error {
  constructor(readonly reason: FailureReason) {
    super(`archive write refused: ${reason}`);
  }
}

const keyTakenSchema = z.object({ code: z.literal("EEXIST") });
const refusalSchema = z.instanceof(ArchiveRefusal);

function validate(input: ArchiveWriteV1): void {
  const segments = [
    archiveSessionSegment(input.sessionId),
    input.contextRevision,
    input.materialKey,
  ];
  if (
    !segments.every((segment) => SAFE_SEGMENT.test(segment)) ||
    !SHA256_HEX.test(input.sha256) ||
    input.materialKey !== input.sha256.slice(0, 32) ||
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 0
  ) {
    throw new ArchiveRefusal("invalid");
  }
}

/** Stream the chunks into an open file, then check them against the declaration. */
async function writeVerified(
  path: string,
  input: ArchiveWriteV1,
  signal: AbortSignal,
): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    const hash = createHash("sha256");
    let total = 0;
    for await (const chunk of input.chunks()) {
      signal.throwIfAborted();
      if (chunk.byteLength > MAX_CHUNK_BYTES) {
        throw new ArchiveRefusal("invalid");
      }
      hash.update(chunk);
      total += chunk.byteLength;
      let written = 0;
      while (written < chunk.byteLength) {
        const result = await handle.write(chunk, written);
        written += result.bytesWritten;
      }
    }
    if (total !== input.byteLength || hash.digest("hex") !== input.sha256) {
      throw new ArchiveRefusal("invalid");
    }
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function existingMatches(
  path: string,
  input: ArchiveWriteV1,
): Promise<boolean> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(MAX_CHUNK_BYTES);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buffer.subarray(0, bytesRead));
      total += bytesRead;
    }
    return total === input.byteLength && hash.digest("hex") === input.sha256;
  } finally {
    await handle.close();
  }
}

/** Hard-link the finished temp file into place; false when the key is taken. */
async function linkIntoPlace(
  tempPath: string,
  finalPath: string,
): Promise<boolean> {
  try {
    await link(tempPath, finalPath);
    return true;
  } catch (error) {
    if (keyTakenSchema.safeParse(error).success) {
      return false;
    }
    throw error;
  }
}

async function writeArchiveFile(
  storeDirectory: string,
  input: ArchiveWriteV1,
  signal: AbortSignal,
  syncDirectoryPort: (directory: string) => Promise<void>,
): Promise<ArchiveReceiptV1> {
  validate(input);
  const name = `${input.contextRevision}-${input.materialKey}`;
  const session = archiveSessionSegment(input.sessionId);
  const directory = join(storeDirectory, "archives", session);
  const finalPath = join(directory, name);
  const tempPath = join(directory, `.${input.materialKey}.${nanoid()}.tmp`);
  const receipt = {
    key: `archives/${session}/${name}`,
    sha256: input.sha256,
    byteLength: input.byteLength,
  };

  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeVerified(tempPath, input, signal);
    const created = await linkIntoPlace(tempPath, finalPath);
    if (!created && !(await existingMatches(finalPath, input))) {
      throw new ArchiveRefusal("conflict");
    }
    // A verified archive stays even when the directory fsync fails: a retry
    // finds it by link and returns this same receipt.
    await syncDirectoryPort(directory);
    return receipt;
  } finally {
    await rm(tempPath, { force: true });
  }
}

/**
 * Plain archive files beside the Agent store, never synced through Home:
 * `<storeDirectory>/archives/<sessionId>/<contextRevision>-<materialKey>`.
 * Each archive is streamed to a temp file, fsynced, then hard-linked into
 * place so an existing archive is never overwritten.
 */
export function localArchiveWriter(
  storeDirectory: string,
  syncDirectoryPort: (directory: string) => Promise<void> = syncDirectory,
): ArchiveWriter {
  return {
    write: (input) =>
      Effect.tryPromise({
        try: (signal) =>
          writeArchiveFile(storeDirectory, input, signal, syncDirectoryPort),
        catch: (error) => {
          const refusal = refusalSchema.safeParse(error);
          return {
            _tag: "ArchiveWriteError",
            reason: refusal.success ? refusal.data.reason : "unavailable",
          };
        },
      }),
  };
}
