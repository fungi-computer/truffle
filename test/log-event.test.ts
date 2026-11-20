import { inspect } from "node:util";
import * as Redacted from "effect/Redacted";
import { afterEach, expect, it, vi } from "vitest";
import { ShiitakeError } from "@fungi.computer/shiitake";
import { z } from "zod";
import { localFailureMetadata, logEvent } from "../src/log-event.js";
import { encodeServiceLogRecord } from "../src/private-local-service-log.js";

afterEach(() => vi.restoreAllMocks());

const marker = "synthetic-private-cause-marker";
const nested = new Error(`Nested I/O failure ${marker}`);
const failure = new Error(`Operation failed ${marker}`, { cause: nested });

it.each([failure, marker])(
  "Local runtime reporter retains the redacted caught value (case %#)",
  (cause) => {
    const report = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    logEvent("fixture.read", cause);
    expect(report).toHaveBeenCalledOnce();
    const retained = report.mock.calls
      .flatMap((args: unknown[]) => args)
      .filter(Redacted.isRedacted)
      .map(Redacted.value);
    expect(retained).toHaveLength(1);
    expect(retained[0]).toBe(cause);
    if (retained[0] instanceof Error) {
      expect(retained[0].cause).toBe(nested);
      expect(retained[0].stack).toBe(failure.stack);
    }
    expect(JSON.stringify(report.mock.calls)).toContain("fixture.read");
    expect(JSON.stringify(report.mock.calls)).not.toContain(marker);
    expect(inspect(report.mock.calls, { depth: null })).not.toContain(marker);
    expect(
      report.mock.calls
        .flatMap((args: unknown[]) => args)
        .map(String)
        .join(" "),
    ).not.toContain(marker);
  },
);

it("logs a recorder failure's typed cause, not its session content", () => {
  const privateText = "private session content";
  const native = Object.assign(new Error(privateText), {
    code: "ERR_SQLITE_ERROR",
    errcode: 5,
  });
  const store = new ShiitakeError(
    "store",
    "rejected",
    "Native Session store operation failed",
    undefined,
    native,
  );
  const rejected = new ShiitakeError(
    "runtime",
    "rejected",
    "Mule rejected the durable command run",
    undefined,
    {
      _tag: "MuleError",
      phase: "listener",
      message: privateText,
      cause: store,
    },
  );
  const metadata = localFailureMetadata("service.request", rejected);
  expect(metadata).toMatchObject({
    failureKind: "Error",
    recorderCause: "store:rejected",
    sqliteCause: "busy",
  });
  expect(JSON.stringify(metadata)).not.toContain(privateText);
  const line = encodeServiceLogRecord({
    source: "local-service",
    timestamp: "2026-10-30T19:07:11.000Z",
    pid: 42,
    version: "test",
    event: "failure",
    failure: metadata,
  });
  expect(JSON.parse(line)).toMatchObject({
    event: "failure",
    failure: { recorderCause: "store:rejected", sqliteCause: "busy" },
  });
  expect(line).not.toContain(privateText);
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  logEvent("service.request", rejected);
  const logged = z.string().parse(report.mock.calls[0]?.[0]);
  expect(JSON.parse(logged)).toMatchObject({
    recorderCause: "store:rejected",
    sqliteCause: "busy",
  });
  expect(JSON.stringify(report.mock.calls)).not.toContain(privateText);

  const conflict = new ShiitakeError("store", "conflict", privateText);
  const retry = new ShiitakeError(
    "runtime",
    "rejected",
    "Mule rejected the durable command run",
    undefined,
    {
      _tag: "MuleError",
      phase: "listener",
      message: privateText,
      cause: conflict,
    },
  );
  expect(localFailureMetadata("service.request", retry)).toMatchObject({
    recorderCause: "store:conflict",
  });
  expect(
    JSON.stringify(localFailureMetadata("service.request", retry)),
  ).not.toContain(privateText);
});

it("names the failure by tag or code and never by its message", () => {
  const secret = "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD";
  const refused = Object.assign(new Error(`connect failed with ${secret}`), {
    code: "ECONNRESET",
  });
  class ProviderTimeout extends Error {
    public override readonly name = "ProviderTimeout";
  }
  const hostile = Object.assign(new Error("x"), { code: `bad ${secret}` });
  const store = new ShiitakeError("store", "rejected", `text ${secret}`);

  expect(localFailureMetadata("service.request", refused)).toMatchObject({
    failureKind: "Error",
    failureTag: "ECONNRESET",
  });
  expect(
    localFailureMetadata("service.request", new ProviderTimeout(secret)),
  ).toMatchObject({ failureTag: "ProviderTimeout" });
  expect(localFailureMetadata("service.request", store)).toMatchObject({
    failureTag: "store:rejected",
  });
  // A plain Error, a non-Error and a code outside the closed charset carry no
  // tag at all, so no message text can reach the record.
  for (const cause of [new Error(secret), secret, hostile])
    expect(localFailureMetadata("service.request", cause)).not.toHaveProperty(
      "failureTag",
    );
  for (const cause of [refused, store, hostile]) {
    expect(JSON.stringify(localFailureMetadata("op", cause))).not.toContain(
      secret,
    );
    const line = encodeServiceLogRecord({
      source: "local-service",
      timestamp: "2026-11-19T10:00:00.000Z",
      pid: 1,
      version: "test",
      event: "failure",
      failure: localFailureMetadata("op", cause),
    });
    expect(line).not.toContain(secret);
  }
  const report = vi.spyOn(console, "error").mockImplementation(() => undefined);
  logEvent("service.request", refused);
  expect(z.string().parse(report.mock.calls[0]?.[0])).toContain(
    '"failureTag":"ECONNRESET"',
  );
});
