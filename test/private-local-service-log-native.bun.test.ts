import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { heapStats } from "bun:jsc";
import { Buffer } from "node:buffer";
import fs, { createReadStream, statSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createServiceLogLifecycle } from "../src/private-local-service-log.js";
import { localFailureMetadata } from "../src/log-event.js";

// Exercise the existing lifecycle's default writer on the native filesystem,
// without module replacement or a production testing export.
const fixtureRoot = fileURLToPath(
  new URL("../../../.botanical/service-log-fixtures/", import.meta.url),
);

async function fixture() {
  await mkdir(fixtureRoot, { recursive: true, mode: 0o700 });
  return mkdtemp(join(fixtureRoot, "native-mode-"));
}

afterEach(() => {
  mock.restore();
});

function openDiagnostics(directory: string) {
  return createServiceLogLifecycle({
    directory,
    pid: process.pid,
    version: "source",
    readMemory: () => ({
      rss: process.memoryUsage().rss,
      heap: heapStats(),
    }),
  });
}

function boundedOperation(sequence: number) {
  return `native-bound.${String(sequence)}.` + "é".repeat(9000);
}

function emitBoundedRecord(
  diagnostics: ReturnType<typeof openDiagnostics>,
  sequence: number,
) {
  diagnostics.failure(
    localFailureMetadata(boundedOperation(sequence), new Error("fixture")),
  );
}

test.skipIf(process.platform === "win32")(
  "native sink creates a 0600 file under umask 022",
  async () => {
    const root = await fixture();
    const previousMask = process.umask(0o022);
    let diagnostics: ReturnType<typeof openDiagnostics> | undefined;
    try {
      diagnostics = openDiagnostics(root);
      expect(diagnostics.getStatus()).toEqual({ state: "active" });
      diagnostics.close();
      expect(statSync(join(root, "service.jsonl")).mode & 0o777).toBe(0o600);
    } finally {
      // Restore before awaiting cleanup; no other fixture inherits this mask.
      process.umask(previousMask);
      diagnostics?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a reported native short write latches FAILED once and retires sink and sampler",
  async () => {
    const root = await fixture();
    let diagnostics: ReturnType<typeof openDiagnostics> | undefined;
    try {
      diagnostics = openDiagnostics(root);
      expect(diagnostics.getStatus()).toEqual({ state: "active" });
      diagnostics.ready("native-short-write");
      // Controlled SDK result, not an OS short-write claim: the maintained
      // writeSync contract permits a byte count smaller than the supplied line.
      // Startup/ready and descriptor close still use the real native filesystem.
      const writes = spyOn(fs, "writeSync").mockReturnValueOnce(1);
      const closes = spyOn(fs, "closeSync");
      const clears = spyOn(globalThis, "clearInterval");
      emitBoundedRecord(diagnostics, 0);
      const first = diagnostics.getStatus();
      expect(first).toMatchObject({
        state: "failed",
        code: "sink-write-failed",
      });
      if (first.state !== "failed")
        throw new Error("Short write was not latched");
      expect(new Date(first.since).toISOString()).toBe(first.since);
      const failedSize = statSync(join(root, "service.jsonl")).size;
      for (let sequence = 1; sequence < 10; sequence++)
        emitBoundedRecord(diagnostics, sequence);
      diagnostics.ready("cannot-restart");
      diagnostics.stopping("SIGTERM");
      diagnostics.close();
      diagnostics.close();
      expect(diagnostics.getStatus()).toBe(first);
      expect(statSync(join(root, "service.jsonl")).size).toBe(failedSize);
      expect(writes).toHaveBeenCalledTimes(1);
      expect(closes).toHaveBeenCalledTimes(1);
      expect(clears).toHaveBeenCalledTimes(1);
    } finally {
      diagnostics?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "a real archive rename collision becomes the stable first write failure",
  async () => {
    const root = await fixture();
    let diagnostics: ReturnType<typeof openDiagnostics> | undefined;
    try {
      diagnostics = openDiagnostics(root);
      expect(diagnostics.getStatus()).toEqual({ state: "active" });
      diagnostics.ready("native-rename-fault");
      // Change the destination AFTER open validation. A real rename from the
      // regular .2 file to a nonempty .3 directory must fail at the native API.
      await writeFile(join(root, "service.jsonl.2"), "", { mode: 0o600 });
      await mkdir(join(root, "service.jsonl.3"));
      await writeFile(join(root, "service.jsonl.3", "occupied"), "fixture");
      const renames = spyOn(fs, "renameSync"); // passthrough, no fabricated error
      for (
        let sequence = 0;
        sequence < 100 && diagnostics.getStatus().state === "active";
        sequence++
      )
        emitBoundedRecord(diagnostics, sequence);
      expect(renames).toHaveBeenCalledWith(
        join(root, "service.jsonl.2"),
        join(root, "service.jsonl.3"),
      );
      const first = diagnostics.getStatus();
      expect(first).toMatchObject({
        state: "failed",
        code: "sink-write-failed",
      });
      expect(JSON.stringify(first)).not.toContain(root);
      const renameCalls = renames.mock.calls.length;
      const failedSize = statSync(join(root, "service.jsonl")).size;
      emitBoundedRecord(diagnostics, 100);
      diagnostics.stopping("SIGTERM");
      diagnostics.close();
      expect(diagnostics.getStatus()).toBe(first);
      expect(renames).toHaveBeenCalledTimes(renameCalls);
      expect(statSync(join(root, "service.jsonl")).size).toBe(failedSize);
    } finally {
      diagnostics?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "expanded records survive repeated native rotations in four private files within 4 MiB with intact UTF-8 JSON",
  async () => {
    const root = await fixture();
    let diagnostics: ReturnType<typeof openDiagnostics> | undefined;
    try {
      diagnostics = openDiagnostics(root);
      expect(diagnostics.getStatus()).toEqual({ state: "active" });
      for (let sequence = 0; sequence < 1000; sequence++) {
        emitBoundedRecord(diagnostics, sequence);
        expect(diagnostics.getStatus()).toEqual({ state: "active" });
        const names = fs.readdirSync(root);
        expect(names.length).toBeLessThanOrEqual(4);
        let total = 0;
        for (const name of names) {
          expect(
            [
              "service.jsonl",
              "service.jsonl.1",
              "service.jsonl.2",
              "service.jsonl.3",
            ].includes(name),
          ).toBe(true);
          const file = statSync(join(root, name));
          expect(file.size).toBeLessThanOrEqual(1_048_576);
          if (process.platform !== "win32")
            expect(file.mode & 0o777).toBe(0o600);
          total += file.size;
        }
        // Ruling literals, not a bound recomputed from production constants.
        expect(total).toBeLessThanOrEqual(4_194_304);
      }
      diagnostics.close();
      const names = fs.readdirSync(root);
      expect(names.length).toBe(4);
      const rowSchema = z.object({
        event: z.literal("failure"),
        failure: z.object({ operation: z.string() }),
      });
      const seen = new Set<string>();
      for (const name of names) {
        const lines = createInterface({
          input: createReadStream(join(root, name)),
        });
        try {
          for await (const line of lines) {
            expect(Buffer.byteLength(line, "utf8") + 1).toBeGreaterThan(16_384);
            expect(Buffer.byteLength(line, "utf8") + 1).toBeLessThanOrEqual(
              32_768,
            );
            const row = rowSchema.parse(JSON.parse(line));
            expect(seen.has(row.failure.operation)).toBe(false);
            seen.add(row.failure.operation);
          }
        } finally {
          lines.close();
        }
      }
      expect(seen.has(boundedOperation(999))).toBe(true);
    } finally {
      diagnostics?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);

test.skipIf(process.platform === "win32")(
  "the native file receives a whole omission record rather than oversized or byte-sliced JSON",
  async () => {
    const root = await fixture();
    let diagnostics: ReturnType<typeof openDiagnostics> | undefined;
    try {
      diagnostics = openDiagnostics(root);
      expect(diagnostics.getStatus()).toEqual({ state: "active" });
      diagnostics.failure(
        localFailureMetadata(
          "fixture." + "é".repeat(16_384),
          new Error("synthetic-private-cause"),
        ),
      );
      diagnostics.close();
      const lines = createInterface({
        input: createReadStream(join(root, "service.jsonl")),
      });
      const events: string[] = [];
      try {
        for await (const line of lines) {
          expect(Buffer.byteLength(line, "utf8") + 1).toBeLessThanOrEqual(
            32_768,
          );
          events.push(
            z.object({ event: z.string() }).parse(JSON.parse(line)).event,
          );
          expect(line.includes("synthetic-private-cause")).toBe(false);
        }
      } finally {
        lines.close();
      }
      expect(events).toEqual(["starting", "record-omitted"]);
    } finally {
      diagnostics?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.skipIf(process.platform === "win32")(
  "native sink refuses an existing permissive file without repairing its mode",
  async () => {
    const root = await fixture();
    const path = join(root, "service.jsonl");
    let diagnostics: ReturnType<typeof openDiagnostics> | undefined;
    try {
      await writeFile(path, "");
      await chmod(path, 0o644);
      diagnostics = openDiagnostics(root);
      expect(diagnostics.getStatus()).toMatchObject({
        state: "failed",
        code: "sink-open-failed",
      });
      diagnostics.close();
      expect(statSync(path).mode & 0o777).toBe(0o644);
    } finally {
      diagnostics?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("one typed rule match lands in the isolated HOME service log, without arguments or environment", async () => {
  const root = await fixture();
  const home = join(root, "home");
  const directory = join(home, ".fungi", "service");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const diagnostics = openDiagnostics(directory);
  try {
    diagnostics.ruleMatch({
      agentId: "agent-1",
      executable: "git",
      ruleId: "sha256-rule-id",
    });
    diagnostics.close();
    const log = await readFile(join(directory, "service.jsonl"), "utf8");
    const records = log
      .trimEnd()
      .split(String.fromCharCode(10))
      .map((line) =>
        z.looseObject({ event: z.string() }).parse(JSON.parse(line)),
      );
    const matched = records.filter(
      (record) => record.event === "exec-rule-match",
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]).toEqual({
      source: "local-service",
      event: "exec-rule-match",
      timestamp: expect.any(String),
      pid: process.pid,
      version: "source",
      agentId: "agent-1",
      executable: "git",
      ruleId: "sha256-rule-id",
    });
  } finally {
    diagnostics.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("approval choices record once/always and the persisted rule id without command text", async () => {
  const root = await fixture();
  const directory = join(root, "home", ".fungi", "service");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const diagnostics = openDiagnostics(directory);
  try {
    diagnostics.approvalDecision({
      agentId: "agent-1",
      recordId: "approval-1",
      decision: "approve",
      scope: "once",
    });
    diagnostics.approvalDecision({
      agentId: "agent-1",
      recordId: "approval-2",
      decision: "approve",
      scope: "always",
      ruleId: "local_exec_rule_1",
    });
    diagnostics.approvalDecision({
      agentId: "agent-1",
      recordId: "approval-3",
      decision: "deny",
    });
    diagnostics.close();
    const records = (await readFile(join(directory, "service.jsonl"), "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) =>
        z.looseObject({ event: z.string() }).parse(JSON.parse(line)),
      )
      .filter((record) => record.event === "exec-approval-decision");
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({
      scope: "once",
      decision: "approve",
      recordId: "approval-1",
    });
    expect(records[1]).toMatchObject({
      scope: "always",
      decision: "approve",
      recordId: "approval-2",
      ruleId: "local_exec_rule_1",
    });
    expect(records[2]).toMatchObject({
      decision: "deny",
      recordId: "approval-3",
    });
    expect(JSON.stringify(records)).not.toContain("commit");
  } finally {
    diagnostics.close();
    await rm(root, { recursive: true, force: true });
  }
});
