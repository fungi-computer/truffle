import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { serve } from "bun";

import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import { readServiceRegistration } from "../src/private-local-service-discovery.js";

// A real Local service in a throwaway directory, stopped and started again:
// the second one has a new id and port, as it does after `fungi stop`.
async function withProject(
  run: (
    project: string,
    manager: ReturnType<typeof createPrivateLocalServiceManager>,
    directory: string,
  ) => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "fungi-rebind-")));
  const project = join(root, "project");
  await mkdir(project);
  const manager = createPrivateLocalServiceManager({
    directory: join(root, "service"),
  });
  try {
    await run(project, manager, join(root, "service"));
  } finally {
    try {
      await manager.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}

describe("a Local service connection across a service restart", () => {
  it("times out a hung selection after a healthy probe and permits the next attempt", async () => {
    await withProject(async (project, manager, directory) => {
      const connection = await manager.connect({ invocationRoot: project });
      const original = connection.service;
      const registration = await readServiceRegistration(directory);
      if (registration?.kind !== "current")
        throw new Error(
          "Fixture service did not publish a current registration",
        );
      let hangSelection = true;
      let selections = 0;
      const lifetime = new AbortController();
      const hung = Promise.withResolvers<Response>();
      const proxy = serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request): Response | Promise<Response> {
          const path = new URL(request.url).pathname;
          if (path.endsWith("/status"))
            return Response.json({ ...original, baseUrl: proxy.url.origin });
          if (path.endsWith("/select")) {
            selections += 1;
            if (hangSelection) return hung.promise;
          }
          return fetch(new URL(path, original.baseUrl), request);
        },
      });
      try {
        await writeFile(
          join(directory, "service.json"),
          JSON.stringify({
            ...registration.record,
            baseUrl: proxy.url.origin,
          }),
        );
        const began = Date.now();
        await assert.rejects(
          connection.rebind({ signal: lifetime.signal }),
          /timeout|aborted/iu,
        );
        expect(Date.now() - began).toBeLessThan(10_000);
        expect(lifetime.signal.aborted).toBe(false);
        expect(selections).toBe(1);
        hangSelection = false;
        expect(
          (await connection.rebind({ signal: lifetime.signal })).kind,
        ).toBe("rebound");
        expect(selections).toBe(2);
        await connection.session.read();
      } finally {
        hung.resolve(new Response(null, { status: 503 }));
        await writeFile(
          join(directory, "service.json"),
          JSON.stringify(registration.record),
        );
        await connection.close();
        await proxy.stop(true);
      }
    });
  }, 40_000);

  it("keeps the same Session handle working on the restarted service", async () => {
    await withProject(async (project, manager) => {
      const connection = await manager.connect({ invocationRoot: project });
      const firstService = connection.service;
      const before = await connection.session.read();
      await manager.stop();
      await assert.rejects(connection.session.read());
      const second = await manager.start();
      expect(second.serviceId).not.toBe(firstService.serviceId);

      const outcome = await connection.rebind();

      expect(outcome).toEqual({ kind: "rebound", service: second });
      expect(connection.service).toEqual(second);
      expect(connection.service.baseUrl).not.toBe(firstService.baseUrl);
      expect(await connection.session.read()).toEqual(before);
      const watch = await connection.session.watch();
      try {
        expect(watch.snapshot.messages).toEqual(before.messages);
      } finally {
        await watch.close();
      }
      await connection.close();
    });
  }, 40_000);

  it("reports unavailable without starting a service while none runs", async () => {
    await withProject(async (project, manager) => {
      const connection = await manager.connect({ invocationRoot: project });
      await manager.stop();

      expect(await connection.rebind()).toEqual({ kind: "unavailable" });
      expect(await manager.status()).toBeUndefined();
      await connection.close();
    });
  }, 40_000);
});
