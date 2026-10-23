import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
} from "@earendil-works/pi-ai/providers/faux";
import { fauxModel } from "@fungi.computer/mule/testing";
import { createHash } from "node:crypto";
import { Shiitake, type ShiitakeSession } from "@fungi.computer/shiitake";
import type { BorrowedCompactionViewV0 } from "@fungi.computer/shiitake/extensions";
import {
  archiveHandoff,
  zookeeperCompaction,
  zookeeperCompactionGrant,
  type ArchiveWriter,
} from "@fungi.computer/zookeeper";
import {
  goldenArchiveText,
  goldenSource,
} from "@fungi.computer/zookeeper/testing";
import { Effect } from "effect";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { localArchiveWriter } from "../src/local-session-archives.js";
import {
  createPrivateLocalRuntimeHost,
  openPrivateLocalRuntimeHost,
} from "../src/private-local-runtime-host.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), `fungi-zookeeper-${label}-`)),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  what: string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function settled(session: ShiitakeSession, commandId: string) {
  const snapshot = await until(
    () => session.read(),
    ({ terminals }) =>
      terminals.some((terminal) => terminal.commandId === commandId),
    "the command to settle",
  );
  const terminal = snapshot.terminals.find(
    (candidate) => candidate.commandId === commandId,
  );
  return { snapshot, terminal };
}

/** A real Local host over a faux model whose store directory is returned. */
async function openHost(fills: readonly string[], size = 100_000) {
  const root = await temporaryDirectory("host");
  const faux = fauxProvider({
    provider: "faux-zookeeper",
    models: [{ id: "faux-1", contextWindow: 1_000_000, maxTokens: 100_000 }],
    tokenSize: { min: 100, max: 100 },
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const host = await openPrivateLocalRuntimeHost(
    { invocationRoot: root, providerId: "faux-zookeeper", modelId: "faux-1" },
    models,
  );
  const store = dirname(host.databasePath);
  const session = host.session;
  for (const [index, fill] of fills.entries()) {
    faux.setResponses([fauxAssistantMessage(fill.repeat(size))]);
    const accepted = await session.command({
      requestId: `zk-history-${String(index)}`,
      delivery: "followUp",
      type: "prompt",
      text: `Build history ${String(index)}.`,
    });
    await settled(session, accepted.commandId);
  }
  faux.setResponses([
    fauxAssistantMessage("zookeeper summary"),
    fauxAssistantMessage("zookeeper turn summary"),
  ]);
  return { host, session, store, faux };
}

const archiveLine = z.looseObject({
  format: z.string().optional(),
  section: z.string().optional(),
});

const archiveReceipt = z.strictObject({
  key: z.string(),
  sha256: z.string(),
  byteLength: z.number(),
});
const compactionRow = z.looseObject({
  data_json: z.string(),
});
const compactionData = z.looseObject({
  data: z.looseObject({ receipt: z.string().optional() }),
});

/** The receipt stored in each committed compaction entry of a Local store. */
function committedReceipts(databasePath: string): (string | undefined)[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        "SELECT data_json FROM session_entries WHERE type = 'compaction'",
      )
      .all()
      .map(
        (row) =>
          compactionData.parse(JSON.parse(compactionRow.parse(row).data_json))
            .data.receipt,
      );
  } finally {
    database.close();
  }
}

describe("Local Zookeeper compaction handoff on the real host", () => {
  it("archives what leaves the context as a file beside the store before the compaction commits", async () => {
    const { host, session, store } = await openHost(["x", "y"]);
    try {
      const accepted = await session.command({
        type: "compact",
        requestId: "zk-compact",
      });
      const { snapshot, terminal } = await settled(session, accepted.commandId);
      expect(terminal).toMatchObject({
        outcome: "completed",
        diagnostic: null,
      });
      expect(snapshot.compactions).toHaveLength(1);

      const sessionDirectory = join(store, "archives", snapshot.sessionId);
      const files = await readdir(sessionDirectory);
      expect(files).toHaveLength(1);
      const text = await readFile(
        join(sessionDirectory, files[0] ?? ""),
        "utf8",
      );
      const lines = text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => archiveLine.parse(JSON.parse(line)));
      expect(lines[0]?.format).toBe("zookeeper.compaction-archive/1");
      expect(lines.slice(1).every((line) => line.section !== undefined)).toBe(
        true,
      );
      expect(text).toContain("Build history 0.");
      // The summary is model output kept in the compaction entry, not archived.
      expect(text).not.toContain("zookeeper summary");
      const [name = ""] = files;
      expect(name).toMatch(/^[A-Za-z0-9_-]+-[0-9a-f]{32}$/u);
      // The entry that committed carries the receipt of exactly that file.
      const [stored] = committedReceipts(host.databasePath);
      expect(stored).toBeDefined();
      const receipt = archiveReceipt.parse(JSON.parse(stored ?? ""));
      expect(receipt).toEqual({
        key: `archives/${snapshot.sessionId}/${name}`,
        sha256: createHash("sha256").update(text).digest("hex"),
        byteLength: Buffer.byteLength(text),
      });
    } finally {
      await host.close();
    }
  });

  it("fails the command, keeps the prior context and leaves no archive when the write fails", async () => {
    const { host, session, store } = await openHost(["x", "y"]);
    try {
      // A file where the archive directory belongs makes every write unavailable.
      await writeFile(join(store, "archives"), "not a directory");
      const before = (await session.read()).messages.length;
      const accepted = await session.command({
        type: "compact",
        requestId: "zk-compact-fails",
      });
      const { snapshot, terminal } = await settled(session, accepted.commandId);
      expect(terminal?.outcome).toBe("failed");
      expect(terminal?.diagnostic).toContain("compaction handoff failed");
      expect(snapshot.compactions).toEqual([]);
      expect(snapshot.messages).toHaveLength(before);
      expect(committedReceipts(host.databasePath)).toEqual([]);
      expect(await readFile(join(store, "archives"), "utf8")).toBe(
        "not a directory",
      );
    } finally {
      await host.close();
    }
  });

  it("writes nothing when there is nothing to compact", async () => {
    const { host, session, store } = await openHost(["x"], 10);
    try {
      const accepted = await session.command({
        type: "compact",
        requestId: "zk-compact-nothing",
      });
      const { snapshot, terminal } = await settled(session, accepted.commandId);
      expect(terminal?.outcome).toBe("completed");
      expect(snapshot.compactions).toEqual([]);
      expect(await readdir(store)).not.toContain("archives");
    } finally {
      await host.close();
    }
  });
});

/**
 * A real Shiitake over an in-memory store, with Zookeeper's handoff on
 * `writer`, and two long turns of history in `sessionId` ready to compact.
 */
async function openLocalAgent(writer: ArchiveWriter, sessionId: string) {
  const database = new DatabaseSync(":memory:");
  const faux = fauxModel([]);
  const agent = await Shiitake.make({
    store: createPrivateSqliteOwner(database),
    extensions: {
      roster: [zookeeperCompaction({ writer })],
      grants: [zookeeperCompactionGrant],
    },
    runtime: createPrivateLocalRuntimeHost(),
    instructions: {
      load: () => Promise.resolve({ revision: "local", text: "Answer." }),
    },
    model: {
      acquire: () =>
        Promise.resolve({
          model: { ...faux.model, contextWindow: 1_000_000 },
          retryable: () => false,
          stream: faux.stream,
          release: () => Promise.resolve(),
        }),
    },
  });
  const session = agent.session(sessionId);
  for (const [index, fill] of ["x", "y"].entries()) {
    faux.setResponses([fauxAssistantMessage(fill.repeat(100_000))]);
    const accepted = await session.command({
      requestId: `local-history-${String(index)}`,
      delivery: "followUp",
      type: "prompt",
      text: `Build history ${String(index)}.`,
    });
    await settled(session, accepted.commandId);
  }
  faux.setResponses([
    fauxAssistantMessage("local summary"),
    fauxAssistantMessage("local turn summary"),
  ]);
  return {
    session,
    close: async () => {
      await agent.close();
      database.close();
    },
  };
}

describe("Zookeeper handoff ordering on the Local store", () => {
  it("writes the archive before the compaction entry is appended", async () => {
    const store = await temporaryDirectory("order");
    const files = localArchiveWriter(store);
    let readCompactions: () => Promise<number> = () => Promise.resolve(-1);
    const compactionsAtWrite: number[] = [];
    const writer: ArchiveWriter = {
      write: (input) =>
        Effect.gen(function* () {
          compactionsAtWrite.push(yield* Effect.promise(readCompactions));
          return yield* files.write(input);
        }),
    };
    const { session, close } = await openLocalAgent(writer, "order");
    readCompactions = async () =>
      ((await session.read()).compactions ?? []).length;
    try {
      const accepted = await session.command({
        type: "compact",
        requestId: "order-compact",
      });
      const { snapshot, terminal } = await settled(session, accepted.commandId);
      expect(terminal?.outcome).toBe("completed");
      expect(compactionsAtWrite).toEqual([0]);
      expect(snapshot.compactions).toHaveLength(1);
      expect(await readdir(join(store, "archives", "order"))).toHaveLength(1);
    } finally {
      await close();
    }
  });

  it("archives a client-chosen Session id under one encoded directory", async () => {
    const store = await temporaryDirectory("hostile-id");
    const { session, close } = await openLocalAgent(
      localArchiveWriter(store),
      "../weird id",
    );
    try {
      const accepted = await session.command({
        type: "compact",
        requestId: "hostile-compact",
      });
      const { snapshot, terminal } = await settled(session, accepted.commandId);
      expect(terminal).toMatchObject({
        outcome: "completed",
        diagnostic: null,
      });
      expect(snapshot.compactions).toHaveLength(1);
      expect(await readdir(join(store, "archives"))).toEqual([
        "e..2e.2e.2fweird.20id",
      ]);
    } finally {
      await close();
    }
  });
});

describe("Zookeeper handoff cancellation on the Local store", () => {
  it("leaves no final file, no temp file and no compaction when cancelled mid-write", async () => {
    const store = await temporaryDirectory("cancel");
    const files = localArchiveWriter(store);
    let reached: () => void = () => undefined;
    const midWrite = new Promise<void>((resolve) => {
      reached = resolve;
    });
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The same bytes, held after the first chunk so the cancel lands mid-write.
    async function* paused(chunks: AsyncIterable<Uint8Array>) {
      let first = true;
      for await (const chunk of chunks) {
        yield chunk;
        if (first) {
          first = false;
          reached();
          await released;
        }
      }
    }
    const writer: ArchiveWriter = {
      write: (input) =>
        files.write({ ...input, chunks: () => paused(input.chunks()) }),
    };
    const { session, close } = await openLocalAgent(writer, "cancel");
    try {
      const accepted = await session.command({
        type: "compact",
        requestId: "cancel-compact",
      });
      await midWrite;
      expect(await readdir(join(store, "archives", "cancel"))).toEqual([
        expect.stringMatching(/\.tmp$/u),
      ]);
      await session.cancel({ commandId: accepted.commandId });
      release();
      const { snapshot, terminal } = await settled(session, accepted.commandId);
      expect(terminal?.outcome).toBe("cancelled");
      expect(snapshot.compactions).toEqual([]);
      await until(
        () => readdir(join(store, "archives", "cancel")),
        (names) => names.length === 0,
        "the temporary file to be removed",
      );
    } finally {
      release();
      await close();
    }
  });
});

/** The golden compaction view, as the handoff receives it. */
function goldenView(): BorrowedCompactionViewV0 {
  return {
    sessionId: "session-1",
    messagesToSummarize: goldenSource.messagesToSummarize,
    turnPrefixMessages: goldenSource.turnPrefixMessages,
    contextRevision: goldenSource.contextRevision,
    result: {
      summary: "not archived",
      firstKeptEntryId: goldenSource.firstKeptEntryId,
      tokensBefore: 1,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  };
}

describe("Local archive bytes", () => {
  it("writes the golden archive bytes to disk through the handoff", async () => {
    const store = await temporaryDirectory("golden");
    await mkdir(store, { recursive: true });
    const result = await Effect.runPromise(
      archiveHandoff(localArchiveWriter(store)).consume(goldenView()),
    );
    expect(result.type).toBe("accepted");
    const directory = join(store, "archives", "session-1");
    const [name] = await readdir(directory);
    expect(await readFile(join(directory, name ?? ""), "utf8")).toBe(
      goldenArchiveText,
    );
  });

  it("gives the same receipt when the same material is handed off again", async () => {
    const store = await temporaryDirectory("retry");
    const handoff = archiveHandoff(localArchiveWriter(store));
    const view = goldenView();
    const first = await Effect.runPromise(handoff.consume(view));
    const again = await Effect.runPromise(handoff.consume(view));
    expect(first.type).toBe("accepted");
    expect(again).toEqual(first);
    expect(await readdir(join(store, "archives", "session-1"))).toHaveLength(1);
  });
});
