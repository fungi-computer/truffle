import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type ArchiveWriteError,
  type ArchiveWriteV1,
  prepareArchiveWrite,
} from "@fungi.computer/zookeeper";
import { Effect } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  goldenArchiveText,
  goldenSource,
} from "@fungi.computer/zookeeper/testing";
import { localArchiveWriter } from "../src/local-session-archives.js";

const goldenSha256 = createHash("sha256")
  .update(goldenArchiveText)
  .digest("hex");

function chunksOf(bytes: Uint8Array): () => AsyncIterable<Uint8Array> {
  return async function* () {
    await Promise.resolve();
    yield bytes;
  };
}

function withChunks(
  base: ArchiveWriteV1,
  chunks: () => AsyncIterable<Uint8Array>,
): ArchiveWriteV1 {
  return { ...base, chunks };
}

function failureOf(
  effect: Effect.Effect<unknown, ArchiveWriteError>,
): Promise<ArchiveWriteError> {
  return Effect.runPromise(Effect.flip(effect));
}

async function listTree(root: string): Promise<readonly string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries.sort();
}

describe("localArchiveWriter", () => {
  let store: string;
  const write = prepareArchiveWrite("session-1", goldenSource);
  const sessionDirectory = () => join(store, "archives", "session-1");
  const finalName = `row-42-${write.materialKey}`;

  beforeEach(async () => {
    store = await mkdtemp(join(tmpdir(), "local-archives-"));
  });
  afterEach(async () => {
    await rm(store, { recursive: true, force: true });
  });

  it("stores the golden bytes under archives/<sessionId>/<revision>-<materialKey>", async () => {
    const receipt = await Effect.runPromise(
      localArchiveWriter(store).write(write),
    );

    expect(write.sha256).toBe(goldenSha256);
    expect(receipt).toEqual({
      key: `archives/session-1/${finalName}`,
      sha256: goldenSha256,
      byteLength: Buffer.byteLength(goldenArchiveText),
    });
    expect(
      (await readFile(join(sessionDirectory(), finalName))).toString("utf8"),
    ).toBe(goldenArchiveText);
    expect(await listTree(store)).toEqual([
      "archives",
      "archives/session-1",
      `archives/session-1/${finalName}`,
    ]);
  });

  it("returns the same receipt for the same bytes and leaves one file", async () => {
    const writer = localArchiveWriter(store);
    const first = await Effect.runPromise(writer.write(write));
    const second = await Effect.runPromise(writer.write(write));

    expect(second).toEqual(first);
    expect(await readdir(sessionDirectory())).toEqual([finalName]);
  });

  it("reports conflict when different bytes already hold the key, and keeps them", async () => {
    await mkdir(sessionDirectory(), { recursive: true });
    await writeFile(
      join(sessionDirectory(), finalName),
      "someone else's bytes",
    );

    const error = await failureOf(localArchiveWriter(store).write(write));

    expect(error).toEqual({ _tag: "ArchiveWriteError", reason: "conflict" });
    expect(await readFile(join(sessionDirectory(), finalName), "utf8")).toBe(
      "someone else's bytes",
    );
    expect(await readdir(sessionDirectory())).toEqual([finalName]);
  });

  it("leaves no final file and no temp when the stream throws midway", async () => {
    const bytes = new TextEncoder().encode(goldenArchiveText);
    const broken = withChunks(write, async function* () {
      await Promise.resolve();
      yield bytes.subarray(0, 10);
      throw new Error("stream died");
    });

    const error = await failureOf(localArchiveWriter(store).write(broken));

    expect(error).toEqual({ _tag: "ArchiveWriteError", reason: "unavailable" });
    expect(await readdir(sessionDirectory())).toEqual([]);
  });

  it("rejects a stream shorter than byteLength as invalid and leaves nothing", async () => {
    const bytes = new TextEncoder().encode(goldenArchiveText);
    const short = withChunks(
      write,
      chunksOf(bytes.subarray(0, bytes.length - 1)),
    );

    const error = await failureOf(localArchiveWriter(store).write(short));

    expect(error).toEqual({ _tag: "ArchiveWriteError", reason: "invalid" });
    expect(await readdir(sessionDirectory())).toEqual([]);
  });

  it("rejects bytes whose sha256 differs from the declared digest", async () => {
    const flipped = new TextEncoder().encode(goldenArchiveText.toUpperCase());

    const error = await failureOf(
      localArchiveWriter(store).write(withChunks(write, chunksOf(flipped))),
    );

    expect(flipped.length).toBe(write.byteLength);
    expect(error).toEqual({ _tag: "ArchiveWriteError", reason: "invalid" });
    expect(await readdir(sessionDirectory())).toEqual([]);
  });

  it("rejects a chunk over 64 KiB as invalid and leaves nothing", async () => {
    const big = new Uint8Array(64 * 1024 + 1);
    const digest = createHash("sha256").update(big).digest("hex");
    const oversized: ArchiveWriteV1 = {
      ...write,
      byteLength: big.length,
      sha256: digest,
      materialKey: digest.slice(0, 32),
      chunks: chunksOf(big),
    };

    const error = await failureOf(localArchiveWriter(store).write(oversized));

    expect(error).toEqual({ _tag: "ArchiveWriteError", reason: "invalid" });
    expect(await readdir(sessionDirectory())).toEqual([]);
  });

  it("stores a client-chosen session id under one encoded directory inside archives", async () => {
    const hostile = prepareArchiveWrite("../escape/a b", goldenSource);
    const receipt = await Effect.runPromise(
      localArchiveWriter(store).write(hostile),
    );
    const directory = "archives/e..2e.2e.2fescape.2fa.20b";

    expect(receipt.key).toBe(`${directory}/row-42-${hostile.materialKey}`);
    expect(await listTree(store)).toEqual([
      "archives",
      directory,
      `${directory}/row-42-${hostile.materialKey}`,
    ]);
    expect(await readFile(join(store, ...receipt.key.split("/")), "utf8")).toBe(
      goldenArchiveText,
    );
  });

  it("refuses the empty session id", async () => {
    const error = await failureOf(
      localArchiveWriter(store).write({ ...write, sessionId: "" }),
    );

    expect(error).toEqual({ _tag: "ArchiveWriteError", reason: "invalid" });
    expect(await listTree(store)).toEqual([]);
  });

  it("rejects a materialKey that is not the first 32 hex of the sha256", async () => {
    const error = await failureOf(
      localArchiveWriter(store).write({
        ...write,
        materialKey: "0".repeat(32),
      }),
    );

    expect(error).toEqual({ _tag: "ArchiveWriteError", reason: "invalid" });
    expect(await listTree(store)).toEqual([]);
  });

  it("keeps the verified file when the directory fsync fails, and a retry returns the same receipt", async () => {
    const failing = localArchiveWriter(store, () =>
      Promise.reject(new Error("fsync failed")),
    );

    const error = await failureOf(failing.write(write));
    const retry = await Effect.runPromise(
      localArchiveWriter(store).write(write),
    );

    expect(error).toEqual({ _tag: "ArchiveWriteError", reason: "unavailable" });
    expect(retry).toEqual({
      key: `archives/session-1/${finalName}`,
      sha256: goldenSha256,
      byteLength: Buffer.byteLength(goldenArchiveText),
    });
    expect(await readFile(join(sessionDirectory(), finalName), "utf8")).toBe(
      goldenArchiveText,
    );
    expect(await readdir(sessionDirectory())).toEqual([finalName]);
  });

  it("fsyncs the directory when the key already holds the same bytes", async () => {
    const synced: string[] = [];
    const writer = localArchiveWriter(store, (directory) => {
      synced.push(directory);
      return Promise.resolve();
    });

    await Effect.runPromise(writer.write(write));
    await Effect.runPromise(writer.write(write));

    expect(synced).toEqual([sessionDirectory(), sessionDirectory()]);
  });
});
