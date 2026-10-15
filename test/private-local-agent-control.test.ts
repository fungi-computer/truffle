import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fixtureEffectiveModel,
  fixtureMailControls,
  fixtureModelControls,
} from "./fixtures/effective-model.js";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { Mycelium } from "@fungi.computer/mycelium";
import { Shiitake, type ShiitakeAgent } from "@fungi.computer/shiitake";
import {
  type AgentControlDirectory,
  waitForAgentTerminal,
} from "@fungi.computer/shiitake/agent-control";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import {
  createLocalServiceOwners,
  type OpenLocalServiceRuntime,
} from "../src/private-local-service-owner.js";
import {
  createPrivateLocalRuntimeHost,
  resolvePrivateLocalCreateStore,
} from "../src/private-local-runtime-host.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "fungi-local-agent-control-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createBuiltPrivateLocalTools(
  invocationRoot: string,
  agentControl: AgentControlDirectory,
) {
  const { createPrivateLocalTools } =
    await import("../dist/private-local-runtime-host.js");
  return createPrivateLocalTools(invocationRoot, undefined, agentControl);
}

async function executeSource(
  runtime: Awaited<ReturnType<typeof Mycelium.make>>,
  code: string,
) {
  const lease = await runtime.acquire();
  try {
    const prepared = await Effect.runPromise(
      lease.executeTool.prepare({
        type: "toolCall",
        id: "local-agent-control",
        name: "execute",
        arguments: { code },
      }),
    );
    const parts = await Effect.runPromise(
      Stream.runCollect(prepared.execute()),
    );
    const result = parts[0]?.result;
    if (result === undefined || result.content[0]?.type !== "text")
      throw new Error("Missing Mycelium result");
    if (result.isError)
      throw new Error(`Mycelium source failed: ${result.content[0].text}`);
    return z.json().parse(JSON.parse(result.content[0].text));
  } finally {
    await lease.release();
  }
}

const acceptedSchema = z.strictObject({
  status: z.literal("accepted"),
  commandId: z.string().min(1),
});
const terminalSchema = z.strictObject({
  commandId: z.string().min(1),
  outcome: z.enum(["completed", "cancelled", "failed", "interrupted"]),
  text: z.string().optional(),
  truncated: z.boolean().optional(),
});
const agentsSchema = z.array(
  z.strictObject({ agentId: z.string(), name: z.string() }),
);

it("joins project Agent ownership to real Local Shiitake control", async () => {
  const root = await temporaryDirectory();
  const stores = join(root, ".fungi", "agents");
  const agentPaths = {
    "agent-a": join(stores, "agent-a", "agent.sqlite"),
    "agent-b": join(stores, "agent-b", "agent.sqlite"),
  } as const;
  await Promise.all(
    Object.values(agentPaths).map(async (path) => {
      await mkdir(dirname(path), { recursive: true });
      new DatabaseSync(path).close();
    }),
  );

  const firstAStarted = Promise.withResolvers<undefined>();
  const releaseFirstA = Promise.withResolvers<undefined>();
  const bProgressed = Promise.withResolvers<undefined>();
  const opened = new Map<
    string,
    Readonly<{ database: DatabaseSync; agent: ShiitakeAgent }>
  >();
  let directory: AgentControlDirectory | undefined;
  let reopening = false;

  const openRuntime: OpenLocalServiceRuntime = async (options) => {
    const databasePath =
      options.databasePath ??
      (options.createRequestId === undefined
        ? undefined
        : (
            await resolvePrivateLocalCreateStore(
              options.invocationRoot,
              options.createRequestId,
            )
          ).databasePath);
    if (databasePath === undefined)
      throw new Error("Agent control requires an existing Local store");
    await mkdir(dirname(databasePath), { recursive: true });
    const database = new DatabaseSync(databasePath, { timeout: 0 });
    const runtime = createPrivateLocalRuntimeHost();
    const faux = fauxModel([]);
    if (reopening) {
      faux.setResponses([fauxAssistantMessage("reopened")]);
    } else if (basename(dirname(databasePath)) === "agent-a") {
      faux.setResponses([
        () => fauxAssistantMessage("Seeded"),
        async (_context, streamOptions) => {
          firstAStarted.resolve(undefined);
          await Promise.race([
            releaseFirstA.promise,
            new Promise<void>((resolve) => {
              if (streamOptions?.signal?.aborted === true) resolve();
              else
                streamOptions?.signal?.addEventListener(
                  "abort",
                  () => {
                    resolve();
                  },
                  { once: true },
                );
            }),
          ]);
          return fauxAssistantMessage("A first reply", {
            stopReason: streamOptions?.signal?.aborted ? "aborted" : "stop",
          });
        },
        () => fauxAssistantMessage("A third reply"),
      ]);
    } else {
      faux.setResponses([
        () => {
          bProgressed.resolve(undefined);
          return fauxAssistantMessage("B reply");
        },
      ]);
    }
    directory ??= options.agentControl;
    if (directory === undefined)
      throw new Error("Local opener did not receive Agent control");
    try {
      const localTools = await createBuiltPrivateLocalTools(
        options.invocationRoot,
        directory,
      );
      const agent = await Shiitake.make({
        store: createPrivateSqliteOwner(database),
        extensions: localTools.extensions,
        runtime,
        instructions: {
          load: () =>
            Promise.resolve({
              revision: "local-agent-control-v1",
              text: "Answer.",
            }),
        },
        model: {
          acquire: () =>
            Promise.resolve({
              model: faux.model,
              stream: faux.stream,
              release: () => Promise.resolve(),
            }),
        },
        tools: localTools.tools,
      });
      opened.set(databasePath, { database, agent });
      return {
        databasePath,
        agentId: basename(dirname(databasePath)),
        getSession: (sessionId: string) => agent.session(sessionId),
        listSessions: (after?: string) => agent.listSessions(after),
        createSession: (requestId: string) => agent.createSession(requestId),
        deleteSession: (sessionId: string) => agent.deleteSession(sessionId),
        extensions: agent.extensions,
        bindSessionPath: () => true,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        close: async () => {
          try {
            await agent.close();
          } finally {
            database.close();
          }
        },
      };
    } catch (cause) {
      database.close();
      throw cause;
    }
  };
  const owners = createLocalServiceOwners(openRuntime);
  let selectedAgentId: string | undefined;

  try {
    const selectedHost = await owners.select({
      invocationRoot: root,
      databasePath: agentPaths["agent-a"],
      sessionId: "main",
    });
    selectedAgentId = selectedHost.agentId;
    const selectedA = opened.get(selectedHost.databasePath);
    if (selectedA === undefined || directory === undefined)
      throw new Error("Local Agent opener did not retain Agent A");

    const seedSession = selectedA.agent.session("main");
    const seed = await seedSession.send("Seed the Session", {
      delivery: "followUp",
      requestId: "local-seed",
    });
    await waitForAgentTerminal(
      seedSession,
      seed.commandId,
      5_000,
      new AbortController().signal,
    );

    const localTools = await createBuiltPrivateLocalTools(root, directory);
    if (localTools.tools.sources === undefined)
      throw new Error("Local tools did not compose Agent control");
    const runtime = await Mycelium.make({
      sources: localTools.tools.sources,
      sandbox: localTools.tools.sandbox,
    });
    try {
      const first = acceptedSchema.parse(
        await executeSource(
          runtime,
          'return agents.send({ agentId: "agent-a", sessionId: "main", text: "A first", delivery: "followUp" })',
        ),
      );
      await firstAStarted.promise;
      const queued = z
        .tuple([acceptedSchema, acceptedSchema])
        .parse(
          await executeSource(
            runtime,
            'const second = await agents.send({ agentId: "agent-a", sessionId: "main", text: "A second", delivery: "followUp" }); const third = await agents.send({ agentId: "agent-a", sessionId: "main", text: "A third", delivery: "followUp" }); return [second, third]',
          ),
        );
      const cancelled = acceptedSchema.parse(
        await executeSource(
          runtime,
          `return agents.cancel({ agentId: "agent-a", sessionId: "main", commandId: ${JSON.stringify(queued[0].commandId)} })`,
        ),
      );
      const b = acceptedSchema.parse(
        await executeSource(
          runtime,
          'return agents.send({ agentId: "agent-b", sessionId: "main", text: "B independent", delivery: "followUp" })',
        ),
      );
      await bProgressed.promise;
      const bTerminal = terminalSchema.parse(
        await executeSource(
          runtime,
          `return agents.wait({ agentId: "agent-b", sessionId: "main", commandId: ${JSON.stringify(b.commandId)}, timeoutMs: 5000 })`,
        ),
      );
      releaseFirstA.resolve(undefined);
      const firstTerminal = terminalSchema.parse(
        await executeSource(
          runtime,
          `return agents.wait({ agentId: "agent-a", sessionId: "main", commandId: ${JSON.stringify(first.commandId)}, timeoutMs: 5000 })`,
        ),
      );
      const cancelledTerminal = terminalSchema.parse(
        await executeSource(
          runtime,
          `return agents.wait({ agentId: "agent-a", sessionId: "main", commandId: ${JSON.stringify(queued[0].commandId)}, timeoutMs: 5000 })`,
        ),
      );
      const thirdTerminal = terminalSchema.parse(
        await executeSource(
          runtime,
          `return agents.wait({ agentId: "agent-a", sessionId: "main", commandId: ${JSON.stringify(queued[1].commandId)}, timeoutMs: 5000 })`,
        ),
      );
      expect(cancelled).toEqual({
        status: "accepted",
        commandId: queued[0].commandId,
      });
      expect(bTerminal).toEqual({
        commandId: b.commandId,
        outcome: "completed",
        text: "B reply",
        truncated: false,
      });
      expect(firstTerminal).toEqual({
        commandId: first.commandId,
        outcome: "completed",
        text: "A first reply",
        truncated: false,
      });
      expect(cancelledTerminal).toEqual({
        commandId: queued[0].commandId,
        outcome: "cancelled",
      });
      expect(thirdTerminal).toEqual({
        commandId: queued[1].commandId,
        outcome: "completed",
        text: "A third reply",
        truncated: false,
      });
      expect(
        agentsSchema.parse(
          await executeSource(runtime, "return agents.list({})"),
        ),
      ).toEqual([
        { agentId: "agent-a", name: "agent-a" },
        { agentId: "agent-b", name: "agent-b" },
      ]);

      const created = z
        .strictObject({
          agent: agentsSchema.element,
          session: z.strictObject({ sessionId: z.string().min(1) }),
          accepted: acceptedSchema,
        })
        .parse(
          await executeSource(
            runtime,
            'const agent = await agents.create({ requestId: "model-agent-create" }); const session = await agents.createSession({ agentId: agent.agentId, requestId: "model-session-create" }); const accepted = await agents.send({ agentId: agent.agentId, sessionId: session.sessionId, text: "Work on the new goal", delivery: "followUp" }); return { agent, session, accepted }',
          ),
        );
      await expect(
        executeSource(
          runtime,
          `return agents.create({ requestId: ${JSON.stringify("é".repeat(200))} })`,
        ),
      ).rejects.toThrow();
      const replayed = z
        .strictObject({
          agent: agentsSchema.element,
          session: z.strictObject({ sessionId: z.string().min(1) }),
        })
        .parse(
          await executeSource(
            runtime,
            'const agent = await agents.create({ requestId: "model-agent-create" }); const session = await agents.createSession({ agentId: agent.agentId, requestId: "model-session-create" }); return { agent, session }',
          ),
        );
      expect(replayed).toEqual({
        agent: created.agent,
        session: created.session,
      });
      expect(
        agentsSchema.parse(
          await executeSource(runtime, "return agents.list({})"),
        ),
      ).toContainEqual(created.agent);
      const childOpened = await directory.open(
        created.agent.agentId,
        new AbortController().signal,
      );
      try {
        expect(created.accepted.commandId).toBeTruthy();
        expect(
          (await childOpened.agent.listSessions()).sessions.map(
            ({ sessionId }) => sessionId,
          ),
        ).toContain(created.session.sessionId);
      } finally {
        await childOpened.release();
      }
      const childStore = await resolvePrivateLocalCreateStore(
        await realpath(root),
        "model-agent-create",
      );
      const selectedChild = await owners.select({
        invocationRoot: root,
        databasePath: childStore.databasePath,
        sessionId: created.session.sessionId,
      });
      expect(selectedChild.session.address).toContain(
        `/sessions/${created.session.sessionId}`,
      );
    } finally {
      releaseFirstA.resolve(undefined);
      await runtime.close();
    }
  } finally {
    releaseFirstA.resolve(undefined);
    await owners.close();
  }

  reopening = true;
  const reopenedOwners = createLocalServiceOwners(openRuntime);
  try {
    const reopened = await reopenedOwners.select({
      invocationRoot: root,
      databasePath: agentPaths["agent-a"],
      sessionId: "main",
    });
    expect(reopened.agentId).toBe(selectedAgentId);
    await expect(reopened.session.read()).resolves.toMatchObject({
      sessionId: "main",
    });
  } finally {
    await reopenedOwners.close();
  }
}, 30_000);
