import { expect, it, vi } from "vitest";
import type { BirdDogMail } from "@fungi.computer/bird-dog";
import type { CommandSettlement } from "@fungi.computer/shiitake";
import { createNativeSqliteOwnerFixture } from "../../../packages/shiitake/test/fixtures/native-sqlite-owner.fixture.js";
import { createPrivateLocalDelegation } from "../src/private-local-delegation.js";

it.each([false, true])(
  "an unanswered child item is reminded at most twice, never escalated (closing during settlement: %s)",
  async (closing) => {
    vi.useFakeTimers();
    const fixture = createNativeSqliteOwnerFixture();
    const sent: BirdDogMail[] = [];
    const reminders: unknown[] = [];
    let finishSettlement: (() => void) | undefined;
    const delegation = createPrivateLocalDelegation({
      agentId: "parent",
      storage: fixture.owner,
      directory: {
        list: () =>
          Promise.resolve([
            { agentId: "parent", name: "Shiitake" },
            { agentId: "child", name: "Sol" },
          ]),
        open: () => Promise.reject(new Error("Must not open")),
      },
      routing: {
        deliver: (mail) => {
          sent.push(mail);
          return Promise.resolve({
            status: "accepted",
            commandId: "child-work",
          });
        },
        readSettlement: () => Promise.resolve(undefined),
      },
      accept: () =>
        Promise.resolve({ status: "accepted", commandId: "carrying-turn" }),
      unattended: {
        readSettlement: (_sessionId, commandId) => {
          const settlement = {
            acceptedSender: null,
            delegator: null,
            terminal: {
              commandId,
              outcome: "completed",
              sequence: 1,
              diagnostic: null,
            },
            content: "Done",
            usage: [],
            toolCalls: 0,
            waitingOnYou: [],
          } satisfies CommandSettlement;
          if (closing)
            return new Promise<CommandSettlement>((resolve) => {
              finishSettlement = () => {
                resolve(settlement);
              };
            });
          return Promise.resolve(settlement);
        },
        remind: (item, receiverSessionId, number) => {
          reminders.push({ item, receiverSessionId, number });
          return Promise.resolve({
            status: "reminded",
            commandId: `reminder-${String(number)}`,
          });
        },
      },
    });
    try {
      await delegation.send(
        {
          agentId: "child",
          sessionId: "child-session",
          requestId: "delegate",
          delivery: "followUp",
          text: "Work",
        },
        "parent-session",
        new AbortController().signal,
        { toolCallId: "tool", sendIndex: 0 },
      );
      const mail = sent[0];
      if (mail === undefined) throw new Error("No delegated mail");
      const reply: BirdDogMail = {
        key: `${mail.key}:reply:0`,
        from: { kind: "agent", agentId: "child", sessionId: "child-session" },
        to: { kind: "agent", agentId: "parent", sessionId: "parent-session" },
        replyTo: [],
        content: "Waiting on you",
        createdAt: Date.now(),
        reply: {
          commandId: "child-work",
          outcome: "completed",
          waitingOnYou: [
            { itemId: "ask", kind: "question", summary: "Which branch?" },
          ],
        },
      };
      await delegation.receive(reply);
      if (closing) {
        await vi.advanceTimersByTimeAsync(5_000);
        if (finishSettlement === undefined)
          throw new Error("No settlement read");
        await delegation.close();
        finishSettlement();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(reminders).toEqual([]);
        return;
      }
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reminders).toEqual([
        {
          item: { agentId: "child", sessionId: "child-session", itemId: "ask" },
          receiverSessionId: "parent-session",
          number: 1,
        },
        {
          item: { agentId: "child", sessionId: "child-session", itemId: "ask" },
          receiverSessionId: "parent-session",
          number: 2,
        },
      ]);
      await delegation.receive(reply);
      await vi.advanceTimersByTimeAsync(5_000);
      await delegation.close();
      expect(reminders).toHaveLength(2);
    } finally {
      await delegation.close();
      fixture.close();
      vi.useRealTimers();
    }
  },
);
