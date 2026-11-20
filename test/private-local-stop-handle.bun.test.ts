import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { spawn } from "bun";

const fixture = join(import.meta.dir, "fixtures", "stop-handle-service.ts");

async function run(mode: "handle" | "signal") {
  const home = await mkdtemp(join(tmpdir(), "fungi-stop-handle-"));
  try {
    const child = spawn(
      [process.execPath, fixture, join(home, ".fungi", "service"), mode],
      { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { stderr, code };
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("stopping an embedded Local service", () => {
  it("a failing proof prints its failure when the service stops through its handle", async () => {
    const { stderr, code } = await run("handle");
    expect(stderr).toContain("deliberate fixture failure");
    expect(code).toBe(1);
  }, 30_000);

  it("a process-wide SIGTERM with a Miniflare alive ends the process with 143 and no failure", async () => {
    // Why proofs stop their listener through the handle: Miniflare's exit hook
    // runs process.exit(143) from the signal and the failure never prints.
    const { stderr, code } = await run("signal");
    expect(code).toBe(143);
    expect(stderr).not.toContain("deliberate fixture failure");
  }, 30_000);
});
