import { fauxModel } from "@fungi.computer/mule/testing";
import {
  access,
  mkdir,
  mkdtemp,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  execFile as execFileCallback,
  spawn,
  type ChildProcess,
} from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import {
  createModels,
  getSystemMessageText,
  hasApi,
  normalizeContext,
  registerSessionResourceCleanup,
  type Context,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { createLocalSkillSource } from "../src/local-skill-source.js";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { Shiitake } from "@fungi.computer/shiitake";
import { bindSessionExtension } from "@fungi.computer/shiitake/client";
import { goalContract } from "@fungi.computer/shiitake-extensions/goal";
import { loopContract } from "@fungi.computer/shiitake-extensions/loop";
import { createPrivateModels } from "../src/local-models.js";
import { createPrivateCredentialStore } from "../src/private-file-credential-store.js";
import { createPrivateInvocationFilesPort } from "../src/private-invocation-files.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";
import { acquireNodeStoreLease } from "@fungi.computer/shiitake/node";
import {
  closePrivateLocalResources,
  createPrivateLocalInstructionSource,
  createPrivateLocalTools,
  createPrivateLocalModelSource,
  createPrivateLocalRuntimeHost,
  openPrivateLocalRuntimeHost,
} from "../src/private-local-runtime-host.js";
import { Mycelium } from "@fungi.computer/mycelium";

const temporaryDirectories: string[] = [];
const execFile = promisify(execFileCallback);
const nativeFetch = globalThis.fetch;

afterEach(async () => {
  vi.stubGlobal("fetch", nativeFetch);
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(label: string) {
  const directory = await mkdtemp(join(tmpdir(), `fungi-local-host-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function immediate() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  attempts = 40,
) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await immediate();
  }
  throw new Error(message);
}

function createExistingDatabase(root: string) {
  const path = join(root, "agent.sqlite");
  new DatabaseSync(path).close();
  return path;
}

async function expectPresent(path: string) {
  await expect(access(path)).resolves.toBeUndefined();
}

function waitForChildOutput(child: ChildProcess, expected: string) {
  return new Promise<void>((resolveOutput, reject) => {
    let stdout = "";
    let stderr = "";
    const inspectOutput = (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.includes(expected)) resolveOutput();
    };
    child.stdout?.on("data", inspectOutput);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (stdout.includes(expected)) return;
      reject(
        new Error(
          `Local host holder exited before reporting ${JSON.stringify(expected)}: code=${String(code)} signal=${String(signal)} stderr=${stderr || "<empty>"}`,
        ),
      );
    });
  });
}

function waitForChildExit(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null)
    return Promise.resolve();
  return once(child, "exit").then(() => undefined);
}

async function createBuiltPrivateLocalTools(
  root: string,
  sessionPath?: (sessionId: string) => string | undefined,
) {
  const { createPrivateLocalTools } =
    await import("../dist/private-local-runtime-host.js");
  return createPrivateLocalTools(root, undefined, undefined, sessionPath);
}

it("reserves a fifteen-minute sandbox budget for bounded local commands", async () => {
  const tools = await createPrivateLocalTools(
    await temporaryDirectory("long-command-budget"),
  );
  expect(tools.tools.execution).toEqual({ timeoutMs: 900_000 });
});

it("publishes each granted tool root and its path convention through discovery", async () => {
  const root = join(
    resolve(await temporaryDirectory("tool-root-discovery")),
    "nested-project-".repeat(12),
  );
  await mkdir(root);
  const tools = await createPrivateLocalTools(root);
  const runtime = await Mycelium.make({
    ...tools.tools,
  });
  const lease = await runtime.acquire();
  try {
    const files = lease.catalog.describe({
      path: "computers.local.files.read",
    });
    const computer = lease.catalog.describe({
      path: "computers.local.exec",
    });
    expect(files.kind).toBe("operation");
    expect(() => lease.catalog.describe({ path: "files.read" })).toThrow(
      "Unknown target: files.read",
    );
    expect(files.description).toContain(`Files root: ${root}`);
    expect(files.description).toContain(
      "Relative paths resolve from this root; absolute paths must remain inside it.",
    );
    expect(computer.kind).toBe("operation");
    expect(computer.description).toContain(`Computer root: ${root}`);
    expect(computer.description).toContain(
      "cwd must be absolute and remain inside this root; omission starts at the root.",
    );
  } finally {
    await lease.release();
    await runtime.close();
  }
});

it("publishes and executes the local Computer under its explicit namespace", async () => {
  const root = resolve(await temporaryDirectory("home-alias"));
  // Actually executing code through the real workerd sandbox (below) needs
  // the built sandbox worker bundle, like the other executing tests in this
  // file; catalog.describe-only tests can use the source-imported tools.
  const tools = await createBuiltPrivateLocalTools(root);
  const runtime = await Mycelium.make({
    ...tools.tools,
  });
  const lease = await runtime.acquire();
  try {
    const computer = lease.catalog.describe({ path: "computers.local.exec" });
    expect(computer.kind).toBe("operation");
    expect(computer.types).toContain("command");
    // The direct form's fields are part of the one published input contract,
    // not a second operation or a hidden shape the model cannot discover.
    expect(computer.types).toContain("executable");
    expect(computer.types).toContain("args");
    expect(computer.types).toContain("stdin");
    expect(() => lease.catalog.describe({ path: "home.exec" })).toThrow(
      "Unknown target: home.exec",
    );
    const module = lease.catalog.describe({ path: "computers.local" });
    expect(module.kind).toBe("module");
    expect(module.description).toContain('Computer "local"');
    expect(module.description).not.toContain("(home)");

    expect(
      lease.catalog.search({ query: "local" }).results.map(({ path }) => path),
    ).toEqual(expect.arrayContaining(["computers.local.exec"]));

    const result = await executeComposedTools(
      lease,
      `return await env.computers.local.exec(${JSON.stringify({ command: "printf via-home" })})`,
    );
    expect(result).toMatchObject({ status: "completed", stdout: "via-home" });

    // The required real-consumer proof: the brief's literal call shape,
    // through the real host tools and the real workerd sandbox, not a
    // test-only Knapsack wiring.
    const directScript = 'import sys\nprint("real-host-direct-ok")\n';
    const direct = await executeComposedTools(
      lease,
      `return await env.computers.local.exec(${JSON.stringify({
        executable: "python3",
        args: ["-"],
        stdin: directScript,
      })})`,
    );
    expect(direct).toMatchObject({
      status: "completed",
      exitCode: 0,
      stdout: "real-host-direct-ok\n",
    });
  } finally {
    await lease.release();
    await runtime.close();
  }
});

it("starts and observes a background process through the local Computer", async () => {
  const root = resolve(await temporaryDirectory("home-alias-processes"));
  const tools = await createBuiltPrivateLocalTools(root);
  const runtime = await Mycelium.make({
    ...tools.tools,
  });
  const lease = await runtime.acquire();
  try {
    const started = z
      .object({ process: z.object({ id: z.string() }) })
      .parse(
        await executeComposedTools(
          lease,
          `return await env.computers.local.exec(${JSON.stringify({ operation: "start", command: "sleep 5" })})`,
        ),
      );

    const observed = await executeComposedTools(
      lease,
      `return await env.computers.local.exec(${JSON.stringify({ operation: "poll", id: started.process.id })})`,
    );
    expect(observed).toMatchObject({
      process: { id: started.process.id, state: "running" },
    });
    const listed = await executeComposedTools(
      lease,
      'return await env.computers.local.exec({operation:"list"})',
    );
    expect(listed).toMatchObject({
      processes: [expect.objectContaining({ id: started.process.id })],
    });

    await executeComposedTools(
      lease,
      `return await env.computers.local.exec(${JSON.stringify({ operation: "kill", id: started.process.id })})`,
    );
  } finally {
    await lease.release();
    await runtime.close();
    await tools.processes.close();
  }
});

const executionResultSchema = z.tuple([
  z.object({
    type: z.literal("result"),
    result: z.object({
      content: z.tuple([
        z.object({ type: z.literal("text"), text: z.string() }),
      ]),
    }),
  }),
]);
const composedToolResultSchema = z.object({
  file: z.object({ content: z.string(), path: z.string() }),
  git: z.object({
    exitCode: z.number().int(),
    status: z.literal("completed"),
    stdout: z.string(),
    truncated: z.literal(false),
  }),
});

async function executeComposedTools(
  lease: Awaited<
    ReturnType<Awaited<ReturnType<typeof Mycelium.make>>["acquire"]>
  >,
  code: string,
) {
  const parts: unknown[] = [];
  const prepared = await Effect.runPromise(
    lease.executeTool.prepare({
      type: "toolCall",
      id: "local-host-composition",
      name: "execute",
      arguments: { code },
    }),
  );
  await Effect.runPromise(
    Stream.runForEach(prepared.execute(), (part) =>
      Effect.sync(() => parts.push(part)),
    ),
  );
  const [part] = executionResultSchema.parse(parts);
  return z.json().parse(JSON.parse(part.result.content[0].text));
}

function expectSidecarLocked(path: string) {
  const contender = new DatabaseSync(path, { timeout: 0 });
  try {
    contender.exec("PRAGMA busy_timeout = 0");
    expect(() => {
      contender.exec("BEGIN EXCLUSIVE");
    }).toThrow(/database is locked/u);
  } finally {
    contender.close();
  }
}

describe("private local RuntimeHost", () => {
  it("refuses a runnable model when no local provider is signed in", async () => {
    const root = await temporaryDirectory("new-agent-model-default");
    const models = createPrivateModels(join(root, "credentials.json"));
    const host = await openPrivateLocalRuntimeHost(
      { invocationRoot: root, modelSettingsPath: join(root, "shiitake.json") },
      models,
    );
    try {
      await expect(
        host.effectiveModel("main", new AbortController().signal),
      ).rejects.toThrow("No signed-in model provider is available. Run /login");
    } finally {
      await host.close();
    }
  });

  it("keeps fresh and resumed project-local sessions out of Git status", async () => {
    const root = await temporaryDirectory("git-local-store");
    await execFile("git", ["init", "-q", root]);
    const first = await openPrivateLocalRuntimeHost({ invocationRoot: root });
    const databasePath = first.databasePath;
    await first.close();
    expect(
      (await execFile("git", ["-C", root, "status", "--short"])).stdout,
    ).toBe("");
    const resumed = await openPrivateLocalRuntimeHost({
      invocationRoot: root,
      databasePath,
    });
    await expect(resumed.session.read()).resolves.toBeDefined();
    await resumed.close();
    expect(
      (await execFile("git", ["-C", root, "status", "--short"])).stdout,
    ).toBe("");
    await expect(access(join(root, ".gitignore"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("scopes provider resources to the canonical saved Agent across reopen", async () => {
    const root = await temporaryDirectory("provider-scope");
    const databasePath = createExistingDatabase(root);
    const alias = join(root, "alias.sqlite");
    await symlink(databasePath, alias);
    const closed: (string | undefined)[] = [];
    const unregister = registerSessionResourceCleanup((id) => closed.push(id));
    try {
      for (const selected of [databasePath, alias, undefined]) {
        const host = await openPrivateLocalRuntimeHost({
          invocationRoot: root,
          databasePath: selected,
        });
        const before = closed.length;
        await expect(
          openPrivateLocalRuntimeHost({
            invocationRoot: root,
            databasePath: host.databasePath,
          }),
        ).rejects.toThrow(/database is locked/u);
        expect(closed).toHaveLength(before);
        await host.close();
        await host.close();
      }
      expect(closed).toHaveLength(3);
      expect(closed[0]).toMatch(/^[a-f0-9]{64}$/u);
      expect(closed[1]).toBe(closed[0]);
      expect(closed[2]).not.toBe(closed[0]);
    } finally {
      unregister();
    }
  });

  it.each(["gpt-5.6-sol", "gpt-6-sol", "gpt-6-luna", "gpt-6-astra"])(
    "passes %s with stable cache identity and automatic continuation to maintained Pi requests",
    async (modelId) => {
      const root = await temporaryDirectory("provider-requests");
      const models = createPrivateModels(join(root, "credentials.json"));
      const token = [
        "synthetic",
        Buffer.from(
          JSON.stringify({
            "https://api.openai.com/auth": {
              chatgpt_account_id: "synthetic-account",
            },
          }),
        ).toString("base64url"),
        "synthetic",
      ].join(".");
      await createPrivateCredentialStore(join(root, "credentials.json")).modify(
        "openai",
        () =>
          Promise.resolve({
            type: "oauth",
            access: token,
            refresh: "synthetic-refresh",
            expires: Date.now() + 24 * 60 * 60_000,
            accountId: "synthetic-account",
          }),
      );
      const observed: SimpleStreamOptions[] = [];
      const acquireSignals: AbortSignal[] = [];
      const streamSignal = new AbortController().signal;
      vi.stubGlobal("fetch", () =>
        Promise.reject(new Error("Network forbidden in offline request test")),
      );
      const requests: {
        model: string;
        headers: Headers;
        cacheKey?: string | undefined;
        reasoningEffort?: string | undefined;
      }[] = [];
      const provider = openaiProvider();
      models.setProvider({
        ...provider,
        streamSimple: (model, context, options) => {
          observed.push(options ?? {});
          if (!hasApi(model, "openai-responses"))
            throw new Error("Wrong test provider");
          // Capture the actual provider request offline; no socket or live auth.
          return provider.streamSimple(model, context, {
            ...options,
            apiKey: token,
            transport: "sse",
            fetch: Object.assign(
              (
                _url: Parameters<typeof fetch>[0],
                init: Parameters<typeof fetch>[1],
              ) => {
                const headers = new Headers(init?.headers);
                const body = z
                  .union([z.string(), z.instanceof(Uint8Array)])
                  .parse(init?.body);
                const text =
                  body instanceof Uint8Array
                    ? zstdDecompressSync(body).toString("utf8")
                    : body;
                const decoded = z
                  .object({
                    model: z.string(),
                    prompt_cache_key: z.string().optional(),
                    reasoning: z.object({ effort: z.string() }).optional(),
                  })
                  .parse(JSON.parse(text));
                requests.push({
                  model: decoded.model,
                  headers,
                  cacheKey: decoded.prompt_cache_key,
                  reasoningEffort: decoded.reasoning?.effort,
                });
                return Promise.resolve(
                  new Response("Synthetic offline stop", { status: 400 }),
                );
              },
              {
                preconnect: () => {
                  throw new Error(
                    "Offline provider fixture must not preconnect",
                  );
                },
              },
            ),
          });
        },
      });
      const sources: readonly Readonly<{
        source: ReturnType<typeof createPrivateLocalModelSource>;
        options: SimpleStreamOptions;
      }>[] = [
        {
          source: createPrivateLocalModelSource(
            models,
            "openai",
            modelId,
            "synthetic-provider-default",
          ),
          options: {},
        },
        {
          source: createPrivateLocalModelSource(
            models,
            "openai",
            modelId,
            "synthetic-owner-session",
            "low",
          ),
          options: {},
        },
        {
          source: createPrivateLocalModelSource(
            models,
            "openai",
            modelId,
            "synthetic-owner-session",
            "low",
          ),
          options: {
            reasoning: "high",
            cacheRetention: "none",
            transport: "sse",
            maxTokens: 777,
            signal: streamSignal,
          },
        },
      ];
      for (const { source, options } of sources) {
        const acquireSignal = new AbortController().signal;
        acquireSignals.push(acquireSignal);
        const acquisition = await source.acquire({
          sessionId: "main",
          preference: null,
          signal: acquireSignal,
        });
        if (acquisition.stream === undefined)
          throw new Error("Missing local stream");
        const stream = await acquisition.stream(
          acquisition.model,
          normalizeContext({
            messages: [
              { role: "user", content: "Synthetic only", timestamp: 0 },
            ],
          }),
          options,
        );
        const result = await stream.result();
        expect(result.stopReason).toBe("error");
        expect(result.errorMessage).toBe(
          "openai rejected the model request. Check /login or choose another model with /model.",
        );
        await acquisition.release();
      }
      expect(observed.map((options) => options.transport)).toEqual([
        "auto",
        "auto",
        "sse",
      ]);
      expect(observed[2]?.maxTokens).toBe(777);
      expect(observed[2]?.signal).toBe(streamSignal);
      expect(observed[2]?.signal).not.toBe(acquireSignals[2]);
      expect(requests.map((request) => request.model)).toEqual([
        modelId,
        modelId,
        modelId,
      ]);
      expect(requests.map((request) => request.cacheKey)).toEqual([
        "synthetic-provider-default",
        "synthetic-owner-session",
        undefined,
      ]);
      expect(requests.map((request) => request.reasoningEffort)).toEqual([
        "medium",
        "low",
        "high",
      ]);
      expect(
        requests.map((request) => request.headers.get("session_id")),
      ).toEqual([
        "synthetic-provider-default",
        "synthetic-owner-session",
        null,
      ]);
      expect(
        requests.map((request) => request.headers.get("x-client-request-id")),
      ).toEqual([
        "synthetic-provider-default",
        "synthetic-owner-session",
        null,
      ]);
      expect(
        requests.map((request) => request.headers.get("originator")),
      ).toEqual([null, null, null]);
    },
  );

  it("defers startup reconciliation, coalesces active wakes, and closes once", async () => {
    const runtime = createPrivateLocalRuntimeHost();
    const firstRun = Promise.withResolvers<undefined>();
    let reconciliations = 0;
    const handle = await runtime.bind({
      pendingWork: () => Promise.resolve({ pending: false, nextWakeAt: null }),
      reconcile: () => {
        reconciliations += 1;
        return reconciliations === 1 ? firstRun.promise : Promise.resolve();
      },
    });

    expect(reconciliations).toBe(0);
    await waitFor(
      () => reconciliations === 1,
      "Startup reconciliation did not run after bind returned",
    );
    await Promise.all([
      handle.requestWake(),
      handle.requestWake(),
      handle.requestWake(),
    ]);
    firstRun.resolve(undefined);
    await waitFor(
      () => reconciliations === 2,
      "Coalesced wake did not admit one rerun",
    );
    await Promise.all([handle.close(), handle.close()]);
    await expect(handle.requestWake()).rejects.toThrow("runtime is closed");
  });

  it("cancels a pending callback and drains one already-admitted rerun", async () => {
    const pendingRuntime = createPrivateLocalRuntimeHost();
    let pendingCalls = 0;
    const pending = await pendingRuntime.bind({
      pendingWork: () => Promise.resolve({ pending: false, nextWakeAt: null }),
      reconcile: () => {
        pendingCalls += 1;
        return Promise.resolve();
      },
    });
    await pending.close();
    await immediate();
    expect(pendingCalls).toBe(0);

    const runtime = createPrivateLocalRuntimeHost();
    const firstGate = Promise.withResolvers<undefined>();
    const secondGate = Promise.withResolvers<undefined>();
    let activeCalls = 0;
    const active = await runtime.bind({
      pendingWork: () => Promise.resolve({ pending: false, nextWakeAt: null }),
      reconcile: async () => {
        activeCalls += 1;
        if (activeCalls === 1) await firstGate.promise;
        else await secondGate.promise;
      },
    });
    await waitFor(
      () => activeCalls === 1,
      "Active reconciliation did not begin",
    );
    await active.requestWake();
    const providerCloses: (string | undefined)[] = [];
    const unregister = registerSessionResourceCleanup((id) =>
      providerCloses.push(id),
    );
    try {
      let settled = false;
      const closing = closePrivateLocalResources({
        runtime: { runtime, close: active.close },
        providerCacheKey: "held-drain",
      }).then(() => {
        settled = true;
      });
      await immediate();
      expect(settled).toBe(false);
      expect(providerCloses).toEqual([]);
      firstGate.resolve(undefined);
      await waitFor(
        () => activeCalls === 2,
        "An already-admitted wake did not drain during close",
      );
      expect(settled).toBe(false);
      expect(providerCloses).toEqual([]);
      secondGate.resolve(undefined);
      await closing;
      expect(activeCalls).toBe(2);
      expect(providerCloses).toEqual(["held-drain"]);
    } finally {
      firstGate.resolve(undefined);
      secondGate.resolve(undefined);
      await active.close();
      unregister();
    }
  });

  it("rearms pending work after a successful reconciliation and cancels recovery on close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const runtime = createPrivateLocalRuntimeHost();
    let reconciliations = 0;
    let pendingWork = true;
    const handle = await runtime.bind({
      reconcile: () => {
        reconciliations += 1;
        return Promise.resolve();
      },
      pendingWork: () =>
        Promise.resolve({ pending: pendingWork, nextWakeAt: null }),
    });
    try {
      await waitFor(
        () => vi.getTimerCount() === 1,
        "Pending work lost its recovery wake",
      );
      expect(reconciliations).toBe(1);
      pendingWork = false;
      await vi.advanceTimersByTimeAsync(5_000);
      await waitFor(
        () => reconciliations === 2,
        "Pending work was not reconciled again",
      );
      expect(vi.getTimerCount()).toBe(0);

      pendingWork = true;
      await handle.requestWake();
      await waitFor(
        () => vi.getTimerCount() === 1,
        "Later pending work lost its wake",
      );
      await handle.close();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(reconciliations).toBe(3);
    } finally {
      await handle.close();
      vi.useRealTimers();
    }
  });

  it("joins the owner’s next due candidate to the local RuntimeHost wake", async () => {
    // Fake Date too: the wake delay is nextWakeAt - Date.now(), so a real clock
    // drifting a millisecond between arming and advancing fires it early.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const runtime = createPrivateLocalRuntimeHost();
    let nextWakeAt: number | null = Date.now() + 60_000;
    let reconciliations = 0;
    const handle = await runtime.bind({
      reconcile: () => {
        reconciliations += 1;
        if (reconciliations === 4) nextWakeAt = null;
        return Promise.resolve();
      },
      pendingWork: () =>
        Promise.resolve({
          pending: false,
          nextWakeAt,
        }),
    });
    try {
      await waitFor(
        () => reconciliations === 1,
        "Startup reconciliation did not run",
      );
      expect(vi.getTimerCount()).toBe(1);
      nextWakeAt = null;
      await handle.requestWake();
      await waitFor(
        () => reconciliations === 2,
        "Schedule cancellation was not reconciled",
      );
      expect(vi.getTimerCount()).toBe(0);
      nextWakeAt = Date.now() + 60_000;
      await handle.requestWake();
      await waitFor(
        () => reconciliations === 3,
        "Schedule resume was not reconciled",
      );
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(reconciliations).toBe(3);
      await vi.advanceTimersByTimeAsync(1);
      await waitFor(
        () => reconciliations === 4,
        "The due candidate did not wake RuntimeHost",
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await handle.close();
      vi.useRealTimers();
    }
  });

  it("rearms after a failed pending-work read and leaves healthy idle owners quiet", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const diagnostic = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const runtime = createPrivateLocalRuntimeHost();
    let reconciliations = 0;
    const handle = await runtime.bind({
      reconcile: () => {
        reconciliations += 1;
        return Promise.resolve();
      },
      pendingWork: () =>
        reconciliations === 1
          ? Promise.reject(new Error("Pending work is unavailable"))
          : Promise.resolve({ pending: false, nextWakeAt: null }),
    });
    try {
      await waitFor(
        () => vi.getTimerCount() === 1,
        "Failed read lost its recovery wake",
      );
      expect(diagnostic).toHaveBeenCalledWith(
        JSON.stringify({
          source: "local-runtime",
          operation: "shiitake_reconciliation_failed",
          failureKind: "Error",
        }),
        expect.anything(),
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await waitFor(() => reconciliations === 2, "Failed read did not recover");
      expect(vi.getTimerCount()).toBe(0);
      expect(diagnostic).toHaveBeenCalledTimes(1);
    } finally {
      await handle.close();
      diagnostic.mockRestore();
      vi.useRealTimers();
    }
  });

  it("recovers a failed native claim without another prompt or model replay", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const diagnostic = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const database = new DatabaseSync(":memory:");
    const faux = fauxModel([]);
    faux.setResponses([fauxAssistantMessage("Recovered once")]);
    let agent: Awaited<ReturnType<typeof Shiitake.make>> | undefined;
    try {
      agent = await Shiitake.make({
        store: createPrivateSqliteOwner(database),
        extensions: { roster: [], grants: [] },
        runtime: createPrivateLocalRuntimeHost(),
        instructions: {
          load: () =>
            Promise.resolve({ revision: "wake-recovery", text: "Reply once" }),
        },
        model: {
          acquire: () =>
            Promise.resolve({
              model: faux.model,
              stream: faux.stream,
              release: () => Promise.resolve(),
            }),
        },
      });
      await immediate();
      let claimAttempts = 0;
      database.function("observe_claim", () => {
        claimAttempts += 1;
        return 0;
      });
      database.exec(
        "CREATE TRIGGER fail_claim BEFORE UPDATE OF state ON watchdog_jobs WHEN NEW.state = 'running' BEGIN SELECT observe_claim(); SELECT RAISE(ABORT, 'claim unavailable'); END",
      );
      const session = agent.session("wake-recovery");
      const accepted = await session.command({
        requestId: "one-prompt",
        type: "prompt",
        delivery: "followUp",
        text: "Reply once",
      });
      await waitFor(() => claimAttempts > 0, "The native claim did not fail");
      expect(database.prepare("SELECT state FROM watchdog_jobs").all()).toEqual(
        [{ state: "queued" }],
      );
      expect(faux.state.callCount).toBe(0);

      database.exec("DROP TRIGGER fail_claim");
      await vi.advanceTimersByTimeAsync(5_000);
      await waitFor(
        () => faux.state.callCount === 1,
        "Queued work needed another prompt to recover",
      );
      await waitFor(
        () =>
          database
            .prepare(
              "SELECT outcome FROM watchdog_jobs WHERE state = 'settled'",
            )
            .all().length === 1,
        "Recovered work did not settle",
      );
      expect((await session.read()).terminals).toContainEqual(
        expect.objectContaining({
          commandId: accepted.commandId,
          outcome: "completed",
        }),
      );
      await immediate();
      expect(vi.getTimerCount()).toBe(0);
      expect(faux.state.callCount).toBe(1);
      expect(diagnostic).toHaveBeenCalledWith(
        JSON.stringify({
          source: "local-runtime",
          operation: "shiitake_reconciliation_failed",
          failureKind: "Error",
        }),
        expect.anything(),
      );
      // Runtime Core retains the original failure for close, even after recovery.
      await expect(agent.close()).rejects.toThrow(
        "Runtime reconciliation failed",
      );
    } finally {
      await agent?.close();
      database.close();
      diagnostic.mockRestore();
      vi.useRealTimers();
    }
  });

  it("keeps a canonical database sidecar through close and releases failed opens", async () => {
    const root = await temporaryDirectory("sidecar");
    const databasePath = createExistingDatabase(root);
    const first = await openPrivateLocalRuntimeHost({
      invocationRoot: root,
      databasePath,
    });

    await expect(
      openPrivateLocalRuntimeHost({ invocationRoot: root, databasePath }),
    ).rejects.toThrow(/database is locked/u);
    await expectPresent(join(root, "agent.sqlite.owner.sqlite"));
    await first.close();

    await expect(
      openPrivateLocalRuntimeHost({
        invocationRoot: root,
        databasePath,
        providerId: "openai",
        modelId: "not-a-registered-openai-model",
      }),
    ).rejects.toThrow("Local model is not registered");

    const reopened = await openPrivateLocalRuntimeHost({
      invocationRoot: root,
      databasePath,
    });
    await reopened.close();
    await expectPresent(join(root, "agent.sqlite.owner.sqlite"));
  });

  it.each([
    [
      "unmarked",
      "CREATE TABLE woodstock_schema (version INTEGER NOT NULL)",
      "INSERT INTO woodstock_schema (version) VALUES (1)",
    ],
    [
      "non-v0",
      "CREATE TABLE woodstock_schema (version INTEGER NOT NULL, protocol TEXT NOT NULL)",
      "INSERT INTO woodstock_schema (version, protocol) VALUES (1, 'shiitake.extension/v1')",
    ],
  ])(
    "refuses a %s store and leaves its file untouched",
    async (_label, create, insert) => {
      const root = await temporaryDirectory("protocol-refused");
      const databasePath = createExistingDatabase(root);
      const prior = new DatabaseSync(databasePath);
      prior.exec(create);
      prior.exec(insert);
      prior.exec("CREATE TABLE prior_evidence (value TEXT NOT NULL)");
      prior.exec("INSERT INTO prior_evidence (value) VALUES ('kept')");
      prior.close();
      const before = await stat(databasePath);

      await expect(
        openPrivateLocalRuntimeHost({ invocationRoot: root, databasePath }),
      ).rejects.toThrow(/no v0 protocol marker/);

      expect((await stat(databasePath)).ino).toBe(before.ino);
      const retained = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(
          retained.prepare("SELECT value FROM prior_evidence").get(),
        ).toEqual({ value: "kept" });
      } finally {
        retained.close();
      }
      await expect(access(join(root, "agent.pre-v0.sqlite"))).rejects.toThrow();
    },
  );

  it("opens an already marked v0 store without moving its file", async () => {
    const root = await temporaryDirectory("protocol-marked");
    const databasePath = createExistingDatabase(root);
    const marked = new DatabaseSync(databasePath);
    marked.exec(
      "CREATE TABLE woodstock_schema (version INTEGER NOT NULL, protocol TEXT NOT NULL)",
    );
    marked.exec(
      "INSERT INTO woodstock_schema (version, protocol) VALUES (1, 'shiitake.extension/v0')",
    );
    marked.close();
    const before = await stat(databasePath);
    const host = await openPrivateLocalRuntimeHost({
      invocationRoot: root,
      databasePath,
    });
    try {
      expect((await host.session.read()).sessionId).toBe("main");
      expect((await stat(databasePath)).ino).toBe(before.ino);
    } finally {
      await host.close();
    }
  });

  it("keys a sidecar by the exact canonical database filename", async () => {
    const root = await temporaryDirectory("distinct-sidecars");
    const database = createExistingDatabase(root);
    const alternateDatabase = join(root, "agent.db");
    new DatabaseSync(alternateDatabase).close();

    const first = await openPrivateLocalRuntimeHost({
      invocationRoot: root,
      databasePath: database,
    });
    const second = await openPrivateLocalRuntimeHost({
      invocationRoot: root,
      databasePath: alternateDatabase,
    });
    await expectPresent(join(root, "agent.sqlite.owner.sqlite"));
    await expectPresent(join(root, "agent.db.owner.sqlite"));

    await second.close();
    await first.close();
  });

  it("retains the sidecar until runtime and database close are confirmed", async () => {
    const root = await temporaryDirectory("close-failures");
    const sidecarPath = join(root, "agent.sqlite.owner.sqlite");
    const openFailure = new Error("opening failed");
    const agentFailure = new Error("agent close failed");
    const runtimeFailure = new Error("runtime close failed");
    const heldRuntime = acquireNodeStoreLease(sidecarPath);
    let databaseClosed = false;
    let leaseReleased = false;
    const providerCloses: (string | undefined)[] = [];
    const unregister = registerSessionResourceCleanup((id) =>
      providerCloses.push(id),
    );

    try {
      await expect(
        closePrivateLocalResources(
          {
            agent: { close: () => Promise.reject(agentFailure) },
            providerCacheKey: "failed-drain",
            runtime: {
              runtime: createPrivateLocalRuntimeHost(),
              close: () => Promise.reject(runtimeFailure),
            },
            database: {
              close: () => {
                databaseClosed = true;
              },
            },
            lease: {
              release: () => {
                leaseReleased = true;
                heldRuntime.release();
              },
            },
          },
          openFailure,
        ),
      ).rejects.toSatisfy((cause: unknown) => {
        if (!(cause instanceof AggregateError)) return false;
        return (
          cause.errors.includes(openFailure) &&
          cause.errors.includes(agentFailure) &&
          cause.errors.includes(runtimeFailure)
        );
      });
      expect(databaseClosed).toBe(false);
      expect(leaseReleased).toBe(false);
      expect(providerCloses).toEqual([]);
      expectSidecarLocked(sidecarPath);
    } finally {
      heldRuntime.release();
      unregister();
    }

    const heldDatabase = acquireNodeStoreLease(sidecarPath);
    let databaseLeaseReleased = false;
    try {
      await expect(
        closePrivateLocalResources({
          runtime: {
            runtime: createPrivateLocalRuntimeHost(),
            close: () => Promise.resolve(),
          },
          database: {
            close: () => {
              throw new Error("database close failed");
            },
          },
          lease: {
            release: () => {
              databaseLeaseReleased = true;
              heldDatabase.release();
            },
          },
        }),
      ).rejects.toThrow("database close failed");
      expect(databaseLeaseReleased).toBe(false);
      expectSidecarLocked(sidecarPath);
    } finally {
      heldDatabase.release();
    }
  });

  it("releases a crashed holder's native SQLite sidecar for a later host", async () => {
    const root = await temporaryDirectory("crash");
    const databasePath = createExistingDatabase(root);
    const moduleUrl = pathToFileURL(
      resolve("dist/private-local-runtime-host.js"),
    ).href;
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { openPrivateLocalRuntimeHost } from ${JSON.stringify(moduleUrl)}; const host = await openPrivateLocalRuntimeHost(${JSON.stringify({ invocationRoot: root, databasePath })}); process.stdout.write('opened\\n'); setInterval(() => host.session.address, 1_000);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    try {
      await waitForChildOutput(child, "opened\n");
      expectSidecarLocked(join(root, "agent.sqlite.owner.sqlite"));
      expect(child.kill("SIGKILL")).toBe(true);
      await waitForChildExit(child);

      const reopened = await openPrivateLocalRuntimeHost({
        invocationRoot: root,
        databasePath,
      });
      await reopened.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await waitForChildExit(child);
      }
    }
  }, 30_000);

  it("reopens a fresh returned database path without a test runtime runNext helper", async () => {
    const root = await temporaryDirectory("history");
    const first = await openPrivateLocalRuntimeHost({ invocationRoot: root });
    expect(first.databasePath).toMatch(
      /\/\.fungi\/agents\/local_store_[a-z0-9]+\/agent\.sqlite$/u,
    );
    await first.close();

    const database = new DatabaseSync(first.databasePath);
    const faux = fauxModel([]);
    faux.setResponses([fauxAssistantMessage("Fern remembered")]);
    const agent = await Shiitake.make({
      store: createPrivateSqliteOwner(database),
      extensions: { roster: [], grants: [] },
      runtime: createPrivateLocalRuntimeHost(),
      instructions: {
        load: () =>
          Promise.resolve({ revision: "history", text: "Synthetic history" }),
      },
      model: {
        acquire: () =>
          Promise.resolve({
            model: faux.model,
            stream: faux.stream,
            release: () => Promise.resolve(),
          }),
      },
    });
    const session = agent.session("main");
    const watch = await session.watch();
    let acceptedCommandId: string;
    try {
      const accepted = await session.command({
        requestId: "local-history-request",
        text: "remember the local fern",
        type: "prompt",
        delivery: "followUp",
      });
      acceptedCommandId = accepted.commandId;
      for await (const frame of watch.changes) {
        if (frame.kind !== "update") continue;
        const terminal = frame.terminals.find(
          (entry) => entry.commandId === acceptedCommandId,
        );
        if (terminal === undefined) continue;
        expect(terminal.outcome).toBe("completed");
        break;
      }
      const snapshot = await session.read();
      expect(snapshot.messages).toHaveLength(2);
      expect(snapshot.terminals).toContainEqual(
        expect.objectContaining({
          commandId: acceptedCommandId,
          outcome: "completed",
        }),
      );
    } finally {
      await watch.close();
      await agent.close();
      database.close();
    }

    const reopened = await openPrivateLocalRuntimeHost(
      {
        invocationRoot: root,
        databasePath: first.databasePath,
        modelSettingsPath: join(root, "shiitake.json"),
      },
      createPrivateModels(join(root, "credentials.json")),
    );
    try {
      const addressed = reopened.getSession("main");
      expect(addressed.address).toBe(reopened.session.address);
      await expect(
        reopened.effectiveModel("main", new AbortController().signal),
      ).rejects.toThrow("No signed-in model provider is available. Run /login");
      const snapshot = await addressed.read();
      expect(await reopened.session.read()).toEqual(snapshot);
      const other = reopened.getSession("other-conversation");
      expect(other.address).not.toBe(addressed.address);
      await expect(other.read()).resolves.toMatchObject({ messages: [] });
      expect(snapshot.messages).toHaveLength(2);
      expect(snapshot.terminals).toContainEqual(
        expect.objectContaining({
          commandId: acceptedCommandId,
          outcome: "completed",
        }),
      );
      expect(
        snapshot.messages.filter((message) => message.value.role === "user"),
      ).toMatchObject([
        {
          commandId: acceptedCommandId,
          value: { content: "remember the local fern", role: "user" },
        },
      ]);
      expect(faux.state.callCount).toBe(1);
    } finally {
      await reopened.close();
    }
  });

  it("replays one create request to the same Local store and separates other keys", async () => {
    const root = await temporaryDirectory("create-request-identity");
    const first = await openPrivateLocalRuntimeHost({
      invocationRoot: root,
      createRequestId: "retry-after-restart",
    });
    const firstPath = first.databasePath;
    await first.close();

    const replay = await openPrivateLocalRuntimeHost({
      invocationRoot: root,
      createRequestId: "retry-after-restart",
    });
    expect(replay.databasePath).toBe(firstPath);
    const distinct = await openPrivateLocalRuntimeHost({
      invocationRoot: root,
      createRequestId: "different-request",
    });
    expect(distinct.databasePath).not.toBe(firstPath);
    await Promise.all([replay.close(), distinct.close()]);
  });

  it.each(["identity", "create receipt"] as const)(
    "rejects a SQLite BLOB in the stored Local Agent %s",
    async (kind) => {
      const root = await temporaryDirectory("stored-identity-blob");
      const options = { invocationRoot: root, createRequestId: "stored-agent" };
      const first = await openPrivateLocalRuntimeHost(options);
      const databasePath = first.databasePath;
      await first.close();

      const database = new DatabaseSync(
        kind === "identity"
          ? databasePath
          : join(
              root,
              ".fungi",
              "agents",
              "local-agent-create-receipts.sqlite",
            ),
      );
      try {
        const table =
          kind === "identity"
            ? "private_local_identity"
            : "local_agent_create_receipts";
        database
          .prepare(`UPDATE ${table} SET agent_id = ?`)
          .run(Buffer.from("invalid"));
      } finally {
        database.close();
      }

      await expect(openPrivateLocalRuntimeHost(options)).rejects.toThrow(
        kind === "identity"
          ? "Local Agent identity does not match its store"
          : "Local Agent create receipt is invalid",
      );
    },
  );

  it("rejects a preplanted create-store symlink to an outside directory", async () => {
    const root = await temporaryDirectory("create-request-symlink");
    const outside = await temporaryDirectory("create-request-outside");
    const first = await openPrivateLocalRuntimeHost({
      invocationRoot: root,
      createRequestId: "preplanted-symlink",
    });
    const storeDirectory = resolve(first.databasePath, "..");
    await first.close();
    const movedStore = join(root, "moved-store-for-symlink-test");
    await rename(storeDirectory, movedStore);
    await symlink(outside, storeDirectory);

    await expect(
      openPrivateLocalRuntimeHost({
        invocationRoot: root,
        createRequestId: "preplanted-symlink",
      }),
    ).rejects.toThrow("Local Agent create directory is not project owned");
    await expect(access(join(outside, "agent.sqlite"))).rejects.toThrow();
  });

  it("reports an in-use selected store instead of falling through", async () => {
    const root = await temporaryDirectory("selected-in-use");
    const first = await openPrivateLocalRuntimeHost({ invocationRoot: root });
    try {
      await expect(
        openPrivateLocalRuntimeHost({
          invocationRoot: root,
          databasePath: first.databasePath,
        }),
      ).rejects.toThrow(/locked|ownership/iu);
    } finally {
      await first.close();
    }
  });

  it("serves Botanical's goal, loop and Almanac from one Local host", async () => {
    const root = await temporaryDirectory("goal-and-loop");
    const host = await openPrivateLocalRuntimeHost({ invocationRoot: root });
    try {
      const goal = bindSessionExtension(host.session, goalContract);
      const loop = bindSessionExtension(host.session, loopContract);
      const snapshot = await host.session.read();
      expect(goal.view(snapshot)).toEqual({ status: "running", value: null });
      expect(loop.view(snapshot)).toEqual({ status: "running", value: null });
      expect(
        (await host.extensions.list()).map(({ id, status }) => [id, status]),
      ).toEqual([
        ["botanical-almanac", "running"],
        ["botanical-home", "running"],
        ["botanical-session-goal", "running"],
        ["botanical-session-loop", "running"],
        ["botanical-session-plan", "running"],
        ["botanical-session-question", "running"],
        ["botanical-skills", "running"],
      ]);
      await goal.call("set", {
        objective: "Keep the garden tidy",
        expectedRevision: null,
        requestId: "local-goal-and-loop",
      });
      await expect(goal.call("pause", {})).resolves.toMatchObject({
        objective: "Keep the garden tidy",
        state: "paused",
      });
      await expect(
        loop.call("startFixedInterval", {
          prompt: "Check the beds",
          requestId: "local-loop",
          expression: "0 * * * *",
          timeZone: "UTC",
        }),
      ).resolves.toMatchObject({ loop: { state: "active" } });
      const observedLoop = loop.view(await host.session.read());
      expect(observedLoop).toMatchObject({
        status: "running",
        value: {
          loop: { mode: "fixed_interval", state: "active" },
          history: {
            nextSequence: 2,
            omitted: 0,
            events: [
              {
                id: "1",
                sequence: 1,
                event: {
                  loopId: "loop:local-loop",
                  prompt: "Check the beds",
                  mode: "fixed_interval",
                  state: "active",
                  cron: { expression: "0 * * * *", timeZone: "UTC" },
                },
              },
            ],
          },
        },
      });
      if (observedLoop.status !== "running" || observedLoop.value === null)
        throw new Error("Local Loop projection is not available");
      const event = observedLoop.value.history.events[0];
      expect(event?.at).toBeGreaterThan(0);
      expect(event?.commandId).toBeTruthy();
      expect(event?.event).toEqual(observedLoop.value.loop);
      expect(event?.commandId).toBe(observedLoop.value.loop?.commandId);
    } finally {
      await host.close();
    }
  });

  it("runs retained Files and bounded Computer Git through real workerd", async () => {
    const root = await temporaryDirectory("capability-composition");
    await writeFile(join(root, "known.txt"), "known local capability\n");
    const localTools = await createBuiltPrivateLocalTools(root);
    const runtime = await Mycelium.make({
      ...localTools.tools,
    });
    const lease = await runtime.acquire();

    try {
      const result = composedToolResultSchema.parse(
        await executeComposedTools(
          lease,
          `async () => ({ file: await env.computers.local.files.read({ path: "known.txt" }), git: await env.computers.local.exec(${JSON.stringify({ command: "git --version", timeoutMs: 10_000 })}) })`,
        ),
      );
      expect(result).toMatchObject({
        file: { content: "known local capability\n", path: "known.txt" },
        git: { exitCode: 0, status: "completed", truncated: false },
      });
      expect(result.git.stdout).toMatch(/^git version /u);
    } finally {
      await lease.release();
      await runtime.close();
    }
  });

  it("executes each Session's commands with its own selected client PATH", async () => {
    const root = await temporaryDirectory("session-command-path");
    const paths = new Map([
      ["client-a", "/toolchain/a:/usr/bin:/bin"],
      ["client-b", "/toolchain/b:/usr/bin:/bin"],
    ]);
    const localTools = await createBuiltPrivateLocalTools(root, (sessionId) =>
      paths.get(sessionId),
    );
    for (const [sessionId, path] of paths) {
      const runtime = await Mycelium.make({
        ...localTools.tools,
        session: { sessionId },
      });
      const lease = await runtime.acquire();
      try {
        const result = z
          .object({ status: z.literal("completed"), stdout: z.string() })
          .parse(
            await executeComposedTools(
              lease,
              `return await env.computers.local.exec(${JSON.stringify({ command: 'printf %s "$PATH"' })})`,
            ),
          );
        expect(result.stdout).toBe(path);
      } finally {
        await lease.release();
        await runtime.close();
      }
    }
  });

  it("reacquires file and computer operations after a local host stops and resumes", async () => {
    const root = await temporaryDirectory("resume-capabilities");
    await writeFile(join(root, "known.txt"), "resumed capability\n");
    const first = await openPrivateLocalRuntimeHost({ invocationRoot: root });
    const databasePath = first.databasePath;
    await first.close();

    const resumed = await openPrivateLocalRuntimeHost({
      invocationRoot: root,
      databasePath,
    });
    const localTools = await createBuiltPrivateLocalTools(root);
    const runtime = await Mycelium.make({
      ...localTools.tools,
    });
    const lease = await runtime.acquire();
    try {
      expect(lease.catalog.search({ query: "shell" }).results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "computers.local.exec" }),
        ]),
      );
      expect(lease.catalog.search({ query: "git" }).results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "computers.local.exec" }),
        ]),
      );
      expect(lease.catalog.search({ query: "list files" }).results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "computers.local.files.list" }),
        ]),
      );
      const result = composedToolResultSchema.parse(
        await executeComposedTools(
          lease,
          `async () => ({ file: await env.computers.local.files.read({ path: "known.txt" }), git: await env.computers.local.exec(${JSON.stringify({ command: "git --version", timeoutMs: 10_000 })}) })`,
        ),
      );
      expect(result.file.content).toBe("resumed capability\n");
      expect(result.git.status).toBe("completed");
    } finally {
      await lease.release();
      await runtime.close();
      await resumed.close();
    }
  });
});

describe("private local instructions and model selection", () => {
  it("describes the effective saved model and credential from the Local owner", async () => {
    const models = createPrivateModels(
      join(await temporaryDirectory("effective-model"), "credentials.json"),
    );
    const checkAuth = vi.spyOn(models, "checkAuth").mockResolvedValue({
      type: "oauth",
      source: "OpenAI login",
    });
    const source = createPrivateLocalModelSource(
      models,
      "openai",
      "gpt-5.6-sol",
      "synthetic-scope",
    );
    await expect(
      source.effective(
        { providerId: "openai", modelId: "gpt-6-luna" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      agentName: "Shiitake",
      providerId: "openai",
      modelId: "gpt-6-luna",
      credential: { kind: "oauth", source: "OpenAI login" },
      label: "Shiitake · GPT-6 Luna (medium) · OpenAI login",
    });
    await expect(
      source.effective(null, new AbortController().signal),
    ).resolves.toMatchObject({
      modelId: "gpt-5.6-sol",
    });
    checkAuth.mockResolvedValue({ type: "api_key", source: "OPENAI_API_KEY" });
    await expect(
      source.effective(null, new AbortController().signal),
    ).resolves.toMatchObject({
      credential: { kind: "api_key", source: "OPENAI_API_KEY" },
      label: "Shiitake · GPT-5.6 Sol (medium) · OPENAI_API_KEY",
    });
    checkAuth.mockResolvedValue(undefined);
    await expect(
      source.effective(null, new AbortController().signal),
    ).resolves.toMatchObject({
      credential: { kind: "missing", source: "Sign in required" },
      label: "Shiitake · GPT-5.6 Sol (medium) · Sign in required",
    });
  });
  it("captures authored instructions before one present or absent root AGENTS.md", async () => {
    const root = await temporaryDirectory("instructions");
    const source = createPrivateLocalInstructionSource(
      await createPrivateInvocationFilesPort(root),
    );
    const absent = await source.load({
      sessionId: "main",
      commandId: "instruction-1",
      signal: new AbortController().signal,
    });
    expect(absent.text).toContain(
      "After a run fails, each new user message is a new instruction.",
    );
    await writeFile(join(root, "AGENTS.md"), "\uFEFFproject instructions\r\n");
    const present = await source.load({
      sessionId: "main",
      commandId: "instruction-2",
      signal: new AbortController().signal,
    });

    expect(absent.text).toMatch(/^You are the local coding agent\./u);
    expect(present.text).toContain(
      "After a run fails, each new user message is a new instruction.",
    );
    expect(present.text).toContain("\uFEFFproject instructions");
    expect(
      present.text.indexOf("You are the local coding agent."),
    ).toBeLessThan(present.text.indexOf("project instructions"));
    expect(present.revision).not.toBe(absent.revision);
    await writeFile(join(root, "AGENTS.md"), "changed instructions\n");
    const changed = await source.load({
      sessionId: "main",
      commandId: "instruction-3",
      signal: new AbortController().signal,
    });
    expect(changed.revision).not.toBe(present.revision);
  });

  it("keeps skill changes outside the AGENTS instruction revision", async () => {
    const root = await temporaryDirectory("skills-revision");
    const skillRoot = join(root, ".agents", "skills", "local-proof");
    await mkdir(skillRoot, { recursive: true });
    const writeSkill = (description: string) =>
      writeFile(
        join(skillRoot, "SKILL.md"),
        `---\nname: local-proof\ndescription: ${description}\n---\nprivate body\n`,
      );
    await writeSkill("First description");
    const source = createPrivateLocalInstructionSource(
      await createPrivateInvocationFilesPort(root),
    );
    const skills = createLocalSkillSource({ cwd: root, home: root });
    const signal = new AbortController().signal;
    const first = await source.load({
      sessionId: "main",
      commandId: "skill-instructions",
      signal,
    });
    expect(first.text).not.toContain("local-proof");
    expect((await skills.catalog(signal)).skills).toContainEqual(
      expect.objectContaining({ description: "First description" }),
    );
    await writeSkill("Changed description");
    const second = await source.load({
      sessionId: "main",
      commandId: "skill-instructions",
      signal,
    });
    expect(second).toEqual(first);
    expect((await skills.catalog(signal)).skills).toContainEqual(
      expect.objectContaining({ description: "Changed description" }),
    );
  });

  it("puts extension skills in a real local Session and loads through its run door", async () => {
    const root = await temporaryDirectory("session-skills");
    const skillRoot = join(root, ".agents", "skills", "session-proof");
    await mkdir(join(skillRoot, "references"), { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      "---\nname: session-proof\ndescription: Prove the real local Session\n---\nsecret session skill body\n",
    );
    await writeFile(
      join(skillRoot, "references", "REFERENCE.md"),
      "session reference body\n",
    );

    const faux = fauxModel([], { tokenSize: { min: 1, max: 1 } });
    const requests: Context[] = [];
    const modelTurnCompleted = Promise.withResolvers<undefined>();
    faux.setResponses([
      (context) => {
        requests.push(structuredClone(context));
        return fauxAssistantMessage(
          fauxToolCall("execute", {
            code: 'async () => (await skill.load({ name: "session-proof", file: "references/REFERENCE.md" })).content',
          }),
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        requests.push(structuredClone(context));
        modelTurnCompleted.resolve(undefined);
        return fauxAssistantMessage("done");
      },
    ]);

    const database = new DatabaseSync(join(root, "session.sqlite"));
    const runtime = createPrivateLocalRuntimeHost();
    const localTools = await createBuiltPrivateLocalTools(root);
    const agent = await Shiitake.make({
      store: createPrivateSqliteOwner(database),
      extensions: localTools.extensions,
      runtime,
      instructions: createPrivateLocalInstructionSource(localTools.port),
      model: {
        acquire: () => {
          return Promise.resolve({
            model: faux.model,
            stream: faux.stream,
            release: () => Promise.resolve(),
          });
        },
      },
      tools: localTools.tools,
    });
    try {
      await agent.session("main").command({
        requestId: "session-skills-proof",
        type: "prompt",
        text: "Use the captured skill reference.",
        delivery: "followUp",
      });
      await modelTurnCompleted.promise;
      expect(requests).toHaveLength(2);
      const systemMessage = requests[0]?.messages.find(
        (message) => message.role === "system",
      );
      if (systemMessage?.role !== "system")
        throw new Error("Missing normalized system message");
      const systemPrompt = getSystemMessageText(systemMessage);
      expect(systemPrompt).toContain("session-proof");
      expect(systemPrompt).toContain(
        "Extension prompt sections describe the Session's tools",
      );
      expect(systemPrompt).toContain("skill.load({name, file?})");
      expect(systemPrompt).toContain("Prove the real local Session");
      expect(systemPrompt).not.toContain("secret session skill body");
      expect(requests[1]?.messages).toContainEqual(
        expect.objectContaining({
          role: "toolResult",
          content: [{ type: "text", text: '"session reference body\\n"' }],
          isError: false,
        }),
      );
    } finally {
      await agent.close();
      database.close();
    }
  });

  it("keeps oversized, unreadable, and escaping AGENTS.md failures visible", async () => {
    const root = await temporaryDirectory("instruction-errors");
    const source = createPrivateLocalInstructionSource(
      await createPrivateInvocationFilesPort(root),
    );
    await writeFile(join(root, "AGENTS.md"), "x".repeat(128 * 1_024 + 1));
    await expect(
      source.load({
        sessionId: "main",
        commandId: "instruction-4",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("128 KiB instruction bound");
    await writeFile(join(root, "AGENTS.md"), "x".repeat(32_001));
    await expect(
      source.load({
        sessionId: "main",
        commandId: "instruction-5",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("32000-byte snapshot bound");

    await rm(join(root, "AGENTS.md"));
    await mkdir(join(root, "AGENTS.md"));
    await expect(
      source.load({
        sessionId: "main",
        commandId: "instruction-6",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("not a file");
    await rm(join(root, "AGENTS.md"), { recursive: true });
    await writeFile(join(root, "AGENTS.md"), Uint8Array.of(0xff));
    await expect(
      source.load({
        sessionId: "main",
        commandId: "instruction-7",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("not valid UTF-8");
    await rm(join(root, "AGENTS.md"));
    const outside = await temporaryDirectory("outside");
    const outsideAgents = join(outside, "AGENTS.md");
    await writeFile(outsideAgents, "outside");
    await symlink(outsideAgents, join(root, "AGENTS.md"));
    await expect(
      source.load({
        sessionId: "main",
        commandId: "instruction-8",
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("outside the invocation root");
  });

  it("rejects unsupported selected-model reasoning before opening local storage", async () => {
    const folder = await temporaryDirectory("unsupported-reasoning");
    await expect(
      openPrivateLocalRuntimeHost({
        invocationRoot: folder,
        providerId: "openai",
        modelId: "gpt-5.5",
        reasoning: "max",
      }),
    ).rejects.toThrow(
      /Reasoning level max is not supported by openai\/gpt-5.5; supported levels: /u,
    );
    await expect(access(join(folder, ".fungi"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("selects only registered OpenAI models and keeps unconfigured egress visible", async () => {
    const models = createPrivateModels(
      join(await temporaryDirectory("models"), "credentials.json"),
    );
    const source = createPrivateLocalModelSource(
      models,
      "openai",
      "gpt-5.6-sol",
      "synthetic-scope",
    );
    await expect(
      source.acquire({
        sessionId: "main",
        preference: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(
      "openai is not signed in. Run /login or choose another model with /model.",
    );
    await expect(
      source.effective(null, new AbortController().signal),
    ).resolves.toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.6-sol",
      credential: { kind: "missing" },
    });
    await expect(
      createPrivateLocalModelSource(
        models,
        "openai",
        "gpt-5.6-luna",
        "synthetic-scope",
      ).assertReady(null, new AbortController().signal),
    ).rejects.toThrow("openai is not signed in");
    expect(await models.checkAuth("openai")).toBeUndefined();
    expect(() =>
      createPrivateLocalModelSource(
        models,
        "openai",
        "not-a-registered-openai-model",
        "synthetic-scope",
      ),
    ).toThrow("Local model is not registered");
  });

  it("resolves the selected provider when model ids overlap", async () => {
    const models = createModels();
    const alpha = fauxProvider({
      provider: "faux-alpha",
      models: [{ id: "shared-model", name: "Alpha shared" }],
    });
    const beta = fauxProvider({
      provider: "faux-beta",
      models: [{ id: "shared-model", name: "Beta shared" }],
    });
    alpha.setResponses([fauxAssistantMessage("alpha")]);
    beta.setResponses([fauxAssistantMessage("beta")]);
    models.setProvider(alpha.provider);
    models.setProvider(beta.provider);
    const signal = new AbortController().signal;

    const alphaSource = createPrivateLocalModelSource(
      models,
      "faux-alpha",
      "shared-model",
      "overlap-alpha",
    );
    const betaSource = createPrivateLocalModelSource(
      models,
      "faux-beta",
      "shared-model",
      "overlap-beta",
    );
    const alphaLease = await alphaSource.acquire({
      sessionId: "main",
      preference: null,
      signal,
    });
    const betaLease = await betaSource.acquire({
      sessionId: "main",
      preference: null,
      signal,
    });
    const overrideLease = await alphaSource.acquire({
      sessionId: "main",
      preference: { providerId: "faux-beta", modelId: "shared-model" },
      signal,
    });
    expect(overrideLease.model.provider).toBe("faux-beta");
    expect(alphaLease.model.provider).toBe("faux-alpha");
    const inheritedAgain = await alphaSource.acquire({
      sessionId: "main",
      preference: null,
      signal,
    });
    expect(inheritedAgain.model.provider).toBe("faux-alpha");
    await overrideLease.release();
    await inheritedAgain.release();
    if (alphaLease.stream === undefined || betaLease.stream === undefined)
      throw new Error("Faux provider stream was not acquired");
    await expect(
      (
        await alphaLease.stream(
          alphaLease.model,
          normalizeContext({ messages: [] }),
        )
      ).result(),
    ).resolves.toMatchObject({ content: [{ text: "alpha" }] });
    await expect(
      (
        await betaLease.stream(
          betaLease.model,
          normalizeContext({ messages: [] }),
        )
      ).result(),
    ).resolves.toMatchObject({ content: [{ text: "beta" }] });
    await alphaLease.release();
    await betaLease.release();
  });
});

it("round-trips Home URI results through Local's contained Files port", async () => {
  const root = await temporaryDirectory("home-uri");
  const outside = await temporaryDirectory("home-uri-outside");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src", "note space.txt"), "local Home contents");
  await writeFile(join(outside, "outside.txt"), "outside fixture");
  await symlink(join(outside, "outside.txt"), join(root, "escape.txt"));
  const faux = fauxModel([]);
  const readResult = (context: Context) => {
    const last = context.messages.at(-1);
    if (last?.role !== "toolResult") throw new Error("Missing Files result");
    const text = last.content
      .flatMap((part) => (part.type === "text" ? [part.text] : []))
      .join("");
    return { last, text };
  };
  const results: ReturnType<typeof readResult>[] = [];
  const call = (name: string, args: Record<string, string>) =>
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
  const done = Promise.withResolvers<undefined>();
  faux.setResponses([
    call("read", { path: "src/note space.txt" }),
    (context) => {
      results.push(readResult(context));
      return call("list", { path: "computer://home/src" });
    },
    (context) => {
      const { last, text } = readResult(context);
      expect(last.isError).toBe(false);
      const listing = z
        .object({ entries: z.array(z.object({ path: z.string() })) })
        .parse(JSON.parse(text));
      const path = listing.entries[0]?.path;
      expect(path).toBe("computer://home/src/note%20space.txt");
      if (path === undefined) throw new Error("Missing listed path");
      return call("read", { path });
    },
    (context) => {
      results.push(readResult(context));
      return call("read", { path: "computer://local/escape.txt" });
    },
    (context) => {
      expect(readResult(context).last.isError).toBe(true);
      return call("read", { path: "computer://home/..%2Foutside.txt" });
    },
    (context) => {
      expect(readResult(context).last.isError).toBe(true);
      done.resolve(undefined);
      return fauxAssistantMessage("done");
    },
  ]);
  const database = new DatabaseSync(join(root, "home.sqlite"));
  const local = await createBuiltPrivateLocalTools(root);
  const agent = await Shiitake.make({
    store: createPrivateSqliteOwner(database),
    extensions: local.extensions,
    runtime: createPrivateLocalRuntimeHost(),
    instructions: createPrivateLocalInstructionSource(local.port),
    model: {
      acquire: () =>
        Promise.resolve({
          model: faux.model,
          stream: faux.stream,
          release: () => Promise.resolve(),
        }),
    },
    tools: local.tools,
  });
  try {
    await agent.session("uri").command({
      requestId: "uri-proof",
      type: "prompt",
      text: "Read the file using Home.",
      delivery: "followUp",
    });
    await done.promise;
    expect(results).toHaveLength(2);
    for (const result of results) {
      expect(result.last.isError).toBe(false);
      expect(result.text).toContain("local Home contents");
    }
  } finally {
    await agent.close();
    database.close();
  }
});
