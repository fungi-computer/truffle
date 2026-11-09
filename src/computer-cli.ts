#!/usr/bin/env node
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  attachPrivateLocalComputer,
  runPrivateLocalComputer,
} from "./private-local-computer-attach.js";

// The CLI receives credentials through stdin, never argv or diagnostic output.
const attachment = z.strictObject({
  endpoint: z.url(),
  computer: z.string().min(1),
  computerId: z.string().min(1),
  folderPath: z.string().min(1),
  credentialPath: z.string().min(1),
  ownerKey: z.string().min(1),
});

async function main() {
  const { positionals } = parseArgs({ allowPositionals: true, strict: true });
  if (positionals.length !== 1 || positionals[0] !== "attach")
    throw new Error("Usage: fungi-local-computer attach < attachment.json");
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    process.stdin.setEncoding("utf8");
    let text = "";
    for await (const chunk of process.stdin) {
      text += String(chunk);
      if (text.length > 64 * 1024)
        throw new Error("Attachment input too large");
    }
    const input = attachment.parse(JSON.parse(text));
    controller.signal.throwIfAborted();
    const attached = await attachPrivateLocalComputer(
      input.endpoint,
      {
        computer: input.computer,
        computerId: input.computerId,
        folderPath: input.folderPath,
      },
      { credentialPath: input.credentialPath, ownerKey: input.ownerKey },
    );
    if (attached.kind !== "attached") throw new Error("Attachment refused");
    controller.signal.throwIfAborted();
    await runPrivateLocalComputer(input.endpoint, attached.computerId, {
      credentialPath: input.credentialPath,
      signal: controller.signal,
      onStatus(status) {
        if (status.kind === "online")
          process.stdout.write('{"kind":"online"}\n');
      },
    });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

if (import.meta.main) {
  main().catch((cause: unknown) => {
    process.stdout.write('{"kind":"no_runtime"}\n');
    process.exitCode =
      cause instanceof SyntaxError || cause instanceof z.ZodError ? 2 : 1;
  });
}
