import { z } from "zod";

/** The service reports each attempted Agent, including partial failures. */
export const stopAllResultSchema = z.strictObject({
  rootAgentId: z.string(),
  agents: z.array(
    z.discriminatedUnion("outcome", [
      z.strictObject({
        agentId: z.string(),
        name: z.string(),
        outcome: z.enum(["stopped", "idle"]),
      }),
      z.strictObject({
        agentId: z.string(),
        name: z.string(),
        outcome: z.literal("failed"),
        reason: z.string(),
      }),
    ]),
  ),
  discoveryFailures: z.array(
    z.strictObject({
      agentId: z.string(),
      reason: z.string(),
    }),
  ),
});

export type StopAllResult = z.infer<typeof stopAllResultSchema>;

export const stopAllRequestSchema = z.strictObject({
  invocationRoot: z.string().min(1),
  agentId: z.string().min(1),
});
