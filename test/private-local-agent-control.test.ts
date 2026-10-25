import { initFreshStore, writeFreshStore } from "./fixtures/fresh-store.js";
import { fauxModel } from "@fungi.computer/mule/testing";
import {
  fixtureEffectiveModel,
  fixtureMailControls,
  fixtureModelControls,
} from "./fixtures/effective-model.js";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createModels } from "@earendil-works/pi-ai";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { closeSync, constants, openSync } from "node:fs";
import { Socket } from "node:net";
import { once } from "node:events";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Mycelium } from "@fungi.computer/mycelium";
import {
  makeHost,
  Shiitake,
  type ShiitakeAgent,
} from "@fungi.computer/shiitake";
import {
  type AgentControlDirectory,
  waitForAgentTerminal,
} from "@fungi.computer/shiitake/agent-control";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { patchOutputSchema } from "@fungi.computer/knapsack";

import type { LocalAgentControlDirectory } from "../src/private-local-agent-control.js";
import {
  createLocalServiceOwners,
  type OpenLocalServiceRuntime,
} from "../src/private-local-service-owner.js";
import {
  createPrivateLocalRuntimeHost,
  openPrivateLocalRuntimeHost,
  resolvePrivateLocalCreateStore,
} from "../src/private-local-runtime-host.js";
import { capturePrivateLocalConfigRoot } from "../src/private-local-config-root.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";
import { createPrivateLocalDelegation } from "../src/private-local-delegation.js";
import { createPrivateLocalMailRoom } from "../src/private-local-mail.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
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

/**
 * Own the optional-package tree: a partial install by default, or the
 * maintained locally built native payload for available-backend proofs.
 */
async function sandboxProductionFixture(available = false) {
  const directory = await temporaryDirectory();
  const root = join(directory, "project");
  const home = join(directory, "home");
  const bin = join(
    directory,
    "native",
    "node_modules",
    "@fungi.computer",
    `spore-native-${process.platform}-${process.arch}`,
    "bin",
  );
  await Promise.all(
    [root, home, bin].map((path) => mkdir(path, { recursive: true })),
  );
  await writeFile(
    join(bin, "fungi-apply-patch"),
    "#!/bin/sh\nprintf 'Unexpected patch call in Computer proof' >&2\nexit 1\n",
    { mode: 0o700 },
  );
  if (available) {
    for (const name of [
      "fungi-bwrap",
      "fungi-seccomp.bpf",
      "fungi-apply-patch",
    ])
      await copyFile(
        fileURLToPath(new URL(`../native/bin/${name}`, import.meta.url)),
        join(bin, name),
      );
    await chmod(join(bin, "fungi-bwrap"), 0o700);
    await chmod(join(bin, "fungi-apply-patch"), 0o700);
  }
  vi.stubEnv("FUNGI_BUNDLED_CLI", join(directory, "native", "fungi.cjs"));
  const faux = fauxProvider({
    provider: "sandbox-proof",
    models: [{ id: "sandbox-model" }],
  });
  const models = createModels();
  models.setProvider(faux.provider);
  const options = {
    invocationRoot: root,
    configRoot: capturePrivateLocalConfigRoot(home),
    providerId: "sandbox-proof",
    modelId: "sandbox-model",
  };
  const sentinel = join(root, "computer-executed");
  let modelCalls = 0;
  faux.setResponses([
    () => {
      modelCalls += 1;
      return fauxAssistantMessage(
        fauxToolCall("execute", {
          code: 'return await env.computers.local.exec({ command: "printf executed > computer-executed" })',
        }),
        { stopReason: "toolUse" },
      );
    },
    () => {
      modelCalls += 1;
      return fauxAssistantMessage("Computer completed");
    },
  ]);
  return {
    root,
    bin,
    models,
    options,
    sentinel,
    faux,
    modelCalls: () => modelCalls,
  };
}

/** Exercise the same built entry that native Local callers open. */
async function openProductionHost(
  ...args: Parameters<typeof openPrivateLocalRuntimeHost>
) {
  const { openPrivateLocalRuntimeHost: open } =
    await import("../dist/private-local-runtime-host.js");
  return open(...args);
}

it.runIf(process.platform === "linux").each(["run", "start"])(
  "contains real Local Computer %s, preserving stdin and owned seccomp fd3",
  async (operation) => {
    const fixture = await sandboxProductionFixture(true);
    // Deliberately outside /tmp: a missing private-tmp pathname is not proof
    // of a read-only host mount. The target must read this existing sentinel.
    const outsideBase = fileURLToPath(
      new URL("../.botanical/production-sandbox/", import.meta.url),
    );
    await mkdir(outsideBase, { recursive: true });
    const outside = await mkdtemp(join(outsideBase, "host-"));
    temporaryDirectories.push(outside);
    const hostSentinel = join(outside, "sentinel");
    await writeFile(hostSentinel, "host sentinel");
    const python = [
      "import errno, os, pathlib, socket, sys",
      "assert sys.stdin.read() == 'owned stdin'",
      `host = pathlib.Path(${JSON.stringify(hostSentinel)})`,
      "assert host.read_text() == 'host sentinel'",
      "try: host.write_text('escaped')",
      "except OSError as error: assert error.errno in (errno.EROFS, errno.EACCES)",
      "else: raise AssertionError('host write was allowed')",
      "try: socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)",
      "except PermissionError: pass",
      "else: raise AssertionError('maintained seccomp filter was absent')",
      "try: os.fstat(3)",
      "except OSError as error: assert error.errno == errno.EBADF",
      "else: raise AssertionError('filter fd leaked into target')",
      "pathlib.Path('computer-executed').write_text('filtered')",
    ].join("\n");
    const input = {
      operation,
      executable: "/usr/bin/python3",
      args: ["-c", python],
      stdin: "owned stdin",
    };
    fixture.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("execute", {
          code:
            operation === "run"
              ? `return await env.computers.local.exec(${JSON.stringify(input)})`
              : `const started = await env.computers.local.exec(${JSON.stringify(input)}); return await env.computers.local.exec({ operation: "wait", id: started.process.id, timeoutMs: 2000 })`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Native containment proof completed"),
    ]);
    const options: typeof fixture.options & { requireSandbox?: boolean } = {
      ...fixture.options,
    };
    if (operation === "start") options.requireSandbox = true;
    const host = await openProductionHost(options, fixture.models);
    try {
      expect(host.sandboxStatus()).toEqual({
        state: "available",
        requireSandbox: operation === "start",
      });
      const accepted = await host.session.command({
        type: "prompt",
        requestId: `native-contained-${operation}`,
        delivery: "followUp",
        text: "Execute the native containment proof.",
      });
      await expect(
        waitForAgentTerminal(
          host.session,
          accepted.commandId,
          3_000,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ outcome: "completed" });
      expect(await readFile(fixture.sentinel, "utf8")).toBe("filtered");
      expect(await readFile(hostSentinel, "utf8")).toBe("host sentinel");
    } finally {
      await host.close();
    }
  },
);

it.runIf(process.platform === "linux").each(["run", "start"])(
  "reaps the real contained %s process and descendant through native cancellation/shutdown",
  async (operation) => {
    const fixture = await sandboxProductionFixture(true);
    const fifo = join(fixture.root, "lifecycle.fifo");
    execFileSync("/usr/bin/mkfifo", [fifo]);
    const python = [
      "import os, subprocess, sys, time",
      `fd = os.open(${JSON.stringify(fifo)}, os.O_WRONLY)`,
      "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(1000)'], pass_fds=[fd])",
      "os.write(fd, b'ready')",
      "time.sleep(1000)",
    ].join("\n");
    fixture.faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("execute", {
          code: `return await env.computers.local.exec(${JSON.stringify({
            operation,
            executable: "/usr/bin/python3",
            args: ["-c", python],
          })})`,
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Background process started"),
    ]);
    const host = await openProductionHost(
      { ...fixture.options, requireSandbox: true },
      fixture.models,
    );
    // A parent-owned writer prevents EOF before the contained command attaches.
    // Remove it after "ready": EOF then requires BOTH real child writers to
    // close, rather than observing only the wrapper or a fabricated PID state.
    let keepOpen: number | undefined = openSync(fifo, constants.O_RDWR);
    // fs streams park a libuv worker on this FIFO. Batch has only one, so that
    // would block filesystem work needed to launch the command that writes it.
    // Wrap the pipe fd in Socket to read through the event loop instead.
    const reader = new Socket({
      fd: openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK),
      readable: true,
      writable: false,
    });
    try {
      const ready = once(reader, "data", {
        signal: AbortSignal.timeout(3_000),
      });
      const accepted = await host.session.command({
        type: "prompt",
        requestId: `contained-lifecycle-${operation}`,
        delivery: "followUp",
        text: "Start the owned lifecycle probe.",
      });
      const readyData: unknown = await ready;
      expect(readyData).toEqual([Buffer.from("ready")]);
      closeSync(keepOpen);
      keepOpen = undefined;
      if (operation === "start")
        await expect(
          waitForAgentTerminal(
            host.session,
            accepted.commandId,
            3_000,
            new AbortController().signal,
          ),
        ).resolves.toMatchObject({ outcome: "completed" });
      const ended = once(reader, "end", {
        signal: AbortSignal.timeout(3_000),
      });
      await Promise.all([
        ended,
        (async () => {
          // Follow the retained TUI's explicit foreground abort before close.
          if (operation === "run") {
            await host.session.abort();
            await expect(
              waitForAgentTerminal(
                host.session,
                accepted.commandId,
                3_000,
                new AbortController().signal,
              ),
            ).resolves.toMatchObject({ outcome: "cancelled" });
          }
          await host.close();
        })(),
      ]);
    } finally {
      if (keepOpen !== undefined) closeSync(keepOpen);
      reader.destroy();
      await host.close();
    }
  },
);

it.runIf(process.platform === "linux")(
  "joins real Local Files edit and native patch to the same sandbox authority",
  async () => {
    const fixture = await sandboxProductionFixture(true);
    const ordinary = join(fixture.root, "ordinary.txt");
    const protectedFile = join(fixture.root, ".fungi", "protected.txt");
    await mkdir(dirname(protectedFile), { recursive: true });
    await writeFile(ordinary, "before\n");
    await writeFile(protectedFile, "before\n");
    const patchResults: z.output<typeof patchOutputSchema>[] = [];
    let toolResults = 0;
    fixture.faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("execute", {
            code: `return await env.computers.local.files.edit(${JSON.stringify(
              {
                path: "ordinary.txt",
                oldText: "before",
                newText: "after",
              },
            )})`,
          }),
          fauxToolCall("apply_patch", {
            patch:
              "*** Begin Patch\n*** Update File: ordinary.txt\n@@\n-after\n+patched\n*** End Patch\n",
          }),
          fauxToolCall("execute", {
            code: `return await env.computers.local.files.edit(${JSON.stringify(
              {
                path: ".fungi/protected.txt",
                oldText: "before",
                newText: "escaped",
              },
            )})`,
          }),
          fauxToolCall("apply_patch", {
            patch:
              "*** Begin Patch\n*** Update File: .fungi/protected.txt\n@@\n-before\n+escaped\n*** End Patch\n",
          }),
        ],
        { stopReason: "toolUse" },
      ),
      (context) => {
        for (const message of context.messages) {
          if (message.role !== "toolResult") continue;
          toolResults += 1;
          if (message.toolName !== "apply_patch") continue;
          const text = message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n");
          patchResults.push(patchOutputSchema.parse(JSON.parse(text)));
        }
        return fauxAssistantMessage("Native Files proof completed");
      },
    ]);
    const host = await openProductionHost(
      { ...fixture.options, requireSandbox: true },
      fixture.models,
    );
    try {
      const accepted = await host.session.command({
        type: "prompt",
        requestId: "native-files-authority",
        delivery: "followUp",
        text: "Edit and patch the controlled ordinary and protected files.",
      });
      await expect(
        waitForAgentTerminal(
          host.session,
          accepted.commandId,
          3_000,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ outcome: "completed" });
      expect(toolResults).toBe(4);
      expect(
        patchResults.map((result) => result.status),
        JSON.stringify(patchResults),
      ).toEqual(["completed", "failed"]);
      expect(await readFile(ordinary, "utf8")).toBe("patched\n");
      expect(await readFile(protectedFile, "utf8")).toBe("before\n");
    } finally {
      await host.close();
    }
  },
);

it.runIf(process.platform === "linux")(
  "applies live persisted requirement changes before subsequent real launches",
  async () => {
    const fixture = await sandboxProductionFixture(true);
    const host = await openProductionHost(fixture.options, fixture.models);
    try {
      expect(host.sandboxStatus()).toMatchObject({ state: "available" });
      // An installed artifact that disappears after readiness is not a
      // missing optional package; the next launch must never run bare.
      await rm(join(fixture.bin, "fungi-bwrap"));
      for (const required of [undefined, true, false]) {
        if (required !== undefined)
          expect(() => {
            host.setRequireSandbox(required);
          }).toThrow(
            expect.objectContaining({ name: "LocalSandboxUnavailable" }),
          );
        fixture.faux.setResponses([
          fauxAssistantMessage(
            fauxToolCall("execute", {
              code: 'return await env.computers.local.exec({ command: "printf executed > computer-executed" })',
            }),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("Live launch attempt completed"),
        ]);
        const accepted = await host.session.command({
          type: "prompt",
          requestId: `live-requirement-${String(required)}`,
          delivery: "followUp",
          text: "Run the controlled Computer sentinel command.",
        });
        await expect(
          waitForAgentTerminal(
            host.session,
            accepted.commandId,
            3_000,
            new AbortController().signal,
          ),
        ).resolves.toMatchObject({ outcome: "completed" });
        expect(host.sandboxStatus()).toMatchObject({
          state: "unavailable",
          requireSandbox: required === true,
          reason: { kind: "missing-artifact" },
        });
        await expect(access(fixture.sentinel)).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
    } finally {
      await host.close();
    }
  },
);

it.runIf(process.platform === "linux")(
  "enforces requireSandbox before real Local execution with a partial native package",
  async () => {
    const fixture = await sandboxProductionFixture();
    const run = async () => {
      const host = await openProductionHost(
        { ...fixture.options, requireSandbox: true },
        fixture.models,
      );
      try {
        const accepted = await host.session.command({
          type: "prompt",
          requestId: "required-computer-execution",
          delivery: "followUp",
          text: "Run the Computer sentinel command.",
        });
        await waitForAgentTerminal(
          host.session,
          accepted.commandId,
          3_000,
          new AbortController().signal,
        );
      } finally {
        await host.close();
      }
    };
    await expect(run()).rejects.toMatchObject({
      name: "LocalSandboxUnavailable",
      reason: { kind: "missing-artifact" },
    });
    expect(fixture.modelCalls()).toBe(0);
    await expect(access(fixture.sentinel)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.runIf(process.platform === "linux")(
  "refuses bare Local execution with a partial native package even when optional",
  async () => {
    const fixture = await sandboxProductionFixture();
    const host = await openProductionHost(fixture.options, fixture.models);
    try {
      const accepted = await host.session.command({
        type: "prompt",
        requestId: "default-computer-execution",
        delivery: "followUp",
        text: "Run the Computer sentinel command.",
      });
      await expect(
        waitForAgentTerminal(
          host.session,
          accepted.commandId,
          3_000,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ outcome: "completed" });
      expect(host.sandboxStatus()).toMatchObject({
        state: "unavailable",
        reason: { kind: "missing-artifact" },
      });
      await expect(access(fixture.sentinel)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await host.close();
    }
  },
);

it.runIf(process.platform === "linux")(
  "enforces persisted requireSandbox, then recovers after explicit disable and native repair",
  async () => {
    const fixture = await sandboxProductionFixture();
    const initial = await openProductionHost(fixture.options, fixture.models);
    const databasePath = initial.databasePath;
    await initial.close();

    // Admit through the real Session/SQLite contract, with only its scheduling
    // paused. Do not invent queue rows or a model/tool settlement. Reopening
    // through native Local below supplies the real Node reconciliation owner.
    const { createPrivateLocalTools, createPrivateLocalInstructionSource } =
      await import("../dist/private-local-runtime-host.js");
    const tools = await createPrivateLocalTools(
      fixture.root,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      fixture.options.configRoot,
    );
    const database = new DatabaseSync(databasePath);
    const seedModel = fauxModel([]);
    let commandId: string;
    try {
      const seed = await Shiitake.make({
        store: createPrivateSqliteOwner(database),
        runtime: {
          bind: () =>
            Promise.resolve({
              commit: (mutation) => mutation(),
              requestWake: () => Promise.resolve(),
              close: () => Promise.resolve(),
            }),
        },
        extensions: tools.extensions,
        tools: tools.tools,
        instructions: createPrivateLocalInstructionSource(tools.port),
        model: {
          acquire: () =>
            Promise.resolve({
              model: seedModel.model,
              retryable: () => false,
              stream: seedModel.stream,
              release: () => Promise.resolve(),
            }),
        },
      });
      try {
        const accepted = await seed.session("main").command({
          type: "prompt",
          requestId: "durable-computer-recovery",
          delivery: "followUp",
          text: "Run the Computer sentinel command after recovery.",
        });
        commandId = accepted.commandId;
        expect((await seed.session("main").read()).pending.total).toBe(1);
      } finally {
        await seed.close();
      }
    } finally {
      await tools.processes.close();
      database.close();
    }

    const options = { ...fixture.options, databasePath };
    await expect(
      openProductionHost({ ...options, requireSandbox: true }, fixture.models),
    ).rejects.toMatchObject({
      name: "LocalSandboxUnavailable",
      reason: { kind: "missing-artifact" },
    });
    // No flag is passed on this second open: the persisted requirement must
    // still win over the default OFF before any recovered model/tool work.
    await expect(
      openProductionHost(options, fixture.models),
    ).rejects.toMatchObject({
      name: "LocalSandboxUnavailable",
      reason: { kind: "missing-artifact" },
    });
    expect(fixture.modelCalls()).toBe(0);
    await expect(access(fixture.sentinel)).rejects.toMatchObject({
      code: "ENOENT",
    });

    // Repair the partial package before the positive recovery control. Turning
    // the requirement off alone must not authorize a bare command.
    for (const name of [
      "fungi-bwrap",
      "fungi-seccomp.bpf",
      "fungi-apply-patch",
    ])
      await copyFile(
        fileURLToPath(new URL(`../native/bin/${name}`, import.meta.url)),
        join(fixture.bin, name),
      );
    await chmod(join(fixture.bin, "fungi-bwrap"), 0o700);
    await chmod(join(fixture.bin, "fungi-apply-patch"), 0o700);
    // No new prompt is sent. The SAME durable command must recover and run
    // within a valid sandbox.
    const recovered = await openProductionHost(
      { ...options, requireSandbox: false },
      fixture.models,
    );
    try {
      await expect(
        waitForAgentTerminal(
          recovered.session,
          commandId,
          3_000,
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ commandId, outcome: "completed" });
      expect(await readFile(fixture.sentinel, "utf8")).toBe("executed");
      expect(fixture.modelCalls()).toBe(2);
    } finally {
      await recovered.close();
    }
  },
);

/** The core directory an Agent sees, with creates attributed to one Agent. */
function createdBy(
  directory: LocalAgentControlDirectory,
  creator: string,
): AgentControlDirectory {
  return {
    ...directory,
    create: (request, signal) =>
      directory.create({ ...request, createdBy: creator }, signal),
    archive: ({ agentId }, signal) =>
      directory.archive(
        { agentId, by: { kind: "agent", agentId: creator } },
        signal,
      ),
    unarchive: ({ agentId }, signal) =>
      directory.unarchive(
        { agentId, by: { kind: "agent", agentId: creator } },
        signal,
      ),
  };
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
  z.strictObject({
    agentId: z.string(),
    name: z.string(),
    createdBy: z.string().nullable(),
    workingDirectory: z.string().min(1),
    model: z.string().optional(),
    reasoning: z.string().optional(),
  }),
);

it("joins project Agent ownership to real Local Shiitake control", async () => {
  const root = await temporaryDirectory();
  const stores = join(root, ".fungi", "agents");
  const agentPaths = {
    "agent-a": join(stores, "agent-a", "agent.sqlite"),
    "agent-b": join(stores, "agent-b", "agent.sqlite"),
    "agent-parent": join(stores, "agent-parent", "agent.sqlite"),
  } as const;
  await Promise.all(
    Object.values(agentPaths).map(async (path) => {
      await mkdir(dirname(path), { recursive: true });
      writeFreshStore(path, null);
    }),
  );

  const firstAStarted = Promise.withResolvers<undefined>();
  const releaseFirstA = Promise.withResolvers<undefined>();
  const bProgressed = Promise.withResolvers<undefined>();
  const opened = new Map<
    string,
    Readonly<{
      database: DatabaseSync;
      agent: ShiitakeAgent;
      control: AgentControlDirectory;
    }>
  >();
  let directory: LocalAgentControlDirectory | undefined;
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
    initFreshStore(
      database,
      basename(dirname(databasePath)),
      options.name ?? null,
      options.createdBy ?? null,
    );
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
    } else if (basename(dirname(databasePath)) === "agent-parent") {
      faux.setResponses(
        Array.from({ length: 4 }, () =>
          fauxAssistantMessage("Parent received a reply"),
        ),
      );
    } else {
      faux.setResponses([
        () => {
          bProgressed.resolve(undefined);
          return fauxAssistantMessage("B reply");
        },
      ]);
    }
    directory ??= options.agentControl;
    if (directory === undefined || options.mail === undefined)
      throw new Error("Local opener did not receive Agent control and mail");
    const agentId = basename(dirname(databasePath));
    const store = createPrivateSqliteOwner(database);
    let host: Awaited<ReturnType<typeof makeHost>> | undefined;
    const delegation = createPrivateLocalDelegation({
      agentId,
      storage: store,
      directory,
      routing: options.mail,
      accept: (mail, meta, reply) => {
        if (host === undefined)
          return Promise.reject(new Error("Fixture host is not open"));
        return host.acceptMail(mail, meta, reply);
      },
    });
    const control = createdBy(
      { ...directory, send: delegation.send, recall: delegation.recall },
      agentId,
    );
    try {
      const localTools = await createBuiltPrivateLocalTools(
        options.invocationRoot,
        control,
      );
      host = await makeHost(
        {
          store,
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
                retryable: () => false,
                stream: faux.stream,
                release: () => Promise.resolve(),
              }),
          },
          tools: localTools.tools,
        },
        createPrivateLocalMailRoom(database, { deliver: options.mail.deliver }),
      );
      const agent = host.agent;
      const mailHost = host;
      opened.set(databasePath, { database, agent, control });
      return {
        databasePath,
        agentId: basename(dirname(databasePath)),
        getSession: (sessionId: string) => agent.session(sessionId),
        listSessions: (after?: string) => agent.listSessions(after),
        createSession: (requestId: string) => agent.createSession(requestId),
        deleteSession: (sessionId: string) => agent.deleteSession(sessionId),
        extensions: agent.extensions,
        name: basename(dirname(databasePath)),
        bindSessionPath: () => true,
        effectiveModel: fixtureEffectiveModel,
        ...fixtureModelControls,
        ...fixtureMailControls,
        acceptMail: delegation.receive,
        readSettlement: mailHost.readSettlement,
        pendingDelegation: () => delegation.outstanding(),
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

    const parentHost = await owners.select({
      invocationRoot: root,
      databasePath: agentPaths["agent-parent"],
      sessionId: "parent-main",
    });
    const parent = opened.get(parentHost.databasePath);
    if (parent === undefined) throw new Error("Request-owning parent missing");
    const localTools = await createBuiltPrivateLocalTools(root, parent.control);
    if (localTools.tools.sources === undefined)
      throw new Error("Local tools did not compose Agent control");
    const runtime = await Mycelium.make({
      session: { sessionId: "parent-main" },
      sources: localTools.tools.sources,
      sandbox: localTools.tools.sandbox,
    });
    try {
      const first = acceptedSchema.parse(
        await executeSource(
          runtime,
          'return agents.send({ agentId: "agent-a", sessionId: "main", requestId: "a-first", text: "A first", delivery: "followUp" })',
        ),
      );
      await firstAStarted.promise;
      const queued = z
        .tuple([acceptedSchema, acceptedSchema])
        .parse(
          await executeSource(
            runtime,
            'const second = await agents.send({ agentId: "agent-a", sessionId: "main", requestId: "a-second", text: "A second", delivery: "followUp" }); const third = await agents.send({ agentId: "agent-a", sessionId: "main", requestId: "a-third", text: "A third", delivery: "followUp" }); return [second, third]',
          ),
        );
      const cancelled = acceptedSchema.parse(
        await executeSource(
          runtime,
          'return agents.recall({ agentId: "agent-a", sessionId: "main", requestId: "a-second" })',
        ),
      );
      const b = acceptedSchema.parse(
        await executeSource(
          runtime,
          'return agents.send({ agentId: "agent-b", sessionId: "main", requestId: "b-first", text: "B independent", delivery: "followUp" })',
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
        {
          agentId: "agent-a",
          name: "agent-a",
          createdBy: null,
          workingDirectory: root,
        },
        {
          agentId: "agent-b",
          name: "agent-b",
          createdBy: null,
          workingDirectory: root,
        },
        {
          agentId: "agent-parent",
          name: "agent-parent",
          createdBy: null,
          workingDirectory: root,
        },
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
            'const agent = await agents.create({ requestId: "model-agent-create" }); const session = await agents.createSession({ agentId: agent.agentId, requestId: "model-session-create" }); const accepted = await agents.send({ agentId: agent.agentId, sessionId: session.sessionId, requestId: "child-first", text: "Work on the new goal", delivery: "followUp" }); return { agent, session, accepted }',
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
      ).toContainEqual({
        agentId: created.agent.agentId,
        name: created.agent.name,
        createdBy: "agent-parent",
        workingDirectory: created.agent.workingDirectory,
      });
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
