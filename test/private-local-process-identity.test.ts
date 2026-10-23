import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readProcessStart } from "../src/private-local-process-identity.js";
import { terminatePrivateLocalService } from "../src/private-local-service-termination.js";

const service = { pid: 12345, startedAt: "linux:42" };
// proc(5): field 3 through field 21 precede starttime (field 22).
const runningStat = `12345 (fixture service) ${Array<string>(19).fill("0").join(" ")} 42`;

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
