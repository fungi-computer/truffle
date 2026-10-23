import {
  Mycelium,
  type CapabilitySource,
  type Runtime,
} from "@fungi.computer/mycelium";
import { directSandbox } from "@fungi.computer/mycelium/testing";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { expect, it } from "vitest";
import { z } from "zod";
import { createPrivateFungiMcpConnection } from "../src/private-fungi-mcp-connection.js";
import { mcpFormProducer } from "./fixtures/mcp-form-producer.js";
import type {
  McpFormApprovalRequest,
  RequestMcpFormApproval,
} from "../src/index.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function invoke(runtime: Runtime, signal?: AbortSignal) {
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "form-proof",
        name: "execute",
        arguments: { code: "write" },
      }),
    );
    return await Effect.runPromise(
      Stream.runCollect(prepared.execute()),
      signal === undefined ? undefined : { signal },
    );
  } finally {
    await lease.release();
  }
}

async function fixture(
  requestApproval?: RequestMcpFormApproval,
  afterWrite?: () => Promise<void>,
) {
  const producer = mcpFormProducer(afterWrite);
  const options = {
    ...producer.connection,
    requestApproval,
  };
  const connection = createPrivateFungiMcpConnection(options);
  let disconnect: () => Promise<void> = () =>
    Promise.reject(new Error("No live MCP connection"));
  const source: CapabilitySource = {
    ...connection,
    acquire: async (context) => {
      const acquired = await connection.acquire(context);
      disconnect = acquired.release;
      return acquired;
    },
  };
  const runtime = await Mycelium.make({
    sources: [source],
    sandbox: directSandbox(async (bindings) => {
      const execute = bindings.fungiMcp?.execute;
      if (execute === undefined) throw new Error("Missing MCP door");
      return execute({ code: "write" });
    }),
  });
  return {
    runtime,
    writes: producer.writes,
    disconnect: () => disconnect(),
    close: async () => {
      await runtime.close();
      await producer.close();
    },
  };
}

function mcpResult(parts: Awaited<ReturnType<typeof invoke>>) {
  for (const part of parts) {
    if (part.type !== "result") continue;
    const text = part.result.content.find((item) => item.type === "text");
    if (text === undefined) throw new Error("Missing result text");
    return z
      .looseObject({
        isError: z.boolean(),
        structuredContent: z.json().optional(),
      })
      .parse(JSON.parse(text.text));
  }
  throw new Error("Missing tool result");
}

it("keeps the remote write pending until the human approves the emitted form", async () => {
  const human = deferred<"approve" | "decline" | "cancel">();
  const pending = deferred<McpFormApprovalRequest>();
  const test = await fixture((request) => {
    pending.resolve(request);
    return human.promise;
  });
  try {
    const call = invoke(test.runtime);
    expect(
      await Promise.race([
        pending.promise.then(() => "pending"),
        call.then(() => "settled"),
      ]),
    ).toBe("pending");
    expect(await pending.promise).toEqual({
      message: "Allow app.write (write)?",
      requestedSchema: {
        type: "object",
        properties: {
          approve: { type: "boolean", title: "Approve this operation" },
        },
        required: ["approve"],
      },
    });
    expect(test.writes()).toBe(0);
    human.resolve("approve");
    expect(JSON.stringify(await call)).toContain("saved");
    expect(test.writes()).toBe(1);
  } finally {
    human.resolve("cancel");
    await test.close();
  }
});

it("returns a typed failed tool call when the human declines, not a successful refusal value", async () => {
  const test = await fixture(() => Promise.resolve("decline"));
  try {
    expect(mcpResult(await invoke(test.runtime))).toMatchObject({
      isError: true,
      structuredContent: { kind: "mcp_approval_refused", reason: "declined" },
    });
    expect(test.writes()).toBe(0);
  } finally {
    await test.close();
  }
});

const cancelDecisions: readonly ("cancel" | undefined)[] = [
  "cancel",
  undefined,
];
it.each(cancelDecisions)(
  "fails typed without a write when the human cancels or no human UI exists (%s)",
  async (decision) => {
    const test = await fixture(
      decision === undefined ? undefined : () => Promise.resolve(decision),
    );
    try {
      expect(mcpResult(await invoke(test.runtime))).toMatchObject({
        isError: true,
        structuredContent: {
          kind: "mcp_approval_refused",
          reason: "cancelled",
        },
      });
      expect(test.writes()).toBe(0);
    } finally {
      await test.close();
    }
  },
);

it("disconnect cancels the pending human UI and settles the call typed even if the UI ignores abort", async () => {
  const human = deferred<"approve">();
  const pending = deferred<AbortSignal>();
  const test = await fixture((_request, signal) => {
    pending.resolve(signal);
    return human.promise;
  });
  try {
    const call = invoke(test.runtime);
    const signal = await pending.promise;
    const disconnected = test.disconnect();
    expect(mcpResult(await call)).toMatchObject({
      isError: true,
      structuredContent: { kind: "mcp_approval_refused", reason: "cancelled" },
    });
    expect(signal.aborted).toBe(true);
    human.resolve("approve");
    await disconnected;
    expect(test.writes()).toBe(0);
  } finally {
    human.resolve("approve");
    await test.close();
  }
});

it("keeps opposite human answers on concurrent calls isolated on one connection", async () => {
  const answers = [
    deferred<"approve" | "decline">(),
    deferred<"approve" | "decline">(),
  ];
  const bothPending = deferred<undefined>();
  let asked = 0;
  const test = await fixture(() => {
    const answer = answers[asked++];
    if (answer === undefined) throw new Error("Unexpected third form");
    if (asked === 2) bothPending.resolve(undefined);
    return answer.promise;
  });
  try {
    const calls = [invoke(test.runtime), invoke(test.runtime)];
    await bothPending.promise;
    answers[0]?.resolve("decline");
    answers[1]?.resolve("approve");
    const results = (await Promise.all(calls)).map(mcpResult);
    expect(results.filter((result) => result.isError)).toEqual([
      {
        isError: true,
        content: [{ type: "text", text: "MCP approval was declined." }],
        structuredContent: { kind: "mcp_approval_refused", reason: "declined" },
      },
    ]);
    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(test.writes()).toBe(1);
  } finally {
    for (const answer of answers) answer.resolve("decline");
    await test.close();
  }
});

it("settles a failed human UI as typed cancellation without approving", async () => {
  const test = await fixture(() => Promise.reject(new Error("UI closed")));
  try {
    expect(mcpResult(await invoke(test.runtime))).toMatchObject({
      isError: true,
      structuredContent: { kind: "mcp_approval_refused", reason: "cancelled" },
    });
    expect(test.writes()).toBe(0);
  } finally {
    await test.close();
  }
});

it("decline fails the call without waiting for the remote program after its refused operation", async () => {
  const continued = deferred<undefined>();
  const held = deferred<undefined>();
  const test = await fixture(
    () => Promise.resolve("decline"),
    async () => {
      continued.resolve(undefined);
      await held.promise;
    },
  );
  try {
    const call = invoke(test.runtime);
    expect(
      await Promise.race([
        call.then(() => "failed"),
        continued.promise.then(() => "continued"),
      ]),
    ).toBe("failed");
    expect(mcpResult(await call)).toMatchObject({
      isError: true,
      structuredContent: { kind: "mcp_approval_refused", reason: "declined" },
    });
    expect(test.writes()).toBe(0);
  } finally {
    held.resolve(undefined);
    await test.close();
  }
});
