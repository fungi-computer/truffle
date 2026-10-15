import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { runPrivateLocalWorkerServer } from "../src/private-local-worker-server.js";

describe("private Local static worker server", () => {
  it("stays alive until a signal and closes its retained batch once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "fungi-worker-server-"));
    await writeFile(
      join(directory, "workers.json"),
      JSON.stringify([
        {
          name: "alpha",
          owner: {
            invocationRoot: "./alpha",
            databasePath: "./alpha.sqlite",
            fungiMcp: {
              endpoint: "https://hub.test/api/teams/selected/mcp",
            },
          },
        },
      ]),
    );
    const signals = new EventEmitter();
    const output: string[] = [];
    const ready = Promise.withResolvers<undefined>();
    let closes = 0;
    const running = runPrivateLocalWorkerServer(
      "workers.json",
      "http://127.0.0.1:43123",
      {
        cwd: directory,
        stdout: {
          write(chunk) {
            output.push(String(chunk));
            ready.resolve(undefined);
            return true;
          },
        },
        signals,
      },
      (workers, listen) => {
        expect(workers).toHaveLength(1);
        expect(workers[0]?.name).toBe("alpha");
        expect(workers[0]?.owner.invocationRoot).toBe(join(directory, "alpha"));
        expect(workers[0]?.owner.databasePath).toBe("./alpha.sqlite");
        expect(listen).toBe("http://127.0.0.1:43123");
        expect(workers[0]?.owner.fungiMcp?.endpoint.href).toBe(
          "https://hub.test/api/teams/selected/mcp",
        );
        expect(workers[0]?.owner.fungiMcp?.authProvider).toBeDefined();
        return Promise.resolve({
          baseUrl: listen,
          workers: [
            {
              name: "alpha",
              routePath: "/workers/alpha",
              databasePath: "/tmp/alpha.sqlite",
            },
          ],
          close: () => {
            closes += 1;
            return Promise.resolve();
          },
        });
      },
    );

    await Promise.race([ready.promise, running]);
    expect(output.join("")).toContain('"status":"ready"');
    expect(output.join("")).not.toContain("worker-credential");
    expect(output.join("")).not.toContain("hub.test");
    expect(closes).toBe(0);
    signals.emit("SIGINT");
    signals.emit("SIGTERM");
    await running;
    expect(closes).toBe(1);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });
  it("retains output and close causes, reports their stages, and releases signal listeners", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "fungi-worker-server-failure-"),
    );
    const outputFailure = new Error("private output data");
    const closeFailure = new Error("private close data");
    const signals = new EventEmitter();
    const report = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await writeFile(
        join(directory, "workers.json"),
        JSON.stringify([
          { name: "alpha", owner: { invocationRoot: "./alpha" } },
        ]),
      );
      await expect(
        runPrivateLocalWorkerServer(
          "workers.json",
          "http://127.0.0.1:43123",
          {
            cwd: directory,
            signals,
            stdout: {
              write() {
                throw outputFailure;
              },
            },
          },
          () =>
            Promise.resolve({
              baseUrl: "http://127.0.0.1:43123",
              workers: [],
              close: () => Promise.reject(closeFailure),
            }),
        ),
      ).rejects.toMatchObject({
        name: "AggregateError",
        errors: [outputFailure, closeFailure],
      });
      expect(report).toHaveBeenCalledWith(
        JSON.stringify({
          source: "local-runtime",
          operation: "worker-server.ready-output",
          failureKind: "Error",
        }),
        expect.anything(),
      );
      expect(report).toHaveBeenCalledWith(
        JSON.stringify({
          source: "local-runtime",
          operation: "worker-server.close",
          failureKind: "Error",
        }),
        expect.anything(),
      );
      expect(JSON.stringify(report.mock.calls)).not.toContain("private");
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      report.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("propagates an opening failure with its original cause and reports no request data", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "fungi-worker-server-open-failure-"),
    );
    const failure = new Error("private startup data");
    const signals = new EventEmitter();
    const report = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    try {
      await writeFile(
        join(directory, "workers.json"),
        JSON.stringify([
          { name: "alpha", owner: { invocationRoot: "./alpha" } },
        ]),
      );
      await expect(
        runPrivateLocalWorkerServer(
          "workers.json",
          "http://127.0.0.1:43123",
          { cwd: directory, signals },
          () => Promise.reject(failure),
        ),
      ).rejects.toBe(failure);
      expect(report).toHaveBeenCalledWith(
        JSON.stringify({
          source: "local-runtime",
          operation: "worker-server.opening",
          failureKind: "Error",
        }),
        expect.anything(),
      );
      expect(JSON.stringify(report.mock.calls)).not.toContain(
        "private startup data",
      );
      expect(signals.listenerCount("SIGINT")).toBe(0);
      expect(signals.listenerCount("SIGTERM")).toBe(0);
    } finally {
      report.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
