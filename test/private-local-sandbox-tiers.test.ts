import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { z } from "zod";
import unit from "../vitest.config.js";
import native from "../vitest.native.config.js";

it("keeps native sandbox qualification reachable in merge with one file worker", () => {
  const manifest = z
    .object({ scripts: z.record(z.string(), z.string()) })
    .parse(
      JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ),
    );
  expect(unit.test?.exclude).toContain("**/*.native.test.ts");
  expect(native.test).toMatchObject({
    include: ["test/**/*.native.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
  });
  expect(manifest).toMatchObject({
    scripts: {
      "test:node": "../../node_modules/.bin/vitest run",
      "test:sandbox:native":
        "../../node_modules/.bin/vitest run --config vitest.native.config.ts",
    },
  });
  expect(manifest.scripts["test:unit"]).toContain("pnpm run test:node");
  expect(manifest.scripts["test:merge"]).toContain(
    "pnpm run test:sandbox:native",
  );
  expect(manifest.scripts.test).toContain("pnpm run test:merge");
});
