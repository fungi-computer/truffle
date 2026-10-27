import { directSandbox } from "@fungi.computer/mycelium/testing";
import { Mycelium } from "@fungi.computer/mycelium";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import {
  createAgentControlSource,
  type AgentControlDirectory,
} from "@fungi.computer/shiitake/agent-control";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { memoryHost, fauxModelSource } from "@fungi.computer/shiitake/testing";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";
import { createPrivateLocalDelegation } from "../src/private-local-delegation.js";
import type { BirdDogMail } from "@fungi.computer/bird-dog";

async function throughAgentTools(
  directory: AgentControlDirectory,
  toolCallId: string,
  run: (
    tools: NonNullable<
      Parameters<Parameters<typeof directSandbox>[0]>[0]["agents"]
    >,
  ) => Promise<null>,
) {
  const runtime = await Mycelium.make({
    session: { sessionId: "parent-main" },
    sources: [createAgentControlSource(directory)],
    sandbox: directSandbox(async ({ agents }) => {
      if (agents === undefined) throw new Error("Agent tools missing");
      return await run(agents);
    }),
  });
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: toolCallId,
        name: "execute",
        arguments: { code: "return agents // " + toolCallId },
      }),
    );
    const parts = await Effect.runPromise(
      Stream.runCollect(prepared.execute()),
    );
    expect(parts[0]).toMatchObject({
      type: "result",
      result: { isError: false },
    });
  } finally {
    await lease.release();
    await runtime.close();
  }
}

it.each<{
  delivery: "steer" | "followUp";
  state: "pending" | "active" | "settled" | "lost-response";
}>([
  { delivery: "steer", state: "pending" },
  { delivery: "followUp", state: "pending" },
  { delivery: "steer", state: "active" },
  { delivery: "followUp", state: "active" },
  { delivery: "steer", state: "settled" },
  { delivery: "followUp", state: "settled" },
  { delivery: "followUp", state: "lost-response" },
])(
  "public Local $delivery recalls only its own pending work ($state)",
  async ({ delivery, state }) => {
    const database = new DatabaseSync(":memory:");
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    let modelSignal: AbortSignal | undefined;
    let reconciliation: Promise<void> | undefined;
    const model = fauxModelSource([
      async (_context, options) => {
        modelSignal = options?.signal;
        entered.resolve(undefined);
        if (state === "active") await release.promise;
        return fauxAssistantMessage("Completed the original work");
      },
    ]);
    const target = await memoryHost({ model });
    const otherParentDatabase = new DatabaseSync(":memory:");
    let deliveries = 0;
    let authorized = true;
    const options = {
      agentId: "parent",
      storage: createPrivateSqliteOwner(database),
      directory: {
        list: () =>
          Promise.resolve([
            { agentId: "parent", name: "Parent" },
            { agentId: "other-parent", name: "Other parent" },
            ...(authorized ? [{ agentId: "child", name: "Child" }] : []),
          ]),
        open: () =>
          Promise.resolve({
            agent: target.agent,
            release: () => Promise.resolve(),
          }),
      },
      routing: {
        deliver: async (
          mail: import("@fungi.computer/bird-dog").BirdDogMail,
        ) => {
          deliveries += 1;
          const agent =
            mail.meta === undefined
              ? target.agent
              : target.agent.withMeta(mail.meta);
          if (mail.to.sessionId === undefined)
            throw new Error("Local follow-up mail must name its Session");
          const accepted = await agent
            .session(mail.to.sessionId)
            .send(mail.content, { requestId: mail.key, delivery: "followUp" });
          if (state === "lost-response" && deliveries === 1)
            throw new Error("Delivery response was lost after admission");
          return accepted;
        },
        readSettlement: () => Promise.resolve(undefined),
      },
      accept: () => Promise.reject(new Error("This test sends no replies")),
    };
    const task = {
      agentId: "child",
      sessionId: "child-main",
      requestId: "caller-raw-id",
      text: "Work once",
      delivery,
    };
    const signal = new AbortController().signal;
    try {
      const owner = createPrivateLocalDelegation(options);
      let publicReceipt: unknown;
      await throughAgentTools(
        { ...options.directory, ...owner },
        "tool-a",
        async ({ send }) => {
          if (send === undefined) throw new Error("Send missing");
          if (state === "lost-response")
            await expect(send(task)).rejects.toThrow(
              "Delivery response was lost after admission",
            );
          else publicReceipt = await send(task);
          return null;
        },
      );
      const reopened = createPrivateLocalDelegation(options);
      let publicReplay: unknown;
      await throughAgentTools(
        { ...options.directory, ...reopened },
        "tool-b",
        async ({ send }) => {
          if (send === undefined) throw new Error("Send missing");
          if (state !== "lost-response") publicReplay = await send(task);
          return null;
        },
      );
      const pending = (await target.agent.session("child-main").read()).pending
        .prompts;
      expect(pending).toHaveLength(1);
      const admitted = pending[0];
      if (admitted === undefined)
        throw new Error("Accepted prompt missing from its owner");
      const accepted = { status: "accepted", commandId: admitted.commandId };
      if (state !== "lost-response") {
        expect(publicReceipt).toEqual(accepted);
        expect(publicReplay).toEqual(accepted);
      }
      expect(pending[0]).toMatchObject({ text: task.text, delivery });
      expect(pending[0]?.requestId).not.toBe(task.requestId);
      expect(deliveries).toBe(delivery === "followUp" ? 1 : 0);
      const request = {
        agentId: task.agentId,
        sessionId: task.sessionId,
        requestId: task.requestId,
      };
      expect(
        await reopened.recall(request, "another-parent-session", signal),
      ).toEqual({ status: "unknown" });
      expect(
        (await target.agent.session("child-main").read()).pending.prompts,
      ).toHaveLength(1);
      const otherParent = createPrivateLocalDelegation({
        ...options,
        agentId: "other-parent",
        storage: createPrivateSqliteOwner(otherParentDatabase),
      });
      expect(await otherParent.recall(request, "parent-main", signal)).toEqual({
        status: "unknown",
      });
      expect(
        (await target.agent.session("child-main").read()).pending.prompts,
      ).toHaveLength(1);
      expect(
        await reopened.recall(
          { ...request, sessionId: "other-target-session" },
          "parent-main",
          signal,
        ),
      ).toEqual({ status: "unknown" });
      authorized = false;
      await expect(
        reopened.recall(request, "parent-main", signal),
      ).rejects.toThrow("outside this Local project");
      authorized = true;
      expect(
        (await target.agent.session("child-main").read()).pending.prompts,
      ).toHaveLength(1);
      if (state === "active") {
        reconciliation = target.reconcile();
        await entered.promise;
      } else if (state === "settled") await target.settle("child-main");
      let publicRecall: unknown;
      await throughAgentTools(
        { ...options.directory, ...reopened },
        "tool-recall",
        async ({ recall }) => {
          if (recall === undefined) throw new Error("Recall missing");
          publicRecall = await recall(request);
          return null;
        },
      );
      const expected =
        state === "active" || state === "settled"
          ? { status: "too_late", commandId: accepted.commandId }
          : accepted;
      expect(publicRecall).toEqual(expected);
      expect(await reopened.recall(request, "parent-main", signal)).toEqual(
        expected,
      );
      if (state === "active") {
        expect(modelSignal?.aborted).toBe(false);
        release.resolve(undefined);
        await reconciliation;
        await target.settle("child-main");
      } else await target.reconcile();
      expect(
        (await target.agent.session("child-main").read()).terminals,
      ).toContainEqual(
        expect.objectContaining({
          commandId: accepted.commandId,
          outcome:
            state === "active" || state === "settled"
              ? "completed"
              : "cancelled",
        }),
      );
    } finally {
      release.resolve(undefined);
      try {
        await reconciliation;
      } finally {
        await target.close();
        database.close();
        otherParentDatabase.close();
      }
    }
  },
);

it.each(["steer", "followUp"] as const)(
  "public Local %s unknown recall fences late admission after both owners reopen",
  async (delivery) => {
    const senderDatabase = new DatabaseSync(":memory:");
    const targetDatabase = new DatabaseSync(":memory:");
    const targetStorage = createPrivateSqliteOwner(targetDatabase);
    let target = await memoryHost({ owner: targetStorage });
    const options = {
      agentId: "parent",
      storage: createPrivateSqliteOwner(senderDatabase),
      directory: {
        list: () =>
          Promise.resolve([
            { agentId: "parent", name: "Parent" },
            { agentId: "child", name: "Child" },
          ]),
        open: () =>
          Promise.resolve({
            agent: target.agent,
            release: () => Promise.resolve(),
          }),
      },
      routing: {
        deliver: (mail: import("@fungi.computer/bird-dog").BirdDogMail) => {
          if (mail.to.sessionId === undefined)
            throw new Error("Local follow-up mail must name its Session");
          return target.agent.session(mail.to.sessionId).send(mail.content, {
            requestId: mail.key,
            delivery: "followUp",
          });
        },
        readSettlement: () => Promise.resolve(undefined),
      },
      accept: () => Promise.reject(new Error("This test sends no replies")),
    };
    const request = {
      agentId: "child",
      sessionId: "child-main",
      requestId: "recalled-before-send",
    };
    try {
      const owner = createPrivateLocalDelegation(options);
      await throughAgentTools(
        { ...options.directory, ...owner },
        "recall-before-admission",
        async ({ recall }) => {
          if (recall === undefined) throw new Error("Recall missing");
          expect(await recall(request)).toEqual({ status: "unknown" });
          return null;
        },
      );
      await target.close();
      target = await memoryHost({ owner: targetStorage });
      const reopened = createPrivateLocalDelegation(options);
      await throughAgentTools(
        { ...options.directory, ...reopened },
        "late-send-after-reopen",
        async ({ send, recall }) => {
          if (send === undefined || recall === undefined)
            throw new Error("Request-owned tools missing");
          expect(await recall(request)).toEqual({ status: "unknown" });
          await expect(
            send({
              ...request,
              text: "Never admit this late arrival",
              delivery,
            }),
          ).rejects.toThrow("Request was withdrawn");
          expect(await recall(request)).toEqual({ status: "unknown" });
          return null;
        },
      );
      const snapshot = await target.agent.session("child-main").read();
      expect(snapshot.pending.prompts).toEqual([]);
      expect(snapshot.messages).toEqual([]);
      expect(snapshot.terminals).toEqual([]);
    } finally {
      await target.close();
      senderDatabase.close();
      targetDatabase.close();
    }
  },
);

it("recalls an accepted sessionless follow-up by its returned Session", async () => {
  const senderDatabase = new DatabaseSync(":memory:");
  const targetDatabase = new DatabaseSync(":memory:");
  const target = await memoryHost({
    owner: createPrivateSqliteOwner(targetDatabase),
  });
  const signal = new AbortController().signal;
  const directory: AgentControlDirectory = {
    list: () =>
      Promise.resolve([
        { agentId: "parent", name: "Parent" },
        { agentId: "child", name: "Child" },
      ]),
    open: () =>
      Promise.resolve({
        agent: target.agent,
        release: () => Promise.resolve(),
      }),
  };
  const delegation = createPrivateLocalDelegation({
    agentId: "parent",
    storage: createPrivateSqliteOwner(senderDatabase),
    directory,
    routing: {
      deliver: async (mail) => {
        if (mail.to.sessionId !== undefined)
          throw new Error("This test sends sessionless work");
        const sessionId = await target.agent.createSession(mail.key);
        const accepted = await target.agent
          .session(sessionId)
          .send(mail.content, {
            requestId: mail.key,
            delivery: "followUp",
          });
        return { ...accepted, sessionId };
      },
      readSettlement: () => Promise.resolve(undefined),
    },
    accept: () => Promise.reject(new Error("This test receives no replies")),
  });
  try {
    const receipt = await delegation.send(
      {
        agentId: "child",
        requestId: "sessionless-request",
        text: "Work once",
        delivery: "followUp",
      },
      "parent-main",
      signal,
      { toolCallId: "call-1", sendIndex: 0 },
    );
    if (receipt.status !== "accepted")
      throw new Error("Sessionless Local work was not accepted");
    if (receipt.sessionId === undefined)
      throw new Error("Sessionless acceptance omitted its Session");

    expect(
      await delegation.recall(
        {
          agentId: "child",
          sessionId: receipt.sessionId,
          requestId: "sessionless-request",
        },
        "parent-main",
        signal,
      ),
    ).toMatchObject({ status: "accepted" });
    expect(
      (await target.agent.session(receipt.sessionId).read()).pending.prompts,
    ).toEqual([]);
  } finally {
    await target.close();
    senderDatabase.close();
    targetDatabase.close();
  }
});

it("authenticates a schema-valid sessionless undeliverable reply against frozen mail", async () => {
  const database = new DatabaseSync(":memory:");
  let frozenMail: BirdDogMail | undefined;
  const accepted: BirdDogMail[] = [];
  const delegation = createPrivateLocalDelegation({
    agentId: "parent",
    storage: createPrivateSqliteOwner(database),
    directory: {
      list: () =>
        Promise.resolve([
          { agentId: "parent", name: "Parent" },
          { agentId: "child", name: "Child" },
        ]),
      open: () => Promise.reject(new Error("No Session is opened")),
    },
    routing: {
      deliver: (mail) => {
        frozenMail = mail;
        return Promise.resolve({
          status: "held",
          reason: "recipient_offline",
          message: "waiting: recipient offline",
        });
      },
      readSettlement: () => Promise.resolve(undefined),
    },
    accept: (mail) => {
      accepted.push(mail);
      return Promise.resolve({
        status: "accepted",
        commandId: "reply-command",
        sessionId: "parent-session",
      });
    },
  });
  try {
    await delegation.send(
      {
        agentId: "child",
        requestId: "sessionless-offline",
        text: "Work",
        delivery: "followUp",
      },
      "parent-session",
      new AbortController().signal,
      { toolCallId: "call-1", sendIndex: 0 },
    );
    if (frozenMail === undefined)
      throw new Error("Outgoing mail was not frozen");
    if (frozenMail.from.kind !== "agent")
      throw new Error("Outgoing mail did not retain its Agent sender");
    const reply: BirdDogMail = {
      key: `${frozenMail.key}:reply:0`,
      to: frozenMail.from,
      from: { kind: "system", systemId: "hub" },
      replyTo: [],
      content: "Not delivered: recipient offline.",
      createdAt: 1,
      reply: { outcome: "undeliverable", reason: "recipient_offline" },
    };
    await expect(delegation.receive(reply)).resolves.toMatchObject({
      status: "accepted",
      commandId: "reply-command",
    });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject(reply);

    await expect(
      delegation.receive({
        ...reply,
        key: "foreign-mail:reply:0",
      }),
    ).rejects.toThrow("Local reply does not match work this Agent sent");
    expect(accepted).toHaveLength(1);
  } finally {
    database.close();
  }
});
