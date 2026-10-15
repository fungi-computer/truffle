import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import { z } from "zod";

const levels = z.enum(["minimal", "low", "medium", "high", "xhigh", "max"]);
const catalogSchema = z.object({
  object: z.literal("list"),
  data: z
    .array(
      z.object({
        id: z.string().min(1).max(256),
        owned_by: z.string().min(1).max(256),
        name: z.string().min(1).max(256),
        context_window: z.number().int().positive(),
        max_output_tokens: z.number().int().positive(),
        reasoning_levels: z.array(levels).max(6),
        input: z.array(z.literal("text")).length(1),
        default: z.boolean(),
        cost: z.object({
          input: z.number().nonnegative(),
          output: z.number().nonnegative(),
          cacheRead: z.number().nonnegative(),
          cacheWrite: z.number().nonnegative(),
        }),
      }),
    )
    .max(100),
});

export type FungiHostedModel = Model<"openai-completions"> & {
  default: boolean;
};

/** Only the Hub's hosted rows become Local models; its Billing price owns the estimate. */
export function fungiHostedModels(
  value: unknown,
  baseUrl: string,
): FungiHostedModel[] {
  const rows = catalogSchema
    .parse(value)
    .data.filter(
      (row) => row.owned_by === "fungi" && row.id.startsWith("@fungi/"),
    );
  if (
    rows.filter((row) => row.default).length !== 1 ||
    new Set(rows.map((row) => row.id)).size !== rows.length
  )
    throw new Error("Fungi returned an invalid hosted model catalog");
  return rows.map((row) => {
    const thinkingLevelMap: ThinkingLevelMap = {
      off: null,
      minimal: null,
      low: null,
      medium: null,
      high: null,
      xhigh: null,
      max: null,
    };
    for (const level of row.reasoning_levels) thinkingLevelMap[level] = level;
    return {
      id: row.id,
      name: row.name,
      provider: "fungi",
      api: "openai-completions",
      baseUrl,
      default: row.default,
      input: row.input,
      contextWindow: row.context_window,
      maxTokens: row.max_output_tokens,
      reasoning: row.reasoning_levels.length > 0,
      thinkingLevelMap,
      cost: row.cost,
      compat: {
        supportsStore: false,
        supportsDeveloperRole: true,
        supportsReasoningEffort: true,
        supportsUsageInStreaming: true,
        maxTokensField: "max_completion_tokens",
        requiresToolResultName: false,
        requiresAssistantAfterToolResult: false,
        requiresThinkingAsText: true,
        requiresReasoningContentOnAssistantMessages: false,
        supportsStrictMode: false,
        supportsOpenAIGrammarTools: false,
        supportsMidConvoSystemMessages: false,
        supportsMidConvoToolAdditions: false,
        supportsLongCacheRetention: false,
        sendSessionAffinityHeaders: false,
        zaiToolStream: false,
        thinkingFormat: "openai",
      },
    } satisfies FungiHostedModel;
  });
}
