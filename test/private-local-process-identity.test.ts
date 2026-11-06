import fs from "node:fs/promises";
import { writeFileSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  identifyLocalServiceProcess,
  readProcessStart,
} from "../src/private-local-process-identity.js";
import { terminatePrivateLocalService } from "../src/private-local-service-termination.js";

const service = { pid: 12345, startedAt: "linux:42" };
// proc(5): field 3 through field 21 precede starttime (field 22).
const runningStat = `12345 (fixture service) ${Array<string>(19).fill("0").join(" ")} 42`;

describe.skipIf(process.platform === "win32")(
  "macOS service argv corroboration",
  () => {
    const children: ChildProcess[] = [];
    afterEach(() => {
      Object.defineProperty(process, "platform", {
        configurable: true,
        value: actualPlatform,
      });
      for (const child of children.splice(0)) child.kill("SIGKILL");
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    const actualPlatform = process.platform;

    it.each(["", "[fixture-service] <defunct>", "[fixture-service]"])(
      "finishes stop without another signal when argv becomes %j after SIGTERM",
      async (exitingArgv) => {
        const directory = await fs.mkdtemp(join(tmpdir(), "fungi-stop-argv-"));
        try {
          // Keep native ps execution and the real lease reader. Only process
          // existence/signals and ps output are controlled; no real PID is used.
          const database = new DatabaseSync(join(directory, "owner.sqlite"));
          try {
            database.exec(
              "CREATE TABLE service_owner (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, startedAt TEXT NOT NULL)",
            );
            database
              .prepare("INSERT INTO service_owner VALUES (1, ?, ?)")
              .run(service.pid, service.startedAt);
          } finally {
            database.close();
          }
          const output = join(directory, "ps.output");
          await fs.writeFile(
            output,
            `fixture --internal-service ${directory}\n`,
          );
          await fs.writeFile(
            join(directory, "ps"),
            '#!/bin/sh\nexec /bin/cat "$0.output"\n',
            { mode: 0o700 },
          );
          vi.stubEnv("PATH", directory);
          Object.defineProperty(process, "platform", {
            configurable: true,
            value: "darwin",
          });
          let exitPolls: number | undefined;
          let observedGone = false;
          const signal = vi
            .spyOn(process, "kill")
            .mockImplementation((pid, value) => {
              expect(pid).toBe(service.pid);
              if (value === "SIGTERM") {
                writeFileSync(output, exitingArgv);
                exitPolls = 0;
              } else if (value !== 0) {
                throw new Error("Unexpected terminating signal");
              } else if (exitPolls !== undefined) {
                // The first exit poll sees a live PID with disappearing argv;
                // only the next poll observes reaping. No scheduling race needed.
                exitPolls += 1;
                if (exitPolls > 1) {
                  observedGone = true;
                  throw Object.assign(new Error("process reaped"), {
                    code: "ESRCH",
                  });
                }
              }
              return true;
            });
          await expect(
            terminatePrivateLocalService(directory, service),
          ).resolves.toBe("stopped");
          expect(observedGone).toBe(true);
          expect(signal.mock.calls.filter(([, value]) => value !== 0)).toEqual([
            [service.pid, "SIGTERM"],
          ]);
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      },
    );

    it("identifies only a process started for this service directory", async () => {
      const directory = await fs.mkdtemp(join(tmpdir(), "fungi-argv-"));
      try {
        const child = spawn(
          process.execPath,
          [
            "-e",
            "setInterval(() => {}, 10_000)",
            "--",
            "--internal-service",
            directory,
          ],
          { stdio: "ignore" },
        );
        children.push(child);
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        if (child.pid === undefined)
          throw new Error("spawned service has no pid");
        Object.defineProperty(process, "platform", {
          configurable: true,
          value: "darwin",
        });
        const claim = { pid: child.pid, startedAt: "unverifiable", directory };
        await expect(identifyLocalServiceProcess(claim)).resolves.toEqual({
          kind: "ours",
          evidence: "command-line",
        });
        await expect(
          identifyLocalServiceProcess({
            ...claim,
            directory: `${directory}-foreign`,
          }),
        ).resolves.toEqual({ kind: "other" });
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });
  },
);

describe.skipIf(process.platform !== "linux")(
  "Linux process disappearance",
  () => {
    let directory: string;
    beforeEach(async () => {
      directory = await fs.mkdtemp(join(tmpdir(), "fungi-process-identity-"));
      // Use the real lease reader and an owned database. Only native stat reads
      // and signals are faked; no module or production interface is replaced.
      const database = new DatabaseSync(join(directory, "owner.sqlite"));
      try {
        database.exec(
          "CREATE TABLE service_owner (id INTEGER PRIMARY KEY CHECK (id = 1), pid INTEGER NOT NULL, startedAt TEXT NOT NULL)",
        );
        database
          .prepare("INSERT INTO service_owner VALUES (1, ?, ?)")
          .run(service.pid, service.startedAt);
      } finally {
        database.close();
      }
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      syncBuiltinESMExports();
      await fs.rm(directory, { recursive: true, force: true });
    });

    it.each(["ENOENT", "ESRCH"])(
      "maps a %s stat read to typed gone",
      async (code) => {
        const readStat = vi
          .spyOn(fs, "readFile")
          .mockRejectedValueOnce(
            Object.assign(new Error("process disappeared"), { code }),
          );
        syncBuiltinESMExports();
        await expect(readProcessStart(service.pid)).resolves.toEqual({
          kind: "gone",
        });
        expect(readStat).toHaveBeenCalledWith("/proc/12345/stat", "utf8");
      },
    );

    it.each(["ENOENT", "ESRCH"])(
      "finishes termination when the process disappears with %s after SIGTERM",
      async (code) => {
        const readStat = vi
          .spyOn(fs, "readFile")
          .mockResolvedValueOnce(runningStat)
          .mockResolvedValueOnce(runningStat)
          .mockRejectedValueOnce(
            Object.assign(new Error("process disappeared during exit poll"), {
              code,
            }),
          );
        const signal = vi.spyOn(process, "kill").mockReturnValue(true);
        syncBuiltinESMExports();

        await expect(
          terminatePrivateLocalService(directory, service),
        ).resolves.toBe("stopped");
        expect(readStat).toHaveBeenCalledTimes(3);
        expect(signal.mock.calls).toEqual([[service.pid, "SIGTERM"]]);
      },
    );

    it.each(["EACCES", "EIO", "EPERM"])(
      "propagates %s from the exit poll rather than claiming the process exited",
      async (code) => {
        const failure = Object.assign(new Error("stat read failed"), { code });
        vi.spyOn(fs, "readFile")
          .mockResolvedValueOnce(runningStat)
          .mockResolvedValueOnce(runningStat)
          .mockRejectedValueOnce(failure);
        const signal = vi.spyOn(process, "kill").mockReturnValue(true);
        syncBuiltinESMExports();

        await expect(
          terminatePrivateLocalService(directory, service),
        ).rejects.toBe(failure);
        expect(signal.mock.calls).toEqual([[service.pid, "SIGTERM"]]);
      },
    );

    it("does not signal a PID whose start discriminator changed", async () => {
      vi.spyOn(fs, "readFile").mockResolvedValue(
        runningStat.replace(/42$/u, "41"),
      );
      const signal = vi.spyOn(process, "kill").mockReturnValue(true);
      syncBuiltinESMExports();

      await expect(
        terminatePrivateLocalService(directory, service),
      ).resolves.toBe("stopped");
      expect(signal).not.toHaveBeenCalled();
    });
  },
);
