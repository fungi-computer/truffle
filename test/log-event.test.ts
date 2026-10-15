import { inspect } from "node:util";
import * as Redacted from "effect/Redacted";
import { afterEach, expect, it, vi } from "vitest";
import { logEvent } from "../src/log-event.js";

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
