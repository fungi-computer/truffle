import { fauxModel } from "@fungi.computer/mule/testing";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { Context } from "@earendil-works/pi-ai";
import { Shiitake } from "@fungi.computer/shiitake";
import { expect, it } from "vitest";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";
import { createPrivateLocalRuntimeHost } from "../src/private-local-runtime-host.js";

it("answers a real Local workerd Ask through the public Session while execute waits", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-ask-"));
  const database = new DatabaseSync(join(root, "agent.sqlite"));
  // Executing the native sandbox requires its built worker bundle.
  const { createPrivateLocalTools } =
    await import("../dist/private-local-runtime-host.js");
  const tools = await createPrivateLocalTools(root);
  const faux = fauxModel([]);
  const resumed: Context[] = [];
  faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("execute", {
        code: `return await question.ask(${JSON.stringify({
          questions: [
            {
              id: "storage",
              header: "Storage",
              question: "Where should notes live?",
              options: [
                { label: "Local", description: "Keep notes here." },
                { label: "Shared", description: "Share the notes." },
              ],
            },
          ],
        })})`,
      }),
      { stopReason: "toolUse" },
    ),
    (context) => {
      resumed.push(structuredClone(context));
      return fauxAssistantMessage("Answer received.");
    },
  ]);
  const agent = await Shiitake.make({
    store: createPrivateSqliteOwner(database),
    runtime: createPrivateLocalRuntimeHost(),
    extensions: tools.extensions,
    instructions: {
      load: () => Promise.resolve({ revision: "ask-proof", text: "Ask once." }),
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
    tools: tools.tools,
  });
  const session = agent.session("questions");
  try {
    expect(tools.tools.execution?.timeoutMs).toBe(900_000);
    await session.send("Choose storage", {
      requestId: "local-ask",
      delivery: "followUp",
    });
    await expect
      .poll(async () => (await session.read()).attention, { timeout: 20_000 })
      .toMatchObject([
        { extensionId: "botanical-session-question", kind: "question" },
      ]);
    const before = await session.read();
    expect(before.extensions["botanical-session-question"]).toMatchObject({
      value: { asks: [{ status: "live" }] },
    });
    expect(resumed).toEqual([]);
    const askId = before.attention[0]?.id;
    if (askId === undefined) throw new Error("Expected live Ask");
    expect(
      await session.extension("botanical-session-question").call("answer", {
        askId,
        requestId: "local-answer",
        answers: { storage: { selected: ["Local"] } },
      }),
    ).toEqual({ result: "accepted", via: "in_turn" });
    await expect.poll(() => resumed.length, { timeout: 10_000 }).toBe(1);
    expect(resumed[0]?.messages).toContainEqual(
      expect.objectContaining({
        role: "toolResult",
        isError: false,
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "answered",
              answers: { storage: { selected: ["Local"] } },
            }),
          },
        ],
      }),
    );
    const after = await session.read();
    expect(after.attention).toEqual([]);
    expect(after.pending.prompts).toEqual([]);
    expect(
      after.messages.filter(({ value }) => value.role === "user"),
    ).toHaveLength(1);
  } finally {
    await agent.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
