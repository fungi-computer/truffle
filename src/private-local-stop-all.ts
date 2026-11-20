import { z } from "zod";

export const stopAllRequestSchema = z.strictObject({
  invocationRoot: z.string().min(1),
  agentId: z.string().min(1),
});
