// The real Local service and real Agent runtimes in a disposable HOME. The
// test reads this process's fds from /proc and its retained JS heap counts.
// Bun's node:sqlite keeps a closed connection's file until its statements are
// collected, so the test-owned child collects on request before a sample.
import { heapStats } from "bun:jsc";
import { z } from "zod";
import { runPrivateLocalService } from "../../src/private-local-service-listener.js";
import { serviceDirectory } from "../../src/private-local-service-discovery.js";

const [directory, sweepMs] = z
  .tuple([z.string().min(1), z.coerce.number().int().positive()])
  .parse(process.argv.slice(2));

process.on("message", (message) => {
  z.literal("collect").parse(message);
  // A collection can miss an object a conservative stack scan still sees, so
  // report the smallest of three consecutive collections: retained counts,
  // unlike RSS, do not depend on the allocator or the host's load.
  const readings: { objectCount: number; heapSize: number }[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    Bun.gc(true);
    const { objectCount, heapSize } = heapStats();
    readings.push({ objectCount, heapSize });
  }
  process.send?.({
    objectCount: Math.min(...readings.map((reading) => reading.objectCount)),
    heapSize: Math.min(...readings.map((reading) => reading.heapSize)),
  });
});

await runPrivateLocalService(
  await serviceDirectory(directory),
  undefined,
  undefined,
  undefined,
  sweepMs,
);
// Release the test-only IPC handle after the service's ordinary final drain.
if (process.connected) process.disconnect();
