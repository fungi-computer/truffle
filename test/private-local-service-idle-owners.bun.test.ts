import { expect, it } from "bun:test";
import { spawn, type Subprocess } from "bun";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  watch,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

import { capturePrivateLocalExecPath } from "../src/private-local-exec-path.js";
import {
  readServiceRecord,
  selectedSchema,
  serviceDirectory,
} from "../src/private-local-service-discovery.js";

const fixture = join(import.meta.dir, "fixtures", "idle-owners-service.ts");
const agentsPerRound = 16;

/** What a released Agent may still retain, measured per distinct Agent. */
const retainedObjectsPerAgent = 16;
const retainedHeapBytesPerAgent = 32_768;
const heapSchema = z.object({
  objectCount: z.number().int().nonnegative(),
  heapSize: z.number().int().nonnegative(),
});

/** Read-only: this service's open Agent-store files. */
async function measure(pid: number, project: string) {
  let stores = 0;
  for (const fd of await readdir(`/proc/${String(pid)}/fd`)) {
    let target: string;
    try {
      target = await readlink(`/proc/${String(pid)}/fd/${fd}`);
    } catch (cause) {
      // The fd closed between listing and reading it.
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        continue;
      throw cause;
    }
    if (target.startsWith(project) && target.includes(".sqlite")) stores += 1;
  }
  return { stores };
}

it.skipIf(process.platform !== "linux")(
  "a real service releases N distinct idle Agents, keeps fds and retained objects bounded, and a restart reopens none",
  async () => {
    const clientPath = capturePrivateLocalExecPath(
      process.env.PATH ?? "",
      process.cwd(),
    );
    const home = await mkdtemp(join(tmpdir(), "fungi-idle-owners-"));
    const directory = await serviceDirectory(join(home, ".fungi", "service"));
    const project = join(home, "project");
    await mkdir(project);
    const children: Subprocess[] = [];
    let collected:
      PromiseWithResolvers<z.output<typeof heapSchema>> | undefined;
    const start = async (sweepMs: number) => {
      const child = spawn(
        [process.execPath, fixture, directory, String(sweepMs)],
        {
          cwd: home,
          env: { PATH: process.env.PATH, HOME: home },
          stdout: "inherit",
          stderr: "inherit",
          ipc: (message) => {
            collected?.resolve(heapSchema.parse(message));
          },
        },
      );
      children.push(child);
      for (let attempt = 0; attempt < 400; attempt += 1) {
        const record = await readServiceRecord(directory);
        if (record?.pid === child.pid) return { child, record };
        await Bun.sleep(25);
      }
      throw new Error("The idle-owner service did not start");
    };
    /** Collect garbage in the owned child, then read its fds and retained heap. */
    const sample = async (child: Subprocess, pid: number) => {
      collected = Promise.withResolvers<z.output<typeof heapSchema>>();
      child.send("collect");
      return { ...(await collected.promise), ...(await measure(pid, project)) };
    };
    const listed = async () =>
      z
        .array(z.object({ databasePath: z.string() }))
        .parse(
          JSON.parse(await readFile(join(directory, "owners.json"), "utf8")),
        ).length;
    // The service's own sweep is the producer: wake on each owners.json write.
    const untilNoneListed = async () => {
      const stop = new AbortController();
      const writes = watch(directory, { signal: stop.signal })[
        Symbol.asyncIterator
      ]();
      try {
        while ((await listed()) > 0) await writes.next();
      } finally {
        stop.abort();
      }
    };
    let round = 0;
    const openRound = async (baseUrl: string) => {
      round += 1;
      for (let index = 0; index < agentsPerRound; index += 1) {
        const store = join(project, `round-${String(round)}-${String(index)}`);
        await mkdir(store);
        const databasePath = join(store, "agent.sqlite");
        new DatabaseSync(databasePath).close();
        const response = await fetch(`${baseUrl}/select`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            invocationRoot: project,
            databasePath,
            clientPath,
          }),
        });
        expect(response.status).toBe(200);
        const selected = selectedSchema.parse(await response.json());
        // A real Session write through the mounted route, then the client
        // leaves: it detaches its private route, as a UI does when it closes.
        const titled = await fetch(
          `${baseUrl}${selected.routePath}/sessions/${selected.sessionId}/command`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              command: { type: "title", title: `round ${String(round)}` },
            }),
          },
        );
        expect(titled.ok).toBe(true);
        await titled.body?.cancel();
        const detached = await fetch(`${baseUrl}${selected.routePath}/`, {
          method: "DELETE",
        });
        expect(detached.status).toBe(204);
      }
    };
    try {
      // Without a sweep, shutdown alone must forget idle Agents.
      const first = await start(3_600_000);
      const firstBase = `${first.record.baseUrl}/service/${first.record.serviceId}`;
      await openRound(firstBase);
      expect((await measure(first.record.pid, project)).stores).toBe(
        3 * agentsPerRound,
      );
      first.child.kill("SIGTERM");
      expect(await first.child.exited).toBe(0);

      // The restarted service opens no idle Agent and lists none.
      const second = await start(20);
      const secondBase = `${second.record.baseUrl}/service/${second.record.serviceId}`;
      expect((await measure(second.record.pid, project)).stores).toBe(0);
      expect(await listed()).toBe(0);

      // Live: each round of distinct Agents is released once idle, so fds
      // return to a bound and retained objects stop growing with the Agents
      // ever opened.
      const released: Awaited<ReturnType<typeof sample>>[] = [];
      for (let pass = 0; pass < 8; pass += 1) {
        await openRound(secondBase);
        await untilNoneListed();
        released.push(await sample(second.child, second.record.pid));
      }
      // JSC scans the stack conservatively, so a collection may still miss
      // the last released Agent's connection; it never grows per round.
      for (const { stores } of released) expect(stores).toBeLessThanOrEqual(3);
      // The first rounds warm the service. After them, the rounds that follow
      // open distinct Agents that must not stay reachable once released. A
      // conservative stack scan can pin a transient burst in a single sample,
      // so compare the smallest of the last three samples with the warmed one.
      const warmed = released[3];
      const settled = released.slice(-3);
      if (warmed === undefined || settled.length < 3)
        throw new Error("Missing samples");
      const laterAgents = (released.length - 3 - 3) * agentsPerRound;
      expect(
        Math.min(...settled.map((sample) => sample.objectCount)) -
          warmed.objectCount,
      ).toBeLessThanOrEqual(retainedObjectsPerAgent * laterAgents);
      expect(
        Math.min(...settled.map((sample) => sample.heapSize)) - warmed.heapSize,
      ).toBeLessThanOrEqual(retainedHeapBytesPerAgent * laterAgents);
      second.child.kill("SIGTERM");
      expect(await second.child.exited).toBe(0);
    } finally {
      for (const child of children)
        if (child.exitCode === null) {
          child.kill();
          await child.exited;
        }
      await rm(home, { recursive: true, force: true });
    }
  },
  60_000,
);
