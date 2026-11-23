import { expect, it } from "vitest";
import { pauseSchedulesTogether } from "../src/private-local-stop-all.js";

const budgetMs = 400;

it("pauses every Agent's schedules within one shared budget, however many Agents hang", async () => {
  const agentIds = ["a", "b", "c", "d", "e", "f"];
  const started = Date.now();
  const schedules = await pauseSchedulesTogether({
    agentIds,
    // A hung Agent answers only when the budget's signal aborts it.
    pause: (_agentId, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(
              signal.reason instanceof Error
                ? signal.reason
                : new Error("aborted"),
            );
          },
          { once: true },
        );
      }),
    budgetMs,
  });
  const elapsed = Date.now() - started;
  // Six hung Agents cost one budget, not six; allow scheduler slack.
  expect(elapsed).toBeLessThan(budgetMs * 2);
  expect(schedules.map(({ agentId }) => agentId)).toEqual(agentIds);
  for (const schedule of schedules)
    expect(schedule).toMatchObject({
      outcome: "failed",
      reason:
        "Agent did not answer within 5 seconds; its schedules were not confirmed paused",
    });
});

it("keeps the schedules a quick Agent paused beside a hung Agent's failure, in listed order", async () => {
  const schedules = await pauseSchedulesTogether({
    agentIds: ["hung", "quick", "failing"],
    pause: (agentId, signal) => {
      if (agentId === "quick")
        return Promise.resolve([{ kind: "almanac", scheduleId: "water" }]);
      if (agentId === "failing")
        return Promise.reject(new Error("Store unreadable"));
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    },
    budgetMs: 100,
  });
  expect(schedules).toEqual([
    {
      agentId: "hung",
      outcome: "failed",
      reason:
        "Agent did not answer within 5 seconds; its schedules were not confirmed paused",
    },
    {
      agentId: "quick",
      kind: "almanac",
      scheduleId: "water",
      outcome: "paused",
    },
    { agentId: "failing", outcome: "failed", reason: "Store unreadable" },
  ]);
});
