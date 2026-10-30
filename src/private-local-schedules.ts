import * as Schema from "effect/Schema";
import { z } from "zod";
import {
  agentScheduleListInputSchema,
  agentSchedulePageSchema,
  agentScheduleTargetSchema,
  readAgentSchedulePage,
} from "@fungi.computer/shiitake-extensions/schedules";
import type { ShiitakeAgent } from "@fungi.computer/shiitake";
import { logEvent } from "./log-event.js";

/** Private service ingress, never a Team/member or machine-link request. */
export const localScheduleListInputSchema = z.strictObject({
  invocationRoot: z.string().min(1),
  ...agentScheduleListInputSchema.shape,
});

/** Private person-only mutation, distinct from the finite list request. */
export const localScheduleControlInputSchema = z.strictObject({
  invocationRoot: z.string().min(1),
  target: agentScheduleTargetSchema,
});

/** Local directory pages reuse the schedule owner's decoder and retained state. */
export const localSchedulePageSchema = Schema.Struct({
  items: agentSchedulePageSchema.fields.items,
  unavailable: Schema.Array(
    Schema.Struct({
      agentId: Schema.String,
      reason: Schema.Literal("owner_unavailable"),
    }),
  ).check(Schema.isMaxLength(8)),
  next: agentSchedulePageSchema.fields.next,
});
export type LocalSchedulePage = typeof localSchedulePageSchema.Type;

/** One bounded read, borrowing existing admitted Agent owners one at a time. */
export async function readLocalSchedulePage(
  agentIds: readonly string[],
  open: (
    agentId: string,
    signal: AbortSignal,
  ) => Promise<{
    owner: Pick<ShiitakeAgent, "extensions">;
    release: () => void;
  }>,
  input: z.output<typeof localScheduleListInputSchema>,
  signal: AbortSignal,
): Promise<LocalSchedulePage> {
  signal.throwIfAborted();
  const candidates = agentIds
    .filter((agentId) =>
      input.after === undefined ? true : agentId >= input.after.agentId,
    )
    .sort();
  const items: LocalSchedulePage["items"][number][] = [];
  const unavailable: LocalSchedulePage["unavailable"][number][] = [];
  // Bound runtime fan-out even when many retained Agents have no schedules.
  const owners = candidates.slice(0, 8);
  for (const agentId of owners) {
    signal.throwIfAborted();
    try {
      const { owner, release } = await open(agentId, signal);
      try {
        const limit = input.limit - items.length;
        const pageInput =
          input.after?.agentId === agentId
            ? { limit, after: input.after }
            : { limit };
        const page = await readAgentSchedulePage(agentId, owner, pageInput);
        signal.throwIfAborted();
        items.push(...page.items);
        if (page.next !== null) return { items, unavailable, next: page.next };
      } finally {
        release();
      }
    } catch (cause) {
      signal.throwIfAborted();
      logEvent("schedule-directory.owner-unavailable", cause);
      unavailable.push({ agentId, reason: "owner_unavailable" });
    }
  }
  const unread = candidates.at(owners.length);
  return {
    items,
    unavailable,
    next: unread === undefined ? null : { agentId: unread, kind: "almanac" },
  };
}
