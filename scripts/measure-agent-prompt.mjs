// Measure what a default Agent sends to its model before its first turn: the
// assembled system prompt and the tool schemas, as the provider receives them.
//
//   pnpm --filter @fungi.computer/truffle measure:agent-prompt
//
// Each Agent is the real assembly (the local host's tools and instruction
// source; the Oyster Agent's own Shiitake options) run once through
// Shiitake's in-memory host with a faux model that records its first request.
// Tokens are approximate: UTF-8 bytes / 4, a stable yardstick, not a tokenizer.
import console from "node:console";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TextEncoder } from "node:util";
import { pathToFileURL } from "node:url";
import { getSystemMessageText } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { fauxModel } from "@fungi.computer/mule/testing";
import { fromNodeSqlite } from "@fungi.computer/watchdog/node-sqlite";
import { memoryHost } from "@fungi.computer/shiitake/testing";

const utf8 = new TextEncoder();
const bytesOf = (text) => utf8.encode(text).byteLength;
const approximateTokens = (bytes) => Math.ceil(bytes / 4);

/** Run one prompt through the assembled Agent and return its first model request. */
async function firstRequest(agent, options) {
  let first;
  const faux = fauxModel([
    (context) => {
      first ??= JSON.parse(JSON.stringify(context));
      return fauxAssistantMessage("done");
    },
  ]);
  const host = await memoryHost({
    ...options,
    model: {
      acquire: () =>
        Promise.resolve({
          model: faux.model,
          retryable: () => false,
          stream: faux.stream,
          release: () => Promise.resolve(),
        }),
    },
  });
  try {
    await host.agent.session("measure").command({
      requestId: "measure",
      type: "prompt",
      text: "hello",
      delivery: "followUp",
    });
    await host.settle("measure");
  } finally {
    await host.close();
  }
  if (first === undefined) throw new Error(`${agent}: no model request`);
  return first;
}

/** Size the system prompt and tool schemas of one Agent's first request. */
async function measure(agent, options) {
  const request = await firstRequest(agent, options);
  const system = request.messages.find((message) => message.role === "system");
  if (system?.role !== "system") throw new Error(`${agent}: no system message`);
  const systemText = getSystemMessageText(system);
  const systemPromptBytes = bytesOf(systemText);
  // The instructions, then one section per `[extension:<id>]` header.
  const sections = systemText.split(/\n\n(?=\[extension:)/u).map((text) => ({
    name: /^\[extension:([^\]]+)\]/u.exec(text)?.[1] ?? "instructions",
    bytes: bytesOf(text),
  }));
  // Pi normalizes a request's tool declarations onto its system message.
  const tools = system.toolsAdded ?? [];
  const toolSchemaBytes = bytesOf(JSON.stringify(tools));
  const totalBytes = systemPromptBytes + toolSchemaBytes;
  return {
    agent,
    systemPromptBytes,
    sections,
    toolSchemaBytes,
    totalBytes,
    approximateTokens: approximateTokens(totalBytes),
    tools: tools.map((tool) => tool.name),
  };
}

async function localAgent() {
  const root = mkdtempSync(join(tmpdir(), "measure-local-agent-"));
  try {
    const { createPrivateLocalTools, createPrivateLocalInstructionSource } =
      await import("../src/private-local-runtime-host.ts");
    const tools = await createPrivateLocalTools(root);
    return await measure("local", {
      instructions: createPrivateLocalInstructionSource(tools.port),
      extensions: tools.extensions,
      tools: tools.tools,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function oysterAgent() {
  const oysterRoot = join(import.meta.dirname, "../../../packages/oyster");
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (
        specifier === "cloudflare:workers" ||
        specifier === "cloudflare:workflows"
      )
        return {
          url: pathToFileURL(
            join(oysterRoot, "dist/testing/workers-runtime.js"),
          ).href,
          shortCircuit: true,
        };
      return nextResolve(specifier, context);
    },
  });
  const { StandaloneAgent } = await import(
    pathToFileURL(join(oysterRoot, "src/standalone/worker.ts")).href
  );
  hooks.deregister();
  class Measured extends StandaloneAgent {
    options() {
      return this.shiitakeOptions();
    }
  }
  const database = new DatabaseSync(":memory:");
  try {
    const agent = new Measured(
      {
        id: { name: "measure" },
        storage: {
          get: () =>
            Promise.resolve({ directoryName: "agents", tenantId: "default" }),
          sql: fromNodeSqlite(database).sql,
        },
      },
      {
        OYSTER_ORIGIN: "https://oyster.test",
        LOADER: {},
        AGENT_DIRECTORY: {
          getByName: () => ({
            list: () =>
              Promise.resolve([{ agentId: "measure", name: "measure" }]),
            has: () => Promise.resolve(true),
          }),
        },
      },
    );
    // A fresh Oyster Agent has no attached Computer, so no Home Files tools.
    Object.assign(agent, {
      preparedComputerSnapshot: () => Promise.resolve(null),
    });
    const options = await agent.options();
    return await measure("oyster", {
      instructions: options.instructions,
      extensions: options.extensions,
      // Sources fill the catalog behind `execute`, which the model finds with
      // forage; neither the prompt nor any tool schema depends on them.
      tools: { ...options.tools, sources: [] },
    });
  } finally {
    database.close();
  }
}

const results = [await localAgent(), await oysterAgent()];
console.log(JSON.stringify(results, null, 2));
