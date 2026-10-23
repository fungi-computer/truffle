// Isolate the filesystem barrier in this owned child, never in the test runner.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { runPrivateLocalService } from "../../src/private-local-service-listener.js";
import { openPrivateLocalRuntimeHost } from "../../src/private-local-runtime-host.js";

const [directory, clientStore, mode] = z
  .tuple([
    z.string(),
    z.string(),
    z.enum(["held", "eio", "invalid-json", "non-array"]),
  ])
  .parse(process.argv.slice(2));
const releaseRead = Promise.withResolvers<undefined>();
const holdReopens = Promise.withResolvers<undefined>();
process.on("message", (message) => {
  z.literal("release-read").parse(message);
  releaseRead.resolve(undefined);
});
await runPrivateLocalService(
  directory,
  async (options) => {
    // No restore write from opening A or B can mask C's first persisted list.
    if (options.databasePath !== clientStore) await holdReopens.promise;
    const runtime = await openPrivateLocalRuntimeHost(options);
    // Report after the returned owner's promise continuations have run: on the
    // red implementation C's recovery write has already captured its payload.
    setImmediate(() => process.send?.("client-opened"));
    return runtime;
  },
  undefined,
  undefined,
  undefined,
  async (path) => {
    const content = await readFile(path, "utf8");
    process.send?.("read-held");
    await releaseRead.promise;
    if (mode === "eio")
      throw Object.assign(new Error("Owned manifest read failure"), {
        code: "EIO",
      });
    return content;
  },
);
process.disconnect();
