import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { z } from "zod";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import { createPrivateLocalServiceManager } from "../src/private-local-service.js";
import { localServiceIds } from "../src/private-local-service-ids.js";
import { readOwnProcessStart } from "../src/private-local-process-identity.js";
import {
  privateLocalServiceProtocol,
  type ServiceRecord,
} from "../src/private-local-service-discovery.js";

// Real HTTP and discovery files; only the status responder is a fake service.
// This proves client lookup, not service runtime/reload or child startup.
async function statusResponder(directory: string) {
  const serviceId = localServiceIds.service.generate();
  const startedAt = await readOwnProcessStart();
  const server = createServer((request, response) => {
    if (request.url !== `/service/${serviceId}/status`) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({ ...record, diagnostics: { state: "active" } }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = z.object({ port: z.number() }).parse(server.address());
  const record: ServiceRecord = {
    serviceId,
    startedAt,
    pid: process.pid,
    version: "source",
    protocol: privateLocalServiceProtocol,
    baseUrl: `http://127.0.0.1:${String(port)}`,
  };
  const close = () =>
    new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve();
        else reject(error);
      });
    });
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "service.json"), JSON.stringify(record));
    return { record, close };
  } catch (cause) {
    await close();
    throw cause;
  }
}

it("keeps the manager's selected service directory A when ambient HOME changes to B", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "fungi-root-discovery-"));
  const previousHome = process.env.HOME;
  const a = capturePrivateLocalConfigRoot(join(temporary, "a"));
  const b = capturePrivateLocalConfigRoot(join(temporary, "b"));
  const responders: Awaited<ReturnType<typeof statusResponder>>[] = [];
  try {
    const first = await statusResponder(a.serviceDirectory);
    responders.push(first);
    responders.push(await statusResponder(b.serviceDirectory));
    process.env.HOME = a.home;
    const manager = createPrivateLocalServiceManager();
    process.env.HOME = b.home;
    expect((await manager.status())?.serviceId).toBe(first.record.serviceId);
    // Explicit selected home must also work when construction occurs under B.
    const injected = createPrivateLocalServiceManager({ home: a.home });
    expect((await injected.status())?.serviceId).toBe(first.record.serviceId);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    try {
      await Promise.all(responders.map((responder) => responder.close()));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
