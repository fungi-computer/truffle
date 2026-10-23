import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import {
  createPrivateLocalServiceManager,
  LocalServiceUpdated,
} from "../../src/private-local-service.js";
import { runPrivateLocalService } from "../../src/private-local-service-listener.js";

/** A native client holds its launch identity while its installed entry changes. */
export async function run() {
  const cli = resolve(z.string().min(1).parse(process.argv[1]));
  process.env.FUNGI_BUNDLED_CLI = cli;
  process.env.FUNGI_BUNDLED_BUILD_ID = createHash("sha256")
    .update(await readFile(cli))
    .digest("hex");
  process.env.FUNGI_LAUNCHER = join(dirname(cli), "fungi.cjs");
  if (process.argv[2] === "--internal-service") {
    await runPrivateLocalService(z.string().min(1).parse(process.argv[3]));
    return;
  }
  const [directory, ready, mode] = z
    .tuple([z.string().min(1), z.string().min(1), z.enum(["fresh", "reached"])])
    .parse(process.argv.slice(2));
  const manager = createPrivateLocalServiceManager({ directory });
  if (mode === "reached") await manager.start();
  await writeFile(ready, "client identity captured\n");
  await new Response(Bun.stdin.stream()).text();
  // Report the outcome, either way, as one JSON line for the test.
  const outcome = await manager.start().then(
    (service) => ({ kind: "started", service }),
    (cause: unknown) => ({
      kind: cause instanceof LocalServiceUpdated ? "updated" : "error",
      message: cause instanceof Error ? cause.message : "NonErrorThrown",
    }),
  );
  console.log(JSON.stringify(outcome));
}
