import { fauxModel } from "@fungi.computer/mule/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BirdDog, type BirdDogMail } from "@fungi.computer/bird-dog";
import { BirdDogError } from "@fungi.computer/bird-dog/effect";
import { makeHost, type RuntimeHost } from "@fungi.computer/shiitake";
import * as Effect from "effect/Effect";
import { expect, it } from "vitest";

import {
  createPrivateLocalMailRoom,
  hasPrivateLocalPendingMail,
} from "../src/private-local-mail.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";
import { createPrivateLocalDelegation } from "../src/private-local-delegation.js";

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

it("admits an addressed one-way ancestor notice as ordinary work, not a reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-local-ancestor-notice-"));
  const database = new DatabaseSync(join(root, "agent.sqlite"));
  const accepted: BirdDogMail[] = [];
  const delegation = createPrivateLocalDelegation({
    agentId: parent.agentId,
    storage: createPrivateSqliteOwner(database),
    directory: {
      list: () =>
        Promise.resolve([
          { agentId: parent.agentId, name: "Parent" },
          { agentId: child.agentId, name: "Worker" },
        ]),
      open: () =>
        Promise.reject(new Error("An addressed notice does not open")),
    },
    routing: {
      deliver: () => Promise.reject(new Error("No reply may be mailed")),
      readSettlement: () => Promise.resolve(undefined),
    },
    accept: (mail) => {
      accepted.push(mail);
      return Promise.resolve({
        status: "accepted",
        sessionId: parent.sessionId,
        commandId: "notice-command",
      });
    },
  });
  const notice: BirdDogMail = {
    key: "worker-to-parent",
    from: child,
    to: parent,
    replyTo: [],
    content: "Status report",
    createdAt: 1,
    meta: {
      delegation: { ancestors: [parent.agentId, child.agentId], maxDepth: 8 },
    },
  };
  try {
    await expect(delegation.receive(notice)).resolves.toMatchObject({
      commandId: "notice-command",
    });
    expect(accepted).toEqual([notice]);
    const mailed: BirdDogMail[] = [];
    const room = createPrivateLocalMailRoom(database, {
      deliver: (mail) => {
        mailed.push(mail);
        return Promise.resolve({ status: "accepted", commandId: "reply" });
      },
      now: () => 2,
    });
    const job = BirdDog.agentJob({
      delivery: "followUp",
      work: {
        jobId: "notice-job",
        sessionId: parent.sessionId,
        commandFactId: "notice-command",
      },
      mail: notice,
    });
    await Effect.runPromise(
      room.fanOut({
        job: { ...job, state: "settled", outcome: "completed" },
        content: "Finished the report",
      }),
    );
    await Effect.runPromise(room.drainOutbox());
    expect(mailed).toEqual([]);
    await expect(
      delegation.receive({
        ...notice,
        key: "forged-ancestor",
        meta: {
          delegation: { ancestors: ["other", child.agentId], maxDepth: 8 },
        },
      }),
    ).rejects.toThrow("Local reply does not match");
  } finally {
    await delegation.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("clears a reply from the local outbox when the relay holds custody", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-local-mail-held-"));
  const database = new DatabaseSync(join(root, "agent.sqlite"));
  const deliveries: BirdDogMail[] = [];
  const room = createPrivateLocalMailRoom(database, {
    deliver: (mail) => {
      deliveries.push(mail);
      return Promise.resolve({
        status: "held",
        reason: "recipient_offline",
        message: "waiting: recipient offline",
      });
    },
    now: () => 100,
  });
  const queued = BirdDog.agentJob({
    delivery: "followUp",
    work: {
      jobId: "job-local-held",
      sessionId: child.sessionId,
      commandFactId: "entry-local-held",
    },
    mail: {
      key: "delegation-local-held",
      to: child,
      from: parent,
      replyTo: [parent],
      content: "Run the child task",
      createdAt: 42,
    },
  });
  try {
    await Effect.runPromise(
      room.fanOut({
        job: { ...queued, state: "settled", outcome: "completed" },
        content: "Child result",
      }),
    );
    await Effect.runPromise(room.drainOutbox());

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]?.content).toBe("Child result");
    expect(await hasPrivateLocalPendingMail(database)).toBe(false);
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("replays sessionless acceptance and its notice after the Local owner reopens", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-local-atomic-acceptance-"));
  const path = join(root, "agent.sqlite");
  let database = new DatabaseSync(path);
  const sent: BirdDogMail[] = [];
  const options = {
    deliver: (mail: BirdDogMail) => {
      sent.push(mail);
      return Promise.resolve({
        status: "accepted" as const,
        commandId: "sender-receipt",
        sessionId: parent.sessionId,
      });
    },
    now: () => 100,
  };
  const room = createPrivateLocalMailRoom(database, options);
  const failingRoom = {
    ...room,
    postMail: () => Effect.fail(new BirdDogError("injected outbox failure")),
  };
  const runtime: RuntimeHost = {
    bind: () =>
      Promise.resolve({
        commit: (mutation) => mutation(),
        requestWake: () => Promise.resolve(),
        close: () => Promise.resolve(),
      }),
  };
  const faux = fauxModel([]);
  const openHost = (storeDatabase: DatabaseSync, mailRoom: typeof room) =>
    makeHost(
      {
        store: createPrivateSqliteOwner(storeDatabase),
        extensions: { roster: [], grants: [] },
        runtime,
        instructions: {
          load: () =>
            Promise.resolve({ revision: "sessionless", text: "Local agent" }),
        },
        model: {
          acquire: () =>
            Promise.resolve({
              model: faux.model,
              retryable: () => false,
              stream: faux.stream,
              release: () => Promise.resolve(),
            }),
        },
      },
      mailRoom,
    );
  const mail: BirdDogMail = {
    key: "sessionless-local-mail",
    from: child,
    to: { kind: "agent", agentId: parent.agentId },
    replyTo: [child],
    content: "Start work",
    createdAt: 50,
  };
  let failedHost: Awaited<ReturnType<typeof openHost>> | undefined;
  let host: Awaited<ReturnType<typeof openHost>> | undefined;

  try {
    failedHost = await openHost(database, failingRoom);
    await expect(failedHost.acceptMail(mail)).rejects.toThrow();
    expect(
      database
        .prepare(
          "SELECT request_id FROM session_creation_receipts WHERE request_id = ?",
        )
        .get(mail.key),
    ).toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT request_id FROM session_command_admissions WHERE request_id = ?",
        )
        .get(mail.key),
    ).toBeUndefined();
    expect(
      database
        .prepare("SELECT key FROM local_birddog_outbox WHERE key = ?")
        .get(`outbox:${mail.key}:accepted`),
    ).toBeUndefined();
    await failedHost.agent.close();
    failedHost = undefined;

    host = await openHost(database, room);
    const receipt = await host.acceptMail(mail);
    expect(await host.acceptMail(mail)).toEqual(receipt);
    expect(receipt.status).toBe("accepted");
    if (receipt.sessionId === undefined)
      throw new Error("Sessionless mail acceptance returned no Session");
    const sessionId = receipt.sessionId;
    expect(
      database
        .prepare(
          "SELECT request_id FROM session_creation_receipts WHERE request_id = ?",
        )
        .all(mail.key),
    ).toEqual([{ request_id: mail.key }]);
    expect(
      database
        .prepare(
          "SELECT request_id FROM session_command_admissions WHERE request_id = ?",
        )
        .all(mail.key),
    ).toEqual([{ request_id: mail.key }]);
    expect(
      database
        .prepare("SELECT key FROM local_birddog_outbox WHERE key = ?")
        .get(`outbox:${mail.key}:accepted`),
    ).toEqual({ key: `outbox:${mail.key}:accepted` });
    await host.agent.close();
    host = undefined;

    database.close();
    database = new DatabaseSync(path);
    const reopened = createPrivateLocalMailRoom(database, options);
    if (reopened.postMail === undefined)
      throw new Error("Reopened Local mail room cannot stage mail");
    host = await openHost(database, reopened);
    expect(await host.acceptMail(mail)).toEqual(receipt);
    expect(
      database
        .prepare(
          "SELECT request_id FROM session_creation_receipts WHERE request_id = ?",
        )
        .all(mail.key),
    ).toEqual([{ request_id: mail.key }]);
    expect(
      database
        .prepare(
          "SELECT request_id FROM session_command_admissions WHERE request_id = ?",
        )
        .all(mail.key),
    ).toEqual([{ request_id: mail.key }]);
    expect(
      database
        .prepare("SELECT key FROM local_birddog_outbox WHERE key = ?")
        .all(`outbox:${mail.key}:accepted`),
    ).toEqual([{ key: `outbox:${mail.key}:accepted` }]);
    await host.agent.close();
    host = undefined;
    await Effect.runPromise(reopened.drainOutbox());
    await Effect.runPromise(reopened.drainOutbox());
    expect(sent).toMatchObject([
      {
        key: `${mail.key}:accepted`,
        from: {
          agentId: parent.agentId,
          sessionId,
        },
        to: {
          agentId: child.agentId,
          sessionId: child.sessionId,
        },
        reply: { outcome: "accepted", commandId: receipt.commandId },
      },
    ]);
    expect(sent).toHaveLength(1);
  } finally {
    if (failedHost !== undefined) await failedHost.agent.close();
    if (host !== undefined) await host.agent.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("reopens and forwards a staged acceptance notice from the durable local outbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "fungi-local-accepted-post-"));
  const path = join(root, "agent.sqlite");
  const notice: BirdDogMail = {
    key: "delegation:accepted",
    to: parent,
    from: child,
    replyTo: [],
    content: "Work accepted.",
    createdAt: 100,
    reply: {
      outcome: "accepted",
      commandId: "accepted-command",
    },
  };
  const deliveries: BirdDogMail[] = [];
  const options = {
    deliver: (mail: BirdDogMail) => {
      deliveries.push(mail);
      return Promise.resolve({
        status: "accepted" as const,
        commandId: "receipt-command",
      });
    },
    now: () => 100,
  };
  const firstDatabase = new DatabaseSync(path);
  const first = createPrivateLocalMailRoom(firstDatabase, options);
  if (first.postMail === undefined)
    throw new Error("The local mail outbox cannot stage authored mail");
  await Effect.runPromise(first.postMail(notice));
  firstDatabase.close();

  const reopenedDatabase = new DatabaseSync(path);
  const reopened = createPrivateLocalMailRoom(reopenedDatabase, options);
  try {
    if (reopened.postMail === undefined)
      throw new Error("The reopened local mail outbox cannot stage mail");
    await Effect.runPromise(reopened.postMail(notice));
    await Effect.runPromise(reopened.drainOutbox());
    await Effect.runPromise(reopened.drainOutbox());
    expect(deliveries).toEqual([notice]);
    expect(await hasPrivateLocalPendingMail(reopenedDatabase)).toBe(false);
  } finally {
    reopenedDatabase.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
            retryable: () => false,
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
    delivery: "followUp",
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
                retryable: () => false,
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
                retryable: () => false,
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
