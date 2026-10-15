import * as acp from "@agentclientprotocol/sdk";
import type { ShiitakeEventSourceConstructor } from "@fungi.computer/shiitake/client";
import * as Schema from "effect/Schema";
import {
  createShiitakeAcpAgent,
  type AuthorizedShiitakeSessionDirectory,
} from "@fungi.computer/graft";
import {
  createPrivateLocalServiceManager,
  type PrivateLocalServiceConnection,
  type PrivateLocalServiceManager,
} from "./private-local-service.js";
import { createPrivateLocalSessionRequestId } from "./private-local-runtime-host.js";

export type LocalAcpStdioOptions = Readonly<{
  serviceDirectory?: string;
  invocationRoot?: string;
  databasePath?: string;
  eventSource?: ShiitakeEventSourceConstructor;
  manager?: PrivateLocalServiceManager;
  input?: ReadableStream<Uint8Array>;
  output?: WritableStream<Uint8Array>;
  name?: string;
}>;

function stdinByteStream(): ReadableStream<Uint8Array> {
  const input = process.stdin[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const chunkSchema = Schema.Union([Schema.Uint8Array, Schema.String]);
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await input.next();
        if (next.done) {
          controller.close();
        } else {
          const chunk = Schema.decodeUnknownSync(chunkSchema)(next.value);
          controller.enqueue(
            Schema.is(Schema.Uint8Array)(chunk) ? chunk : encoder.encode(chunk),
          );
        }
      } catch (cause) {
        controller.error(cause);
      }
    },
    async cancel() {
      await input.return?.();
    },
  });
}

function stdoutByteStream(): WritableStream<Uint8Array> {
  return new WritableStream({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        process.stdout.write(chunk, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    close() {
      process.stdout.end();
    },
    abort(reason) {
      process.stdout.destroy(
        reason instanceof Error
          ? reason
          : new Error("ACP stdout was aborted", { cause: reason }),
      );
    },
  });
}

function assertLocalInputs(
  additionalDirectories: readonly string[],
  mcpServers: readonly acp.McpServer[],
): void {
  if (additionalDirectories.length > 0)
    throw new Error("Local ACP does not support ACP additionalDirectories yet");
  if (mcpServers.length > 0)
    throw new Error("Local ACP does not support ACP MCP servers yet");
}

function binding(connection: PrivateLocalServiceConnection) {
  return {
    session: connection.session,
    sessionId: connection.sessionId,
    close: connection.close,
  };
}

function localDirectory(
  manager: PrivateLocalServiceManager,
  databasePath: string | undefined,
  invocationRoot: string,
): AuthorizedShiitakeSessionDirectory {
  return {
    async list(input) {
      if (input.cursor !== undefined)
        throw acp.RequestError.invalidParams(
          undefined,
          "Local discovery has no next page",
        );
      const cwd = input.cwd ?? invocationRoot;
      const discovery = await manager.discover(cwd, { signal: input.signal });
      if (discovery.problems.length > 0)
        throw new Error("Local Session discovery contains unreadable stores");
      return {
        sessions: discovery.sessions.map((session) => ({
          sessionId: session.sessionId,
          cwd,
          title: session.title,
          updatedAt: new Date(session.updatedAt).toISOString(),
        })),
      };
    },
    async create(input) {
      assertLocalInputs(input.additionalDirectories, input.mcpServers);
      const selected = await manager.connect(
        {
          invocationRoot: input.cwd,
          databasePath,
        },
        { signal: input.signal },
      );
      try {
        const created = await manager.createSession(
          {
            invocationRoot: input.cwd,
            databasePath: selected.databasePath,
            requestId: createPrivateLocalSessionRequestId(),
          },
          { signal: input.signal },
        );
        return binding(created);
      } finally {
        await selected.close();
      }
    },
    async load(input) {
      assertLocalInputs(input.additionalDirectories, input.mcpServers);
      const connected = await manager.connect(
        {
          invocationRoot: input.cwd,
          databasePath,
          sessionId: input.sessionId,
        },
        { signal: input.signal },
      );
      return binding(connected);
    },
  };
}

/** Build the ACP agent half over the persistent Local service's Session client. */
export function createPrivateLocalAcpAgent(options: LocalAcpStdioOptions = {}) {
  const manager =
    options.manager ??
    createPrivateLocalServiceManager(localManagerOptions(options));
  return createShiitakeAcpAgent({
    directory: localDirectory(
      manager,
      options.databasePath,
      options.invocationRoot ?? process.cwd(),
    ),
    terminalAuth: {
      id: "fungi-login",
      name: "Sign in to Fungi",
      args: ["login"],
    },
    name: options.name ?? "Local Shiitake",
  });
}

function localManagerOptions(
  options: LocalAcpStdioOptions,
): Parameters<typeof createPrivateLocalServiceManager>[0] {
  const result: Parameters<typeof createPrivateLocalServiceManager>[0] = {};
  if (options.serviceDirectory !== undefined)
    result.directory = options.serviceDirectory;
  if (options.eventSource !== undefined)
    result.eventSource = options.eventSource;
  return result;
}

/** Serve one ACP stable-v1 stdio connection over the persistent Local service. */
export async function runPrivateLocalAcpStdio(
  options: LocalAcpStdioOptions = {},
): Promise<void> {
  const app = createPrivateLocalAcpAgent(options);
  const input = options.input ?? stdinByteStream();
  const output = options.output ?? stdoutByteStream();
  const connection = app.connect(acp.ndJsonStream(output, input));
  await connection.closed;
}
