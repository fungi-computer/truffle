import { connect } from "node:net";
import { join } from "node:path";

/** Tools for the counter program running in this project's terminal pane. */
export default function counterHost({
  runtimeDirectory,
  defineExtension,
  Mycelium,
  z,
}) {
  const socket = join(runtimeDirectory, "counter.sock");
  const result = z.union([
    z.strictObject({ running: z.literal(true), count: z.number().int() }),
    z.strictObject({ running: z.literal(false) }),
  ]);
  const request = (op, signal) =>
    new Promise((resolve, reject) => {
      const connection = connect(socket);
      let reply = "";
      const abort = () => {
        connection.destroy();
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      connection.setEncoding("utf8");
      connection.on("connect", () => {
        connection.write(`${JSON.stringify({ op })}\n`);
      });
      connection.on("data", (chunk) => {
        reply += chunk;
      });
      connection.on("end", () => {
        signal.removeEventListener("abort", abort);
        const { count } = JSON.parse(reply);
        resolve({ running: true, count });
      });
      connection.on("error", (cause) => {
        signal.removeEventListener("abort", abort);
        if (cause.code === "ENOENT" || cause.code === "ECONNREFUSED")
          resolve({ running: false });
        else reject(cause);
      });
    });
  const operation = (op, description, replay) =>
    Mycelium.operation({
      replay,
      description,
      input: z.strictObject({}),
      output: result,
      execute: (_input, context) => request(op, context.signal),
    });
  return defineExtension({ id: "counter", version: "1.0.0" }).define({
    tools: () =>
      Mycelium.module({
        id: "fungi-counter",
        name: "counter",
        description:
          "The counter program open in this project's Counter pane. Returns {running:false} when it is not open.",
        operations: {
          increment: operation("increment", "Add one to the count.", "unsafe"),
          read: operation("read", "Read the current count.", "safe"),
        },
      }),
  });
}
