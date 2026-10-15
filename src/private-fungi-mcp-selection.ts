import { z } from "zod";
import { fungiMcpAccountAuth } from "./private-fungi-account.js";
import type { PrivateFungiMcpConnectionOptions } from "./private-fungi-mcp-connection.js";
import { parseFungiMcpEndpoint } from "./private-fungi-mcp-endpoint.js";

/** A Team MCP address selects a target; OAuth identity stays with Local. */
export const fungiMcpSelectionSchema = z.strictObject({
  endpoint: z.url().pipe(
    z.string().refine((value) => {
      try {
        parseFungiMcpEndpoint(value);
        return true;
      } catch {
        return false;
      }
    }, "Fungi MCP requires HTTPS (or HTTP on an exact loopback host) without credentials, query or fragment"),
  ),
});
export type PrivateFungiMcpSelection = z.infer<typeof fungiMcpSelectionSchema>;

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
    authProvider: fungiMcpAccountAuth(endpoint, options),
  };
}

export function sameFungiMcpConnection(
  left: PrivateFungiMcpConnectionOptions | undefined,
  right: PrivateFungiMcpConnectionOptions,
): boolean {
  return left?.endpoint.href === right.endpoint.href;
}

export class FungiMcpSelectionConflict extends Error {
  constructor() {
    super(
      "This Local Agent already has a different Fungi MCP connection; stop the Local service before changing it",
    );
    this.name = "FungiMcpSelectionConflict";
  }
}
