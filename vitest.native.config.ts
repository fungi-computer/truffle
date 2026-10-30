import { defineConfig } from "vitest/config";

// Native sandbox qualification: never overlap bwrap/Seatbelt/host fixtures.
export default defineConfig({
  test: {
    include: ["test/**/*.native.test.ts"],
    fileParallelism: false,
    maxWorkers: 1,
  },
});
