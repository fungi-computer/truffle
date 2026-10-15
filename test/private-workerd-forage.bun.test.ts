import { expect, test } from "bun:test";
import process from "node:process";
import { fileURLToPath } from "node:url";

test("a local process sandbox runs real forage.search", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(
        new URL("./fixtures/forage-process.fixture.mjs", import.meta.url),
      ),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stdout, stderr }).toEqual({
    exitCode: 0,
    stdout: "forage.search passed\n",
    stderr: "",
  });
}, 30_000);
