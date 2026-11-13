import { expect, test } from "bun:test";
import { spawn } from "bun";
import { createReadStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { readServiceRecord } from "../src/private-local-service-discovery.js";

const fixture = new URL("./fixtures/watchdog-service.ts", import.meta.url);
async function start(directory: string, environment: NodeJS.ProcessEnv = {}) {
  const child = spawn([process.execPath, fixture.pathname, directory], {
    env: { ...process.env, ...environment, HOME: directory },
    stdout: "ignore",
    stderr: "inherit",
  });
  try {
    for (let attempt = 0; attempt < 400; attempt++) {
      const record = await readServiceRecord(directory);
      if (record?.pid === child.pid) return { child, record };
      if (child.exitCode !== null)
        throw new Error(
          `Fixture exited before ready (${String(child.exitCode)})`,
        );
      await Bun.sleep(25);
    }
    throw new Error("Fixture service did not start");
  } catch (cause) {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    throw cause;
  }
}
async function withService(
  run: (
    service: Awaited<ReturnType<typeof start>>,
    directory: string,
  ) => Promise<void>,
  environment: NodeJS.ProcessEnv = {},
) {
  const area = await mkdtemp(join(tmpdir(), "fungi-watchdog-"));
  const directory = join(area, "service");
  await mkdir(directory, { mode: 0o700 });
  const service = await start(directory, environment);
  try {
    await run(service, directory);
  } finally {
    if (service.child.exitCode === null) {
      service.child.kill("SIGKILL");
      await service.child.exited;
    }
    await rm(area, { recursive: true, force: true });
  }
}
// Waits on the real event (the child exiting) rather than a wall-clock race:
// the product's stall bound is asserted through the evidence's boundMs, and the
// test timeout is the only backstop against a service that never exits.
async function stall(service: Awaited<ReturnType<typeof start>>) {
  const { child, record } = service;
  const request = fetch(
    `${record.baseUrl}/service/${record.serviceId}/models`,
  ).then(
    () => "replied",
    () => "closed",
  );
  try {
    expect(await child.exited).toBe(1);
    expect(await request).toBe("closed");
    expect(child.signalCode).toBeNull();
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await request;
  }
}

test("an endless service-loop stall preserves typed evidence and exits without a signal", async () => {
  await withService(async (service, directory) => {
    expect(service.record.pid).toBe(service.child.pid);
    await stall(service);
    const evidence = z
      .object({
        event: z.literal("watchdog-exit"),
        reason: z.literal("event-loop-stall"),
        pid: z.number(),
        boundMs: z.literal(200),
        capture: z.object({
          state: z.literal("captured"),
          bytes: z.number().positive(),
        }),
      })
      .parse(
        JSON.parse(
          await readFile(join(directory, "watchdog-exit.json"), "utf8"),
        ),
      );
    expect(evidence.pid).toBe(service.child.pid);
    const streamPath = join(directory, "watchdog-stream.jsonl");
    const lines = createInterface({
      input: createReadStream(streamPath),
      crlfDelay: Infinity,
    });
    let text = "";
    const requests = new Set<string>();
    for await (const line of lines) {
      const record = z
        .object({
          requestId: z.string(),
          providerId: z.literal("watchdog-fixture"),
          event: z.string(),
          delta: z.string().optional(),
        })
        .parse(JSON.parse(line));
      requests.add(record.requestId);
      if (record.event === "text_delta") text += record.delta ?? "";
    }
    expect(text).toBe("fixture-stream-marker");
    expect(await readFile(streamPath, "utf8")).toContain("raw-fixture-marker");
    expect(requests.size).toBe(1);
    expect(await readFile(streamPath, "utf8")).not.toContain("fixture prompt");
    for (const name of ["watchdog-exit.json", "watchdog-stream.jsonl"]) {
      const file = await stat(join(directory, name));
      expect(file.mode & 0o777).toBe(0o600);
      expect(file.size).toBeLessThanOrEqual(4 * 1024 * 1024);
    }
    const beforeRestart = await readFile(streamPath, "utf8");
    const restarted = await start(directory);
    try {
      restarted.child.kill("SIGTERM");
      expect(await restarted.child.exited).toBe(0);
      expect(await readFile(streamPath, "utf8")).toBe(beforeRestart);
    } finally {
      if (restarted.child.exitCode === null) {
        restarted.child.kill("SIGKILL");
        await restarted.child.exited;
      }
    }
  });
}, 30_000);

test("sustained runaway RSS preserves evidence and exits with the distinct restart code", async () => {
  const area = await mkdtemp(join(tmpdir(), "fungi-watchdog-rss-"));
  const directory = join(area, "service");
  await mkdir(directory, { mode: 0o700 });
  // 64 MiB is the policy minimum; a starting Bun listener passes it, so the
  // service may exit before it is ready to publish its record.
  const limit = 64 * 1024 * 1024;
  const child = spawn([process.execPath, fixture.pathname, directory], {
    env: {
      ...process.env,
      HOME: directory,
      FIXTURE_RSS_LIMIT_BYTES: String(limit),
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  try {
    const exit = await Promise.race([
      child.exited,
      Bun.sleep(5_000).then(() => "still-running"),
    ]);
    expect(exit).toBe(75);
    expect(child.signalCode).toBeNull();
    const evidence = z
      .object({
        event: z.literal("watchdog-exit"),
        reason: z.literal("rss-bound"),
        pid: z.literal(child.pid),
        rssLimitBytes: z.literal(limit),
        boundMs: z.literal(400),
        lagMs: z.number().min(400),
        openFds: z.number().int().positive(),
        uptimeMs: z.number().positive(),
        rssSamples: z
          .array(
            z.object({
              atMs: z.number().nonnegative(),
              rss: z.number().positive(),
            }),
          )
          .min(1)
          .max(32),
      })
      .parse(
        JSON.parse(
          await readFile(join(directory, "watchdog-exit.json"), "utf8"),
        ),
      );
    expect(
      Math.max(...evidence.rssSamples.map((sample) => sample.rss)),
    ).toBeGreaterThan(limit);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(area, { recursive: true, force: true });
  }
}, 20_000);

test("a live service outlasts the stall bound and SIGTERM drains normally without a false incident", async () => {
  await withService(async ({ child, record }, directory) => {
    await Bun.sleep(750);
    expect(child.exitCode).toBeNull();
    const status = await fetch(
      `${record.baseUrl}/service/${record.serviceId}/status`,
    );
    expect(status.status).toBe(200);
    await status.body?.cancel();
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    expect((await readdir(directory)).includes("watchdog-exit.json")).toBe(
      false,
    );
  });
}, 20_000);

test("failed evidence writes stay typed and cannot strand a stalled service", async () => {
  await withService(async (service, directory) => {
    await mkdir(join(directory, "watchdog-stream.jsonl"));
    await stall(service);
    const evidence = z
      .object({
        reason: z.literal("event-loop-stall"),
        capture: z.object({
          state: z.literal("failed"),
          code: z.literal("capture-write-failed"),
        }),
      })
      .parse(
        JSON.parse(
          await readFile(join(directory, "watchdog-exit.json"), "utf8"),
        ),
      );
    expect(evidence.capture.state).toBe("failed");
  });
}, 20_000);

test("the built service worker preserves host autoload protection and the service PID", async () => {
  const area = await mkdtemp(join(tmpdir(), "fungi-watchdog-built-"));
  const directory = join(area, "service");
  const project = join(area, "project");
  await mkdir(directory, { mode: 0o700 });
  await mkdir(project);
  const marker = join(project, "preload-ran");
  await writeFile(
    join(project, "evil.cjs"),
    `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`,
  );
  await writeFile(join(project, "bunfig.toml"), 'preload = ["./evil.cjs"]\n');
  await writeFile(
    join(project, ".env"),
    `FUNGI_BUNDLED_BUILD_ID=${"a".repeat(64)}\n`,
  );
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: area };
  delete env.FUNGI_BUNDLED_BUILD_ID;
  const child = spawn(
    [
      process.execPath,
      "--config=/dev/null",
      "--no-env-file",
      new URL("../dist/private-local-service-process.js", import.meta.url)
        .pathname,
      directory,
    ],
    {
      cwd: project,
      env,
      stdout: "ignore",
      stderr: "inherit",
    },
  );
  try {
    let record;
    for (let attempt = 0; attempt < 400; attempt++) {
      record = await readServiceRecord(directory);
      if (record !== undefined) break;
      if (child.exitCode !== null)
        throw new Error(
          `Built service exited before ready (${String(child.exitCode)})`,
        );
      await Bun.sleep(25);
    }
    if (record === undefined) throw new Error("Built service did not start");
    expect(record.pid).toBe(child.pid);
    expect(record.version).toBe("source");
    expect((await readdir(project)).includes("preload-ran")).toBe(false);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(area, { recursive: true, force: true });
  }
}, 20_000);

test.skipIf(process.platform !== "linux")(
  "a six-second fsync cannot hold exit past the independent evidence deadline",
  async () => {
    const area = await mkdtemp(join(tmpdir(), "fungi-watchdog-slow-fsync-"));
    try {
      const library = join(area, "slow-fsync.so");
      const compiler = spawn(
        [
          "cc",
          "-shared",
          "-fPIC",
          new URL("./fixtures/watchdog-slow-fsync.c", import.meta.url).pathname,
          "-o",
          library,
          "-ldl",
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const diagnostics = await new Response(compiler.stderr).text();
      expect({ code: await compiler.exited, diagnostics }).toEqual({
        code: 0,
        diagnostics: "",
      });
      await withService(
        async (service, directory) => {
          await stall(service);
          // This marker is written by the preload before its real six-second sleep.
          // A green exit must not merely mean fault injection never ran.
          expect(
            await readFile(
              join(directory, "watchdog-exit.json.fsync-started"),
              "utf8",
            ),
          ).toBe("fsync delayed\n");
          const evidence = z
            .object({
              reason: z.string(),
              captureBudgetMs: z.number(),
              capture: z.object({ state: z.string() }),
            })
            .parse(
              JSON.parse(
                await readFile(join(directory, "watchdog-exit.json"), "utf8"),
              ),
            );
          expect(evidence).toMatchObject({
            reason: "event-loop-stall",
            captureBudgetMs: 200,
            capture: { state: "pending" },
          });
        },
        { LD_PRELOAD: library },
      );
    } finally {
      await rm(area, { recursive: true, force: true });
    }
  },
  20_000,
);
