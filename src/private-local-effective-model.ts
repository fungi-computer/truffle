import { z } from "zod";

import { thinkingLevelSchema } from "./private-fungi-model-catalog.js";

/** Secret-free model status published by the Local owner for one Session. */
export const privateLocalEffectiveModelSchema = z.strictObject({
  agentName: z.literal("Shiitake"),
  providerId: z.string().min(1).max(160),
  providerName: z.string().min(1).max(256),
  modelId: z.string().min(1).max(160),
  modelName: z.string().min(1).max(256),
  credential: z.strictObject({
    kind: z.enum(["oauth", "api_key", "missing"]),
    source: z.string().min(1).max(160),
  }),
  /** The resolved thinking level a run would use; absent when the model has none. */
  reasoning: thinkingLevelSchema.optional(),
  label: z.string().min(1).max(640),
});

export type PrivateLocalEffectiveModel = z.output<
  typeof privateLocalEffectiveModelSchema
>;
