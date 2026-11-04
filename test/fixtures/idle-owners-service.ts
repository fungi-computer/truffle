// The real Local service and real Agent runtimes in a disposable HOME. The
// test reads this process's fds from /proc and, after forced collections, how
// many Agent store statements the heap still holds. Each open Agent store
// keeps prepared bun:sqlite statements (SQLStatement); a released Agent that
// stays reachable keeps them, so the count names retained Agents. Total heap
// objects do not: they swing by thousands between samples with JIT tiering
// and conservative stack scans while no Agent is retained.
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
  // report the smallest of three consecutive collections.
  const counts: number[] = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    Bun.gc(true);
    counts.push(heapStats().objectTypeCounts.SQLStatement ?? 0);
  }
  process.send?.({ statements: Math.min(...counts) });
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
