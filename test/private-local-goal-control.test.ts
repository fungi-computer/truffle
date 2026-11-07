import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Mycelium } from "@fungi.computer/mycelium";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import { createNativeSqliteOwnerFixture } from "../../../packages/shiitake/test/fixtures/native-sqlite-owner.fixture.js";
import { createPrivateLocalAgentControl } from "../src/private-local-agent-control.js";

it("Local goal control binds both identities and refuses missing provenance", async () => {
  const store = createNativeSqliteOwnerFixture();
  const calls: unknown[] = [];
  const control = createPrivateLocalAgentControl({
    agentId: "shiitake",
    storage: store.owner,
    directory: {
      list: () => Promise.resolve([]),
      open: () => Promise.reject(new Error("unused")),
      create: () => Promise.reject(new Error("unused")),
      answer: () => Promise.resolve({ status: "not_found" }),
      escalate: () => Promise.resolve({ status: "not_found" }),
      archive: () => Promise.resolve(),
      unarchive: () => Promise.resolve(),
      goal: (input, agentId, sessionId) => {
        calls.push({ input, agentId, sessionId });
        return Promise.resolve({ status: "paused" });
      },
    },
  });
  const input = {
    agentId: "sol",
    sessionId: "child",
    action: "pause" as const,
    reason: "Review",
  };
  try {
    expect(
      await control.directory.goal?.(
        input,
        "forged",
        new AbortController().signal,
      ),
    ).toEqual({ status: "refused", reason: "no_provenance" });
    const runtime = await Mycelium.make({
      sources: [control.control],
      session: { sessionId: "exact-parent" },
      sandbox: directSandbox(async ({ agents }) => {
        if (agents?.goal === undefined) throw new Error("Missing goal");
        return agents.goal(input);
      }),
    });
    const lease = await runtime.acquire();
    try {
      const prepared = await Effect.runPromise(
        lease.executeTool.prepare({
          type: "toolCall",
          id: "control",
          name: "execute",
          arguments: {
            code: "return agents.goal({agentId:'sol',sessionId:'child',action:'pause',reason:'Review'})",
          },
        }),
      );
      await Effect.runPromise(Stream.runCollect(prepared.execute()));
      expect(calls).toEqual([
        { input, agentId: "shiitake", sessionId: "exact-parent" },
      ]);
    } finally {
      await lease.release();
      await runtime.close();
    }
  } finally {
    store.close();
  }
});
