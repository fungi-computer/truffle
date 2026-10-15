import { expect, it } from "vitest";

import {
  capturePrivateLocalExecPath,
  parsePrivateLocalExecPath,
} from "../src/private-local-exec-path.js";

it("accepts bounded absolute PATH directories and rejects unsafe segments", () => {
  expect(parsePrivateLocalExecPath("/opt/mise/shims:/usr/bin:/bin")).toBe(
    "/opt/mise/shims:/usr/bin:/bin",
  );
  for (const path of [
    "",
    "relative:/usr/bin",
    "/usr/bin:",
    ":/usr/bin",
    "/usr/bin::/bin",
    "/usr/bin\n:/bin",
    "x".repeat(8_193),
    Array.from({ length: 65 }, (_, index) => `/tools/${String(index)}`).join(
      ":",
    ),
  ]) {
    expect(() => parsePrivateLocalExecPath(path)).toThrow();
  }
});

it("captures client-relative entries as absolute while rejecting empty entries", () => {
  expect(
    capturePrivateLocalExecPath("./node_modules/.bin:/usr/bin", "/project"),
  ).toBe("/project/node_modules/.bin:/usr/bin");
  expect(() => capturePrivateLocalExecPath("/usr/bin:", "/project")).toThrow();
});
