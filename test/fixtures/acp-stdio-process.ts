import { writeFileSync } from "node:fs";
import { z } from "zod";
import { runPrivateLocalAcpStdio } from "../../src/private-local-acp-stdio.js";

// A real `fungi acp` stand-in over this process's real stdin and stdout. It
// notes the latest service route a selection or Session creation mounts, so a
// test can probe that route after the editor leaves.
const [serviceDirectory, invocationRoot, routeFile] = process.argv.slice(2);
if (
  serviceDirectory === undefined ||
  invocationRoot === undefined ||
  routeFile === undefined
)
  throw new Error("Missing ACP fixture arguments");
const mounted = z.object({ routePath: z.string() });
const transport = globalThis.fetch;
globalThis.fetch = Object.assign(
  async (target: string | URL | Request, init?: RequestInit) => {
    const response = await transport(target, init);
    const address = String(target instanceof Request ? target.url : target);
    const service = /^.*\/service\/[^/]+(?=\/(?:sessions|select)$)/u.exec(
      address,
    );
    if (service !== null && response.ok) {
      const route = mounted.safeParse(await response.clone().json());
      if (route.success)
        writeFileSync(routeFile, service[0] + route.data.routePath);
    }
    return response;
  },
  { preconnect: transport.preconnect },
);
await runPrivateLocalAcpStdio({ serviceDirectory, invocationRoot });
