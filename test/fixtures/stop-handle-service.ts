// The real Local service listener in its own process, with a Miniflare alive
// the way a sandboxed command keeps one while it runs, then stopped in one of
// two ways, and then failing on purpose. A stop through the service's own
// handle drains and lets the failure print; a process-wide SIGTERM reaches
// Miniflare's exit hook, which ends the process with 143 and hides it.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { z } from "zod";
import {
  runPrivateLocalService,
  stopPrivateLocalService,
} from "../../src/private-local-service-listener.js";
import { serviceDirectory } from "../../src/private-local-service-discovery.js";

const [directory, mode] = z
  .tuple([z.string().min(1), z.enum(["handle", "signal"])])
  .parse(process.argv.slice(2));

const service = await serviceDirectory(directory);
const sandbox = new Miniflare(
  convertV4MiniflareOptions({
    modules: [
      {
        type: "ESModule",
        path: "worker.mjs",
        contents: "export default { fetch: () => new Response('ok') };",
      },
    ],
    compatibilityDate: "2026-09-02",
    cf: false,
  }),
);
await sandbox.ready;
let ready: () => void = () => undefined;
const listening = new Promise<void>((resolve) => {
  ready = resolve;
});
const running = runPrivateLocalService(
  service,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  () => {
    ready();
  },
);
await listening;
if (mode === "handle") stopPrivateLocalService(service);
else process.emit("SIGTERM", "SIGTERM");
await running;
await sandbox.dispose();
throw new Error("deliberate fixture failure");
