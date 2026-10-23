import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fungiMcpAccountAuth } from "./private-fungi-account.js";
import type { PrivateFungiMcpConnectionOptions } from "./private-fungi-mcp-connection.js";
import { oysterMcpKeyAuth } from "./private-oyster-mcp-auth.js";
import {
  fungiMcpSelectionSchema,
  type PrivateFungiMcpSelection,
} from "./private-fungi-mcp-selection-schema.js";

/** The service validates saved project selections with the RPC selection schema. */
export async function readProjectFungiMcpSelection(root: string) {
  const path = join(root, ".fungi", "team-mcp.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return undefined;
    throw cause;
  }
  try {
    return fungiMcpSelectionSchema.parse(JSON.parse(text));
  } catch (cause) {
    throw new Error(
      `${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

export function readFungiMcpSelection(
  selection: PrivateFungiMcpSelection,
  options: { credentialPath?: string } = {},
): PrivateFungiMcpConnectionOptions {
  const parsed = fungiMcpSelectionSchema.safeParse(selection);
  if (!parsed.success)
    throw new Error("Invalid Fungi MCP connection selection");
  if (process.platform !== "linux" && process.platform !== "darwin")
    throw new Error(
      "Fungi MCP credential connections are supported only on Linux and macOS",
    );
  const endpoint = new URL(parsed.data.endpoint);
  return {
    endpoint,
    authentication: parsed.data.authentication,
    authProvider:
      parsed.data.authentication === "oyster-key"
        ? oysterMcpKeyAuth(endpoint, options)
        : fungiMcpAccountAuth(endpoint, options),
  };
}

export function sameFungiMcpConnection(
  left: PrivateFungiMcpConnectionOptions | undefined,
  right: PrivateFungiMcpConnectionOptions,
): boolean {
  return (
    left?.endpoint.href === right.endpoint.href &&
    left.authentication === right.authentication
  );
}

export class FungiMcpSelectionConflict extends Error {
  constructor() {
    super(
      "This Local Agent already has a different Fungi MCP connection; stop the Local service before changing it",
    );
    this.name = "FungiMcpSelectionConflict";
  }
}
