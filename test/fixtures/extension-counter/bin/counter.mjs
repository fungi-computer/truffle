#!/usr/bin/env bun
// An independent terminal program: it draws its own count and serves one
// JSON request per connection on its project's private runtime socket.
import { createServer } from "node:net";
import process from "node:process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const directory = process.env.FUNGI_EXTENSION_RUNTIME_DIR;
if (directory === undefined) {
  process.stderr.write("FUNGI_EXTENSION_RUNTIME_DIR is required\n");
  process.exit(2);
}
const socket = join(directory, "counter.sock");
let count = 0;
const draw = () => {
  process.stdout.write(`\x1b[2J\x1b[Hcount: ${String(count)}\n`);
};
rmSync(socket, { force: true });
const server = createServer((connection) => {
  let request = "";
  connection.setEncoding("utf8");
  connection.on("data", (chunk) => {
    request += chunk;
    if (!request.includes("\n")) return;
    const { op } = JSON.parse(request);
    if (op === "increment") {
      count += 1;
      draw();
    }
    connection.end(`${JSON.stringify({ count })}\n`);
  });
});
const stop = () => {
  server.close();
  rmSync(socket, { force: true });
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGHUP", stop);
process.on("SIGINT", stop);
server.listen(socket, draw);
