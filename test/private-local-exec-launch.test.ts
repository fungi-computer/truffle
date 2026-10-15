import { describe, expect, it } from "vitest";
import {
  combinedArgvBytes,
  launchCwdSchema,
  launchStdinSchema,
  maximumLaunchStdinBytes,
  maximumLaunchTextLength,
} from "../src/private-local-exec-launch.js";

describe("exec launch stdin bound (own rationale, own number)", () => {
  it("accepts stdin at exactly the byte bound", () => {
    const value = "a".repeat(maximumLaunchStdinBytes);
    expect(launchStdinSchema.parse(value)).toBe(value);
  });

  it("refuses stdin one ASCII byte over the bound", () => {
    const value = "a".repeat(maximumLaunchStdinBytes + 1);
    expect(() => launchStdinSchema.parse(value)).toThrow();
  });

  it("refuses multi-byte stdin that is under the bound in UTF-16 code units but over it in UTF-8 bytes", () => {
    // "日" is one UTF-16 code unit and three UTF-8 bytes. This count keeps
    // `.length` under the byte bound while the real UTF-8 size exceeds it,
    // so only a true byte-length check (not a code-unit count) refuses it.
    const count = Math.ceil(maximumLaunchStdinBytes / 3) + 1;
    const value = "日".repeat(count);
    expect(value.length).toBeLessThan(maximumLaunchStdinBytes);
    expect(Buffer.byteLength(value, "utf8")).toBeGreaterThan(
      maximumLaunchStdinBytes,
    );
    expect(() => launchStdinSchema.parse(value)).toThrow();
  });

  it("refuses a lone surrogate instead of silently becoming U+FFFD", () => {
    expect(() => launchStdinSchema.parse("\uD800")).toThrow();
    expect(() => launchStdinSchema.parse("\uDC00")).toThrow();
  });

  it("accepts a well-formed surrogate pair", () => {
    const value = "🍄"; // a valid surrogate pair, not a lone half
    expect(launchStdinSchema.parse(value)).toBe(value);
  });
});

describe("exec launch combined-argv bound (own rationale, own number)", () => {
  it("accepts combined executable+args bytes at exactly the bound", () => {
    const executable = "a".repeat(maximumLaunchTextLength - 2);
    const args = ["bc"];
    expect(combinedArgvBytes(executable, args)).toBe(maximumLaunchTextLength);
  });

  it("counts one byte over the bound", () => {
    const executable = "a".repeat(maximumLaunchTextLength - 2);
    expect(combinedArgvBytes(executable, ["bcd"])).toBe(
      maximumLaunchTextLength + 1,
    );
  });

  it("measures combined argv bytes by UTF-8 size, not UTF-16 code units", () => {
    const count = Math.ceil(maximumLaunchTextLength / 3) + 1;
    const executable = "日".repeat(count);
    expect(executable.length).toBeLessThan(maximumLaunchTextLength);
    expect(combinedArgvBytes(executable, [])).toBeGreaterThan(
      maximumLaunchTextLength,
    );
  });

  it("includes every arg, not just the executable", () => {
    expect(combinedArgvBytes("a", ["bb", "ccc"])).toBe(
      Buffer.byteLength("a") +
        Buffer.byteLength("bb") +
        Buffer.byteLength("ccc"),
    );
  });
});

describe("exec launch cwd shape", () => {
  it("accepts a plain absolute path", () => {
    expect(launchCwdSchema.parse("/tmp/project")).toBe("/tmp/project");
  });

  it("refuses a relative path", () => {
    expect(() => launchCwdSchema.parse("relative/path")).toThrow();
  });

  it("refuses a path containing a NUL byte", () => {
    expect(() => launchCwdSchema.parse("/tmp/a\0b")).toThrow();
  });
});
