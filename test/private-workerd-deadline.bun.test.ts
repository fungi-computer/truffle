import { expect, test } from "bun:test";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { z } from "zod";

// Short local runs still exercise real command deadlines and partial output.
// The default retains the qualification beyond Bun's former 300-second idle cap.
const commandDurationMs = z.coerce
  .number()
  .int()
  .min(3_000)
  .max(370_000)
  .default(370_000)
  .parse(process.env.LOCAL_DEADLINE_PROOF_DURATION_MS);

const fixture = fileURLToPath(
  new URL("./workerd-deadline.bun.test.mjs", import.meta.url),
);
async function proveDeadline(durationMs: number) {
  const child = Bun.spawn([process.execPath, fixture, String(durationMs)], {
    env: { ...process.env, BUN_CONFIG_HTTP_IDLE_TIMEOUT: "2" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  expect(JSON.parse(stdout)).toMatchObject({ durationMs, status: "passed" });
}

test("Bun dispatch ignores its fetch idle timer and preserves command deadline output", async () => {
  await proveDeadline(12_000);
}, 40_000);

test(
  `Bun execute survives a real ${String(commandDurationMs)}-millisecond command and returns partial output on deadline`,
  async () => {
    await proveDeadline(commandDurationMs);
  },
  commandDurationMs + 70_000,
);
