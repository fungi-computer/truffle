import { describe, expect, it } from "vitest";
import {
  parseMacProcessStart,
  readGroupProcessStart,
} from "../src/private-local-process-groups.js";

describe("process group start-time reader", () => {
  it("parses a macOS lstart, including a space-padded day", () => {
    expect(parseMacProcessStart("Thu Nov 12 10:00:00 2026\n")).toEqual({
      kind: "running",
      start: "darwin:Thu Nov 12 10:00:00 2026",
    });
    expect(parseMacProcessStart("  Sun Nov  1 09:05:07 2026 ")).toEqual({
      kind: "running",
      start: "darwin:Sun Nov  1 09:05:07 2026",
    });
  });

  it("reads empty output as a missing process and anything else as unverifiable", () => {
    expect(parseMacProcessStart("")).toEqual({ kind: "gone" });
    expect(parseMacProcessStart("\n")).toEqual({ kind: "gone" });
    expect(parseMacProcessStart("12345 sh -c sleep")).toEqual({
      kind: "unverifiable",
    });
    expect(parseMacProcessStart("Thu Nov 12 10:00:00")).toEqual({
      kind: "unverifiable",
    });
  });

  it("uses ps on darwin, never on other platforms", async () => {
    const asked: number[] = [];
    const ps = (pid: number) => {
      asked.push(pid);
      return Promise.resolve("Thu Nov 12 10:00:00 2026\n");
    };
    expect(await readGroupProcessStart(42, "darwin", ps)).toEqual({
      kind: "running",
      start: "darwin:Thu Nov 12 10:00:00 2026",
    });
    expect(asked).toEqual([42]);
    expect(await readGroupProcessStart(42, "win32", ps)).toEqual({
      kind: "unverifiable",
    });
    expect(asked).toEqual([42]);
  });

  it("reads this process on the current platform", async () => {
    const own = await readGroupProcessStart(process.pid);
    if (process.platform === "linux" || process.platform === "darwin")
      expect(own.kind).toBe("running");
    else expect(own.kind).toBe("unverifiable");
  });
});
