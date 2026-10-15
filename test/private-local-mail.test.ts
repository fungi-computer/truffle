import { fauxModel } from "@fungi.computer/mule/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BirdDog, type BirdDogMail } from "@fungi.computer/bird-dog";
import { makeHost, type RuntimeHost } from "@fungi.computer/shiitake";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";

import { createPrivateLocalMailRoom } from "../src/private-local-mail.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";

const parent = {
  kind: "agent",
  agentId: "parent-agent",
  sessionId: "main",
} as const;
const child = {
  kind: "agent",
  agentId: "child-agent",
  sessionId: "main",
} as const;

it("reopens a persisted retry and delivers it to the addressed recipient once", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-local-mail-"));
  const childPath = join(root, "child.sqlite");
  const parentDatabase = new DatabaseSync(join(root, "parent.sqlite"));
  const wakeTimes: number[] = [];
  let now = 100;
  let recipientAvailable = false;
  let parentCommandId: string | undefined;
  let parentReconcile: (() => Promise<void>) | undefined;
  const runtime: RuntimeHost = {
    bind: ({ reconcile }) => {
      parentReconcile = reconcile;
      return Promise.resolve({
        commit: (mutation) => mutation(),
        requestWake: () => Promise.resolve(),
        close: () => Promise.resolve(),
      });
    },
  };
  const faux = fauxModel([]);
  faux.setResponses([fauxAssistantMessage("Reply received")]);
  const parentRoom = createPrivateLocalMailRoom(parentDatabase, {
    deliver: () => Promise.reject(new Error("The parent owes no replies")),
  });
  const parentHost = await makeHost(
    {
      store: createPrivateSqliteOwner(parentDatabase),
      extensions: { roster: [], grants: [] },
      runtime,
      instructions: {
        load: () =>
          Promise.resolve({ revision: "local-mail-v1", text: "Parent agent" }),
      },
      model: {
        acquire: () =>
          Promise.resolve({
            model: faux.model,
            stream: faux.stream,
            release: () => Promise.resolve(),
          }),
      },
    },
    parentRoom,
  );
  const options = {
    deliver: async (mail: BirdDogMail) => {
      if (!recipientAvailable) throw new Error("Parent is unavailable");
      const accepted = await parentHost.acceptMail(mail);
      parentCommandId = accepted.commandId;
      return accepted;
    },
    scheduleWake: (at: number) => {
      wakeTimes.push(at);
    },
    now: () => now,
  };
  const queued = BirdDog.agentJob({
    work: {
      jobId: "job-local-retry",
      sessionId: child.sessionId,
      commandFactId: "entry-local-retry",
    },
    mail: {
      key: "delegation-local-retry",
      to: child,
      from: parent,
      replyTo: [parent],
      content: "Run the child task",
      createdAt: 42,
    },
  });

  try {
    const firstDatabase = new DatabaseSync(childPath);
    const first = createPrivateLocalMailRoom(firstDatabase, options);
    await Effect.runPromise(
      first.fanOut({
        job: { ...queued, state: "settled", outcome: "completed" },
        content: "Child result",
      }),
    );
    await Effect.runPromise(first.drainOutbox());
    firstDatabase.close();
    expect(wakeTimes).toEqual([100, 2_100]);

    now = 101;
    wakeTimes.length = 0;
    const reopenedDatabase = new DatabaseSync(childPath);
    const reopened = createPrivateLocalMailRoom(reopenedDatabase, options);
    await Effect.runPromise(reopened.drainOutbox());
    expect(wakeTimes).toEqual([2_100]);
    expect(
      (await parentHost.agent.session(parent.sessionId).read()).messages,
    ).toEqual([]);

    now = 2_100;
    recipientAvailable = true;
    await Effect.runPromise(reopened.drainOutbox());
    await Effect.runPromise(reopened.drainOutbox());
    reopenedDatabase.close();

    const session = parentHost.agent.session(parent.sessionId);
    expect((await session.read()).messages).toEqual([]);
    if (parentReconcile === undefined)
      throw new Error("Missing parent reconciliation");
    await parentReconcile();
    await parentReconcile();
    const messages = (await session.read()).messages.filter(
      (message) => message.value.role === "user",
    );
    expect(messages).toHaveLength(1);
    expect(parentCommandId).toEqual(expect.any(String));
    expect(messages[0]?.commandId).toBe(parentCommandId);
    expect(JSON.stringify(messages[0]?.value)).toContain("Child result");
  } finally {
    await parentHost.agent.close();
    parentDatabase.close();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ["fan-out", "completed"],
  ["completion", "completed"],
  ["fan-out", "cancelled"],
  ["completion", "cancelled"],
] as const)(
  "recovers %s persistence failure and keeps %s delivery across both owners reopening",
  async (failureBoundary, outcome) => {
    const root = await mkdtemp(join(tmpdir(), "fungi-local-settlement-"));
    const parentPath = join(root, "parent.sqlite");
    let parentDatabase = new DatabaseSync(parentPath);
    const childPath = join(root, "child.sqlite");
    let parentReconcile: (() => Promise<void>) | undefined;
    const parentRuntime: RuntimeHost = {
      bind: ({ reconcile }) => {
        parentReconcile = reconcile;
        return Promise.resolve({
          commit: (mutation) => mutation(),
          requestWake: () => Promise.resolve(),
          close: () => Promise.resolve(),
        });
      },
    };
    const faux = fauxModel([]);
    faux.setResponses(
      outcome === "cancelled"
        ? [fauxAssistantMessage("Reply received")]
        : [
            fauxAssistantMessage("Child result"),
            fauxAssistantMessage("Reply received"),
          ],
    );
    const openParent = (database: DatabaseSync) =>
      makeHost(
        {
          store: createPrivateSqliteOwner(database),
          extensions: { roster: [], grants: [] },
          runtime: parentRuntime,
          instructions: {
            load: () => Promise.resolve({ revision: "parent", text: "Parent" }),
          },
          model: {
            acquire: () =>
              Promise.resolve({
                model: faux.model,
                stream: faux.stream,
                release: () => Promise.resolve(),
              }),
          },
        },
        createPrivateLocalMailRoom(database, {
          deliver: () =>
            Promise.reject(new Error("The parent owes no replies")),
        }),
      );
    let parentHost = await openParent(parentDatabase);
    let childReconcile: (() => Promise<void>) | undefined;
    let parentCommandId: string | undefined;
    let posts = 0;
    const openChild = async (database: DatabaseSync) => {
      const room = createPrivateLocalMailRoom(database, {
        deliver: async (mail) => {
          expect(mail.to).toEqual(parent);
          posts += 1;
          const accepted = await parentHost.acceptMail(mail);
          parentCommandId = accepted.commandId;
          return accepted;
        },
      });
      const host = await makeHost(
        {
          store: createPrivateSqliteOwner(database),
          extensions: { roster: [], grants: [] },
          runtime: {
            bind: (input) => {
              childReconcile = input.reconcile;
              return Promise.resolve({
                commit: (mutation) => mutation(),
                requestWake: () => Promise.resolve(),
                close: () => Promise.resolve(),
              });
            },
          },
          instructions: {
            load: () => Promise.resolve({ revision: "child", text: "Child" }),
          },
          model: {
            acquire: () =>
              Promise.resolve({
                model: faux.model,
                stream: faux.stream,
                release: () => Promise.resolve(),
              }),
          },
        },
        room,
      );
      return host;
    };
    let childDatabase = new DatabaseSync(childPath);
    let childHost = await openChild(childDatabase);
    const behaviour = await Promise.allSettled([
      (async () => {
        const failureMessage =
          failureBoundary === "fan-out"
            ? "Agent reply fan-out is unavailable"
            : "Agent reply delivery is unavailable";
        childDatabase.exec(
          failureBoundary === "fan-out"
            ? "CREATE TRIGGER fail_mail_write BEFORE INSERT ON local_birddog_outbox BEGIN SELECT RAISE(ABORT, 'interrupted'); END"
            : "CREATE TRIGGER fail_mail_write BEFORE UPDATE ON local_birddog_outbox BEGIN SELECT RAISE(ABORT, 'interrupted'); END",
        );
        await childHost.acceptMail({
          key: "file-settlement",
          to: child,
          from: parent,
          replyTo: [parent],
          content: "Run child",
          createdAt: 1,
        });
        if (outcome === "cancelled") {
          await childHost.agent
            .withMeta({ author: { id: "member-ada", name: "Ada" } })
            .session(child.sessionId)
            .abort();
          await childHost.agent
            .withMeta({ author: { id: "member-grace", name: "Grace" } })
            .session(child.sessionId)
            .abort();
        }
        if (childReconcile === undefined)
          throw new Error("missing child reconciliation");
        await expect(childReconcile()).rejects.toThrow(failureMessage);
        expect(
          childDatabase
            .prepare(
              "SELECT state, outcome FROM watchdog_jobs WHERE state = 'settled'",
            )
            .all(),
        ).toHaveLength(1);
        await expect(childHost.agent.close()).rejects.toThrow(failureMessage);
        childDatabase.close();

        childDatabase = new DatabaseSync(childPath);
        childDatabase.exec("DROP TRIGGER fail_mail_write");
        childHost = await openChild(childDatabase);
        await childReconcile();
        await childReconcile();
        expect(
          (await parentHost.agent.session(parent.sessionId).read()).messages,
        ).toEqual([]);
        if (parentReconcile === undefined)
          throw new Error("Missing parent reconciliation");
        await parentReconcile();
        await childReconcile();
        await parentReconcile();
        const messages = (
          await parentHost.agent.session(parent.sessionId).read()
        ).messages.filter((message) => message.value.role === "user");
        expect(messages).toHaveLength(1);
        expect(parentCommandId).toEqual(expect.any(String));
        expect(messages[0]?.commandId).toBe(parentCommandId);
        expect(JSON.stringify(messages[0]?.value)).toContain(
          outcome === "cancelled" ? "Work cancelled by Ada." : "Child result",
        );
        expect(posts).toBe(failureBoundary === "fan-out" ? 1 : 2);
        expect(faux.state.callCount).toBe(outcome === "cancelled" ? 1 : 2);
        const completedPosts = posts;
        await childHost.agent.close();
        childDatabase.close();
        await parentHost.agent.close();
        parentDatabase.close();

        parentDatabase = new DatabaseSync(parentPath);
        parentHost = await openParent(parentDatabase);
        childDatabase = new DatabaseSync(childPath);
        childHost = await openChild(childDatabase);
        await childReconcile();
        await parentReconcile();
        await childReconcile();
        expect(posts).toBe(completedPosts);
        expect(faux.state.callCount).toBe(outcome === "cancelled" ? 1 : 2);
        const reopenedMessages = (
          await parentHost.agent.session(parent.sessionId).read()
        ).messages.filter((message) => message.value.role === "user");
        expect(reopenedMessages).toEqual(messages);
      })(),
    ]);
    const cleanup = await Promise.allSettled([
      (async () => {
        if (childDatabase.isOpen) {
          try {
            await childHost.agent.close();
          } finally {
            childDatabase.close();
          }
        }
      })(),
      (async () => {
        if (parentDatabase.isOpen) {
          try {
            await parentHost.agent.close();
          } finally {
            parentDatabase.close();
          }
        }
      })(),
    ]);
    const removed = await Promise.allSettled([
      rm(root, { recursive: true, force: true }),
    ]);
    const failures: unknown[] = [];
    for (const result of [...behaviour, ...cleanup, ...removed]) {
      if (result.status === "rejected") failures.push(result.reason);
    }
    if (failures.length > 0)
      throw new AggregateError(
        failures,
        "Local mail proof or owner teardown failed",
      );
  },
);
