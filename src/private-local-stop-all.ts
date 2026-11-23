import type { AgentStopAllResult } from "@fungi.computer/agar/agents";
import { z } from "zod";

export const stopAllRequestSchema = z.strictObject({
  invocationRoot: z.string().min(1),
  agentId: z.string().min(1),
});

/**
 * Pause every listed Agent's schedules together, under one shared budget, so a
 * tree of hung Agents costs the budget once and not once each. An Agent that
 * has not answered when the budget ends is reported failed with its cause, and
 * its pause is aborted. Results come back in the listed order.
 */
export async function pauseSchedulesTogether(
  input: Readonly<{
    agentIds: readonly string[];
    pause: (
      agentId: string,
      signal: AbortSignal,
    ) => Promise<
      readonly Pick<
        Extract<AgentStopAllResult["schedules"][number], { outcome: "paused" }>,
        "kind" | "scheduleId"
      >[]
    >;
    budgetMs: number;
  }>,
): Promise<AgentStopAllResult["schedules"]> {
  const budget = new AbortController();
  const budgetExpired = new Error(
    "Agent did not answer within 5 seconds; its schedules were not confirmed paused",
  );
  const expiry = Symbol("budget expired");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof expiry>((resolve) => {
    timer = setTimeout(() => {
      // Settle the budget first, so a hung Agent's own abort error never
      // replaces the cause the person reads.
      resolve(expiry);
      budget.abort(budgetExpired);
    }, input.budgetMs);
  });
  try {
    const settled = await Promise.allSettled(
      input.agentIds.map((agentId) =>
        Promise.race([input.pause(agentId, budget.signal), expired]),
      ),
    );
    return settled.flatMap(
      (outcome, index): AgentStopAllResult["schedules"] => {
        const agentId = input.agentIds[index] ?? "";
        if (outcome.status === "fulfilled" && outcome.value !== expiry)
          return outcome.value.map((schedule) => ({
            agentId,
            ...schedule,
            outcome: "paused",
          }));
        const cause: unknown =
          outcome.status === "rejected" ? outcome.reason : budgetExpired;
        return [
          {
            agentId,
            outcome: "failed",
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        ];
      },
    );
  } finally {
    clearTimeout(timer);
  }
}
