import { z } from "zod";
import { parseFungiMcpEndpoint } from "./private-fungi-mcp-endpoint.js";

/** A project selects a target and auth kind; credential material stays with Local. */
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
  authentication: z.literal("oyster-key").optional(),
});
export type PrivateFungiMcpSelection = z.infer<typeof fungiMcpSelectionSchema>;
