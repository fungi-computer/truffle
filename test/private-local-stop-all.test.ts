import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { fauxModel } from "@fungi.computer/mule/testing";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { nodeRuntimeHost } from "@fungi.computer/shiitake/node";
import type { RuntimeHost, SessionSnapshot } from "@fungi.computer/shiitake";
import { expect, it } from "vitest";
import { createLocalServiceOwners } from "../src/private-local-service-owner.js";
import { writeFreshStore } from "./fixtures/fresh-store.js";
import { stopAllRuntime } from "./fixtures/stop-all-runtime.js";

it.each(["settles", "times out"])(
  "waits for a RUNNING helper already cancelling: %s",
  async (completion) => {
    await mkdir(".botanical", { recursive: true });
    const root = await mkdtemp(join(process.cwd(), ".botanical/stop-running-"));
    const started = Promise.withResolvers<undefined>();
    const cancellationPersisted = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    const firstStopRead = Promise.withResolvers<SessionSnapshot>();
    let observeStop = false;
    let holdNextCommit = false;
    const failures: unknown[] = [];
    const host = nodeRuntimeHost((cause) => failures.push(cause));
    const model = fauxModel([
      async (_context, options) => {
        started.resolve(undefined);
        const signal = options?.signal;
        if (signal === undefined)
          throw new Error("Expected model abort signal");
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener(
              "abort",
              () => {
                resolve();
              },
              { once: true },
            );
        });
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    ]);
    // Hold the public host commit acknowledgement after cancellation is durable,
    // before Shiitake signals the running model. No queue rows are fabricated.
    const runtime: RuntimeHost = {
      bind: async (input) => {
        const bound = await host.runtime.bind(input);
        return {
          ...bound,
          commit: async (mutation) => {
            const held = holdNextCommit;
            holdNextCommit = false;
            const value = await bound.commit(mutation);
            if (held) {
              cancellationPersisted.resolve(undefined);
              await release.promise;
            }
            return value;
          },
        };
      },
    };
    const openRuntime = stopAllRuntime(
      () => undefined,
      (id) =>
        id === "child" ? { model, runtime, close: host.close } : undefined,
    );
    const owners = createLocalServiceOwners(async (options) => {
      const opened = await openRuntime(options);
      return {
        ...opened,
        getSession: (id) => {
          const session = opened.getSession(id);
          return {
            ...session,
            read: async (input) => {
              const snapshot = await session.read(input);
              if (observeStop && opened.agentId === "child") {
                observeStop = false;
                firstStopRead.resolve(snapshot);
              }
              return snapshot;
            },
          };
        },
      };
    });
    try {
      for (const [id, createdBy] of [
        ["parent", null],
        ["child", "parent"],
      ]) {
        if (id === undefined || id === null || createdBy === undefined)
          throw new Error("Bad fixture");
        const directory = join(root, ".fungi", "agents", id);
        await mkdir(directory, { recursive: true });
        writeFreshStore(join(directory, "agent.sqlite"), id, createdBy);
      }
      const child = await owners.select({
        invocationRoot: root,
        databasePath: join(root, ".fungi/agents/child/agent.sqlite"),
        sessionId: "main",
      });
      await child.session.send("Run until cancelled");
      await started.promise;
      expect((await child.session.read()).activity.queue.state).toBe("running");
      holdNextCommit = true;
      const aborting = child.session.abort();
      await cancellationPersisted.promise;
      const cancelling = await child.session.read();
      expect(cancelling.activity.queue.state).toBe("running");
      expect(cancelling.activity.cancellationRequested).toBe(true);
      expect(cancelling.pending.total).toBe(0);
      let completed = false;
      observeStop = true;
      const cascade = owners
        .stopAll({ invocationRoot: root, agentId: "parent" })
        .then((result) => {
          completed = true;
          return result;
        });
      // Discovery and owner reads may take longer than an arbitrary sleep.
      // Prove stopAll actually observed RUNNING before releasing cancellation.
      const observed = await Promise.race([
        firstStopRead.promise,
        cascade.then(() => {
          throw new Error("Stop-all ended before observing the helper");
        }),
      ]);
      expect(observed.activity.queue.state).toBe("running");
      expect(observed.activity.cancellationRequested).toBe(true);
      const premature = completed;
      if (completion === "settles") {
        release.resolve(undefined);
        await aborting;
      }
      const result = await cascade;
      expect(
        premature,
        "a cancelling helper is not idle or confirmed stopped",
      ).toBe(false);
      if (completion === "settles") {
        expect(result.agents).toEqual([
          { agentId: "child", name: "child", outcome: "stopped" },
          { agentId: "parent", name: "parent", outcome: "idle" },
        ]);
        expect((await child.session.read()).activity.queue.state).toBe("idle");
      } else {
        expect(result.agents).toEqual([
          {
            agentId: "child",
            name: "child",
            outcome: "failed",
            reason:
              "Agent did not answer within 5 seconds; stop is unconfirmed",
          },
          { agentId: "parent", name: "parent", outcome: "idle" },
        ]);
        expect((await child.session.read()).activity.queue.state).toBe(
          "running",
        );
        release.resolve(undefined);
        await aborting;
      }
      expect(failures).toEqual([]);
    } finally {
      release.resolve(undefined);
      await owners.close();
    }
  },
  10_000,
);

it("visits each Agent once in a persisted created_by cycle and leaves unrelated work alone", async () => {
  await mkdir(".botanical", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".botanical/stop-cycle-"));
  const order: string[] = [];
  const owners = createLocalServiceOwners(
    stopAllRuntime((id) => order.push(id)),
  );
  try {
    for (const [id, createdBy] of [
      ["parent", "leaf"],
      ["child", "parent"],
      ["leaf", "child"],
      ["unrelated", null],
    ]) {
      if (id === undefined || id === null || createdBy === undefined)
        throw new Error("Bad fixture");
      const directory = join(root, ".fungi", "agents", id);
      await mkdir(directory, { recursive: true });
      const databasePath = join(directory, "agent.sqlite");
      writeFreshStore(databasePath, id, createdBy);
      const selected = await owners.select({
        invocationRoot: root,
        databasePath,
        sessionId: "main",
      });
      await selected.session.send("Queued work");
    }
    const result = await owners.stopAll({
      invocationRoot: root,
      agentId: "parent",
    });
    expect(order).toEqual(["leaf", "child", "parent"]);
    expect(
      result.agents.map(({ agentId, outcome }) => ({ agentId, outcome })),
    ).toEqual(
      ["leaf", "child", "parent"].map((agentId) => ({
        agentId,
        outcome: "stopped",
      })),
    );
    expect(result.discoveryFailures).toEqual([]);
    const unrelated = await owners.select({
      invocationRoot: root,
      databasePath: join(root, ".fungi/agents/unrelated/agent.sqlite"),
      sessionId: "main",
    });
    expect((await unrelated.session.read()).pending.total).toBe(1);
  } finally {
    await owners.close();
  }
});

it("stops the made-by tree deepest first, retains chats, and can resume an idle helper", async () => {
  await mkdir(".botanical", { recursive: true });
  const root = await mkdtemp(join(process.cwd(), ".botanical/stop-all-"));
  const order: string[] = [];
  let failChild = false;
  const owners = createLocalServiceOwners(
    stopAllRuntime((agentId) => {
      order.push(agentId);
      if (failChild && agentId === "child")
        throw new Error("Child unavailable");
    }),
  );
  try {
    const sessions = new Map<
      string,
      Awaited<ReturnType<typeof owners.select>>
    >();
    for (const [id, creator] of [
      ["parent", null],
      ["child", "parent"],
      ["grandchild", "child"],
      ["idle", "parent"],
      ["unrelated", null],
    ]) {
      if (id === undefined || id === null || creator === undefined)
        throw new Error("Bad fixture");
      const directory = join(root, ".fungi", "agents", id);
      await mkdir(directory, { recursive: true });
      const databasePath = join(directory, "agent.sqlite");
      writeFreshStore(databasePath, id, creator);
      const selected = await owners.select({
        invocationRoot: root,
        databasePath,
        sessionId: "main",
      });
      sessions.set(id, selected);
      if (id !== "idle") await selected.session.send(`Work for ${id}`);
    }
    const result = await owners.stopAll({
      invocationRoot: root,
      agentId: "parent",
    });
    expect(order).toEqual(["grandchild", "child", "parent"]);
    expect(
      result.agents.map(({ agentId, outcome }) => ({ agentId, outcome })),
    ).toEqual([
      { agentId: "grandchild", outcome: "stopped" },
      { agentId: "child", outcome: "stopped" },
      { agentId: "idle", outcome: "idle" },
      { agentId: "parent", outcome: "stopped" },
    ]);
    const child = sessions.get("child");
    if (child === undefined) throw new Error("Missing child");
    expect((await child.session.read()).messages).toHaveLength(1);
    await child.session.send("Resume");
    expect((await child.session.read()).pending.total).toBe(1);
    expect(
      (await sessions.get("unrelated")?.session.read())?.pending.total,
    ).toBe(1);
    await owners.stopAll({ invocationRoot: root, agentId: "parent" });
    expect(order).toEqual(["grandchild", "child", "parent", "child"]);
    await child.session.send("Try again");
    failChild = true;
    const partial = await owners.stopAll({
      invocationRoot: root,
      agentId: "parent",
    });
    expect(partial.agents.find(({ agentId }) => agentId === "child")).toEqual({
      agentId: "child",
      name: "child",
      outcome: "failed",
      reason: "Child unavailable",
    });
    expect(
      partial.agents.find(({ agentId }) => agentId === "parent")?.outcome,
    ).toBe("idle");
    failChild = false;
    const parent = sessions.get("parent");
    const grandchild = sessions.get("grandchild");
    if (parent === undefined || grandchild === undefined)
      throw new Error("Missing tree");
    await parent.session.send("Parent keeps working");
    await grandchild.session.send("Leaf work");
    order.length = 0;
    await owners.stopAll({ invocationRoot: root, agentId: "child" });
    expect(order).toEqual(["grandchild", "child"]);
    expect((await parent.session.read()).pending.total).toBe(1);
  } finally {
    await owners.close();
  }
});
