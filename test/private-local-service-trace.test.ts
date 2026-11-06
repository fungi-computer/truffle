import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceStreamCapture } from "../src/private-local-service-log.js";
import {
  encodeModelStreamRecord,
  serviceTraceRecordBytes,
} from "../src/private-local-service-trace.js";

const areas: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    areas.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("omits an oversized provider delta explicitly, without writing a broken or partial JSON record", () => {
  const record = encodeModelStreamRecord({
    requestId: "fixture",
    providerId: "fixture",
    modelId: "probe",
    event: "text_delta",
    contentIndex: 0,
    delta: "private-fixture-output".repeat(2000),
  });
  expect(Buffer.byteLength(record)).toBeLessThanOrEqual(
    serviceTraceRecordBytes,
  );
  expect(JSON.parse(record)).toMatchObject({
    event: "provider-event-omitted",
    originalEvent: "text_delta",
    reason: "record-byte-bound",
  });
  expect(record).not.toContain("private-fixture-output");
});

it("a stream capture rotates through four private bounded files and retains the newest deltas", async () => {
  const area = await mkdtemp(join(tmpdir(), "fungi-stream-trace-"));
  areas.push(area);
  const capture = createServiceStreamCapture(area);
  try {
    for (let index = 0; index < 1000; index++)
      capture.record({
        requestId: "fixture",
        providerId: "fixture",
        modelId: "probe",
        event: "text_delta",
        contentIndex: index,
        delta: "x".repeat(7000),
      });
    expect(capture.failed()).toBe(false);
  } finally {
    capture.close();
  }
  const names = await readdir(area);
  expect(names.sort()).toEqual([
    "service-stream.jsonl",
    "service-stream.jsonl.1",
    "service-stream.jsonl.2",
    "service-stream.jsonl.3",
  ]);
  let bytes = 0;
  for (const name of names) {
    const file = await stat(join(area, name));
    expect(file.mode & 0o777).toBe(0o600);
    expect(file.size).toBeLessThanOrEqual(1024 * 1024);
    bytes += file.size;
  }
  expect(bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
  const active = await readFile(join(area, "service-stream.jsonl"), "utf8");
  const last = active.trimEnd().split("\n").at(-1);
  if (last === undefined) throw new Error("Missing trace record");
  expect(JSON.parse(last)).toMatchObject({
    event: "text_delta",
    contentIndex: 999,
  });
});

it("rejects a 16 MiB raw output delta before serialization", () => {
  const stringify = vi.spyOn(JSON, "stringify");
  const record = encodeModelStreamRecord({
    requestId: "fixture",
    providerId: "openai",
    modelId: "probe",
    event: "provider_event",
    data: {
      type: "response.output_text.delta",
      delta: "x".repeat(16 * 1024 * 1024),
    },
  });
  expect(JSON.parse(record)).toMatchObject({
    event: "provider-event-omitted",
    reason: "record-byte-bound",
  });
  // The original bug called stringify on the entire raw event, then again on
  // the omission. Exactly one call, on omission metadata, pins the allocation boundary.
  expect(stringify).toHaveBeenCalledTimes(1);
  expect(stringify).toHaveBeenCalledWith(
    expect.objectContaining({ event: "provider-event-omitted" }),
  );
  expect(Buffer.byteLength(record)).toBeLessThanOrEqual(
    serviceTraceRecordBytes,
  );
});

it("omits response.created rather than persisting echoed instructions or configuration", () => {
  const record = encodeModelStreamRecord({
    requestId: "fixture",
    providerId: "openai",
    modelId: "probe",
    event: "provider_event",
    data: {
      type: "response.created",
      sequence_number: 0,
      response: {
        id: "resp_fixture",
        object: "response",
        status: "in_progress",
        instructions: "PRIVATE_INSTRUCTION_MARKER",
        output: [],
      },
    },
  });
  expect(record).not.toContain("PRIVATE_INSTRUCTION_MARKER");
  expect(record).not.toContain("instructions");
  expect(JSON.parse(record)).toMatchObject({
    event: "provider-event-omitted",
    providerType: "response.created",
    reason: "unsupported-provider-event",
  });
});

it("projects supported raw output without traversing or retaining its unrelated response fields", () => {
  const record = encodeModelStreamRecord({
    requestId: "fixture",
    providerId: "openai",
    modelId: "probe",
    event: "provider_event",
    data: {
      type: "response.output_text.delta",
      delta: "raw-output",
      content_index: 0,
      response: { instructions: "PRIVATE_INSTRUCTION_MARKER" },
      logprobs: ["omitted configuration"],
    },
  });
  expect(JSON.parse(record)).toMatchObject({
    event: "provider_event",
    data: {
      type: "response.output_text.delta",
      delta: "raw-output",
      content_index: 0,
    },
  });
  expect(record).not.toContain("PRIVATE_INSTRUCTION_MARKER");
  expect(record).not.toContain("omitted configuration");
});
