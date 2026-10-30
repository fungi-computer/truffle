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
  readdir,
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
import { closeSync, constants, existsSync, openSync } from "node:fs";
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
  waitForAgentSettlement,
} from "@fungi.computer/shiitake/agent-control";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { patchOutputSchema } from "@fungi.computer/knapsack";
import { directSandbox } from "@fungi.computer/mycelium/testing";

import type { LocalAgentControlDirectory } from "../src/private-local-agent-control.js";
import { createPrivateLocalAgentControl } from "../src/private-local-agent-control.js";
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
import { createLocalUiAttachment } from "../dist/private-local-ui-attachment.js";
import { mcpFormApprovalContract } from "../src/private-mcp-form-contract.js";
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

it("binds Local Agent creation to the exact Session that invokes it", async () => {
  const requests: unknown[] = [];
  const directory: LocalAgentControlDirectory = {
    list: () => Promise.resolve([]),
    create: (request) => {
      requests.push(request);
      return Promise.resolve({
        agentId: "local_store_child",
        name: "Child",
        workingDirectory: "/project",
      });
    },
    answer: () =>
      Promise.resolve({ status: "unavailable", reason: "unsupported" }),
    escalate: () =>
      Promise.resolve({ status: "unavailable", reason: "unsupported" }),
    open: () =>
      Promise.resolve({
        agent: {
          createSession: () => Promise.resolve("session-first"),
          deleteSession: () => Promise.reject(new Error("unused")),
          listSessions: () => Promise.reject(new Error("unused")),
          extensions: {
            list: () => Promise.reject(new Error("unused")),
            resume: () => Promise.reject(new Error("unused")),
            call: () => Promise.reject(new Error("unused")),
          },
          session: () => {
            throw new Error("unused");
          },
          close: () => Promise.resolve(),
        },
        release: () => Promise.resolve(),
      }),
    archive: () => Promise.resolve(),
    unarchive: () => Promise.resolve(),
  };
  // SAFETY: This test exercises the Session-to-directory delegation path only;
  // no persistence operation is made through this intentionally minimal stub.
  const storage: Parameters<
    typeof createPrivateLocalAgentControl
  >[0]["storage"] = {
    sql: {
      exec: () => ({ toArray: () => [] }),
    },
    transactionSync: (operation) => operation(),
  };
  const source = createPrivateLocalAgentControl({
    agentId: "local_store_parent",
    directory,
    storage,
  }).control;

  async function createInSession(sessionId: string) {
    const runtime = await Mycelium.make({
      sources: [source],
      sandbox: directSandbox(async ({ agents }) => {
        if (agents?.create === undefined)
          throw new Error("Agent create tool is unavailable");
        await agents.create({ requestId: "same-request" });
        return null;
      }),
      session: { sessionId },
    });
    const lease = await runtime.acquire();
    try {
      const prepared = await Effect.runPromise(
        lease.executeTool.prepare({
          type: "toolCall",
          id: `create-${sessionId}`,
          name: "execute",
          arguments: {
            code: 'return await agents.create({requestId:"same-request"})',
          },
        }),
      );
      const parts = await Effect.runPromise(
        Stream.runCollect(prepared.execute()),
      );
      expect(parts[0]).toMatchObject({ result: { isError: false } });
    } finally {
      await lease.release();
      await runtime.close();
    }
  }

  await createInSession("parent-session");
  await createInSession("sibling-session");
  expect(requests).toEqual([
    {
      requestId: "same-request",
      createdBy: "local_store_parent",
      createdBySessionId: "parent-session",
    },
    {
      requestId: "same-request",
      createdBy: "local_store_parent",
      createdBySessionId: "sibling-session",
    },
  ]);
});

it("binds Local answers and escalations to the Agent and exact Session that invoke them", async () => {
  const calls: unknown[] = [];
  const directory: LocalAgentControlDirectory = {
    list: () => Promise.resolve([]),
    create: () => Promise.resolve({ agentId: "child", name: "Child" }),
    answer: (request, senderAgentId, senderSessionId) => {
      calls.push({ answer: request, senderAgentId, senderSessionId });
      return Promise.resolve({
        status: "answered",
        via: "follow_up",
        commandId: "follow-up-1",
      });
    },
    escalate: (request, senderAgentId, senderSessionId) => {
      calls.push({ escalate: request, senderAgentId, senderSessionId });
      return Promise.resolve({ status: "escalated", to: "person" });
    },
    open: () => Promise.reject(new Error("unused")),
    archive: () => Promise.resolve(),
    unarchive: () => Promise.resolve(),
  };
  const storage: Parameters<
    typeof createPrivateLocalAgentControl
  >[0]["storage"] = {
    sql: { exec: () => ({ toArray: () => [] }) },
    transactionSync: (operation) => operation(),
  };
  const source = createPrivateLocalAgentControl({
    agentId: "local_store_parent",
    directory,
    storage,
  }).control;
  async function actFrom(sessionId: string) {
    const runtime = await Mycelium.make({
      sources: [source],
      sandbox: directSandbox(async ({ agents }) => {
        if (agents?.answer === undefined || agents.escalate === undefined)
          throw new Error("Agent answer tools are unavailable");
        return {
          answered: await agents.answer({
            agentId: "child",
            sessionId: "child-session",
            askId: "ask-1",
            requestId: `answer-${sessionId}`,
            answers: { storage: { selected: ["SQLite"] } },
          }),
          escalated: await agents.escalate({
            agentId: "child",
            sessionId: "child-session",
            itemId: "ask-2",
          }),
        };
      }),
      session: { sessionId },
    });
    const lease = await runtime.acquire();
    try {
      const prepared = await Effect.runPromise(
        lease.executeTool.prepare({
          type: "toolCall",
          id: `act-${sessionId}`,
          name: "execute",
          arguments: {
            code: `return { answered: await agents.answer({agentId:"child",sessionId:"child-session",askId:"ask-1",requestId:"answer-${sessionId}",answers:{storage:{selected:["SQLite"]}}}), escalated: await agents.escalate({agentId:"child",sessionId:"child-session",itemId:"ask-2"}) }`,
          },
        }),
      );
      return await Effect.runPromise(Stream.runCollect(prepared.execute()));
    } finally {
      await lease.release();
      await runtime.close();
    }
  }

  await actFrom("sender-session");
  expect(calls).toEqual([
    {
      answer: {
        agentId: "child",
        sessionId: "child-session",
        askId: "ask-1",
        requestId: "answer-sender-session",
        answers: { storage: { selected: ["SQLite"] } },
      },
      senderAgentId: "local_store_parent",
      senderSessionId: "sender-session",
    },
    {
      escalate: {
        agentId: "child",
        sessionId: "child-session",
        itemId: "ask-2",
      },
      senderAgentId: "local_store_parent",
      senderSessionId: "sender-session",
    },
  ]);
});

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
      "fungi-seccomp-workspace.bpf",
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

it("Full access runs a real Agent command bare outside its folder without bwrap", async () => {
  const fixture = await sandboxProductionFixture();
  const outside = join(dirname(fixture.root), "home", "outside");
  fixture.faux.setResponses([
    fauxAssistantMessage(
      fauxToolCall("execute", {
        code: 'return await env.computers.local.exec({ command: "printf outside > ../home/outside" })',
      }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("Full access completed"),
  ]);
  const host = await openProductionHost(
    { ...fixture.options, mode: "full-access" },
    fixture.models,
  );
  try {
    expect(host.sandboxStatus().mode).toBe("full-access");
    const accepted = await host.session.command({
      type: "prompt",
      requestId: "full-access-outside-folder",
      delivery: "followUp",
      text: "Write the outside file.",
    });
    await expect(
      waitForAgentSettlement(
        host.session,
        accepted.commandId,
        3_000,
        new AbortController().signal,
      ).then(({ terminal }) => terminal),
    ).resolves.toMatchObject({ outcome: "completed" });
    expect(await readFile(outside, "utf8")).toBe("outside");
  } finally {
    await host.close();
  }
});

it("a fresh Agent defaults to Full access with the failed sandbox probe reason", async () => {
  const fixture = await sandboxProductionFixture();
  const host = await openProductionHost(fixture.options, fixture.models);
  try {
    expect(host.sandboxStatus()).toMatchObject({
      mode: "full-access",
      available: false,
      reason: { kind: "install" },
    });
  } finally {
    await host.close();
  }
});

it("explicit Workspace without bwrap refuses before opening or running a command", async () => {
  const fixture = await sandboxProductionFixture();
  await expect(
    openProductionHost(
      { ...fixture.options, mode: "workspace" },
      fixture.models,
    ),
  ).rejects.toMatchObject({
    name: "LocalSandboxUnavailable",
    reason: { kind: "install" },
  });
  expect(fixture.modelCalls()).toBe(0);
  await expect(access(fixture.sentinel)).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("refuses a new Workspace Agent before creating its store", async () => {
  const fixture = await sandboxProductionFixture();
  await expect(
    openPrivateLocalRuntimeHost(
      { ...fixture.options, mode: "workspace" },
      fixture.models,
    ),
  ).rejects.toMatchObject({
    name: "LocalSandboxUnavailable",
    reason: { kind: "install" },
  });
  // The probe runs before the store file exists, so a refused new Agent
  // leaves no agent.sqlite behind for a later open to misread as an old store.
  const agents = join(fixture.root, ".fungi", "agents");
  const stores = existsSync(agents)
    ? (await readdir(agents, { recursive: true })).filter((entry) =>
        entry.endsWith("agent.sqlite"),
      )
    : [];
  expect(stores).toEqual([]);
});

it("refuses a Workspace reopen before changing the persisted Full access mode", async () => {
  const fixture = await sandboxProductionFixture();
  const initial = await openPrivateLocalRuntimeHost(
    { ...fixture.options, mode: "full-access" },
    fixture.models,
  );
  const databasePath = initial.databasePath;
  await initial.close();
  await expect(
    openPrivateLocalRuntimeHost(
      { ...fixture.options, databasePath, mode: "workspace" },
      fixture.models,
    ),
  ).rejects.toMatchObject({
    name: "LocalSandboxUnavailable",
    reason: { kind: "install" },
  });
  const database = new DatabaseSync(databasePath);
  try {
    expect(
      database
        .prepare("SELECT mode FROM private_local_identity WHERE singleton = 1")
        .get(),
    ).toMatchObject({ mode: "full-access" });
  } finally {
    database.close();
  }
});

it("refuses an existing child whose stored mode exceeds the requested creator ceiling", async () => {
  const fixture = await sandboxProductionFixture();
  const creator = await openPrivateLocalRuntimeHost(
    { ...fixture.options, mode: "full-access" },
    fixture.models,
  );
  const createdBy = creator.agentId;
  await creator.close();
  const child = await openPrivateLocalRuntimeHost(
    {
      ...fixture.options,
      createRequestId: "child-ceiling-reopen",
      createdBy,
      createdBySessionId: "creator-session",
      mode: "full-access",
    },
    fixture.models,
  );
  const databasePath = child.databasePath;
  await child.close();
  await expect(
    openPrivateLocalRuntimeHost(
      {
        ...fixture.options,
        databasePath,
        createdBy,
        mode: "read-only",
      },
      fixture.models,
    ),
  ).rejects.toMatchObject({
    name: "AgentCreateRefused",
    reason: "exceeds_creator",
  });
  const database = new DatabaseSync(databasePath);
  try {
    expect(
      database
        .prepare(
          "SELECT mode, created_by FROM private_local_identity WHERE singleton = 1",
        )
        .get(),
    ).toMatchObject({ mode: "full-access", created_by: createdBy });
  } finally {
    database.close();
  }
});

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
      "socket.socket(socket.AF_UNIX, socket.SOCK_STREAM).close()",
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
    const options: typeof fixture.options & { mode?: "workspace" } = {
      ...fixture.options,
      mode: "workspace",
    };
    const host = await openProductionHost(options, fixture.models);
    try {
      expect(host.sandboxStatus()).toEqual({
        mode: "workspace",
        available: true,
      });
      const accepted = await host.session.command({
        type: "prompt",
        requestId: `native-contained-${operation}`,
        delivery: "followUp",
        text: "Execute the native containment proof.",
      });
      await expect(
        waitForAgentSettlement(
          host.session,
          accepted.commandId,
          3_000,
          new AbortController().signal,
        ).then(({ terminal }) => terminal),
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
      { ...fixture.options, mode: "workspace" },
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
          waitForAgentSettlement(
            host.session,
            accepted.commandId,
            3_000,
            new AbortController().signal,
          ).then(({ terminal }) => terminal),
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
              waitForAgentSettlement(
                host.session,
                accepted.commandId,
                3_000,
                new AbortController().signal,
              ).then(({ terminal }) => terminal),
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
      { ...fixture.options, mode: "workspace" },
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
        waitForAgentSettlement(
          host.session,
          accepted.commandId,
          3_000,
          new AbortController().signal,
        ).then(({ terminal }) => terminal),
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

it
  .runIf(process.platform === "linux")
  .each(["patch", "edit", "write"] as const)(
  "a real Read-only Session refuses Files %s without staging or writing",
  async (kind) => {
    const fixture = await sandboxProductionFixture(true);
    const path = join(fixture.root, "note.txt");
    await writeFile(path, "before\n");
    const patch =
      kind === "write"
        ? "*** Begin Patch\n*** Add File: new.txt\n+new\n*** End Patch\n"
        : "*** Begin Patch\n*** Update File: note.txt\n@@\n-before\n+after\n*** End Patch\n";
    const toolName = kind === "edit" ? "execute" : "apply_patch";
    let refusal = "";
    fixture.faux.setResponses([
      fauxAssistantMessage(
        kind === "edit"
          ? fauxToolCall("execute", {
              code:
                "return await env.computers.local.files.edit(" +
                JSON.stringify({
                  path: "note.txt",
                  oldText: "before",
                  newText: "after",
                }) +
                ")",
            })
          : fauxToolCall("apply_patch", { patch }),
        { stopReason: "toolUse" },
      ),
      (context) => {
        const tool = context.messages.find(
          (message) =>
            message.role === "toolResult" && message.toolName === toolName,
        );
        if (tool?.role !== "toolResult")
          throw new Error("Files tool result missing");
        refusal = tool.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        return fauxAssistantMessage("Switch to Workspace to edit.");
      },
    ]);
    const host = await openProductionHost(
      { ...fixture.options, mode: "read-only" },
      fixture.models,
    );
    const attachment = createLocalUiAttachment("main");
    const attached = host.getSession("main", attachment);
    try {
      const accepted = await host.session.command({
        type: "prompt",
        requestId: "refuse-" + kind,
        delivery: "followUp",
        text: "Try Files " + kind + ".",
      });
      await expect(
        waitForAgentSettlement(
          host.session,
          accepted.commandId,
          3_000,
          new AbortController().signal,
        ).then(({ terminal }) => terminal),
      ).resolves.toMatchObject({ outcome: "completed" });
      expect(refusal).toContain("Read-only mode: switch to Workspace to edit");
      expect(await readFile(path, "utf8")).toBe("before\n");
      await expect(
        readFile(join(fixture.root, "new.txt"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const database = new DatabaseSync(host.databasePath);
      try {
        expect(
          database
            .prepare("SELECT count(*) AS total FROM approval_records")
            .get(),
        ).toMatchObject({ total: 0 });
      } finally {
        database.close();
      }
      const snapshot = await attached.read();
      const slot = snapshot.extensions[mcpFormApprovalContract.id];
      if (slot?.status !== "running")
        throw new Error("Approval projection unavailable");
      expect(
        Schema.decodeUnknownSync(mcpFormApprovalContract.projection.schema)(
          slot.value,
        ).pending,
      ).toEqual([]);
    } finally {
      attachment.close();
      await host.close();
    }
  },
);

it.runIf(process.platform === "linux")(
  "rejects a live switch to Workspace without sandbox, retaining the persisted Full access mode",
  async () => {
    const fixture = await sandboxProductionFixture();
    const host = await openProductionHost(fixture.options, fixture.models);
    try {
      expect(() => {
        host.setMode("workspace");
      }).toThrow("Packaged fungi-apply-patch digest mismatch");
      expect(host.sandboxStatus()).toMatchObject({
        mode: "full-access",
        available: false,
        reason: { kind: "install" },
      });
      const database = new DatabaseSync(host.databasePath);
      try {
        expect(
          database
            .prepare(
              "SELECT mode FROM private_local_identity WHERE singleton = 1",
            )
            .get(),
        ).toMatchObject({ mode: "full-access" });
      } finally {
        database.close();
      }
    } finally {
      await host.close();
    }
  },
);

it.runIf(process.platform === "linux")(
  "enforces Workspace before real Local execution with a partial native package",
  async () => {
    const fixture = await sandboxProductionFixture();
    const run = async () => {
      const host = await openProductionHost(
        { ...fixture.options, mode: "workspace" },
        fixture.models,
      );
      try {
        const accepted = await host.session.command({
          type: "prompt",
          requestId: "required-computer-execution",
          delivery: "followUp",
          text: "Run the Computer sentinel command.",
        });
        await waitForAgentSettlement(
          host.session,
          accepted.commandId,
          3_000,
          new AbortController().signal,
        ).then(({ terminal }) => terminal);
      } finally {
        await host.close();
      }
    };
    await expect(run()).rejects.toMatchObject({
      name: "LocalSandboxUnavailable",
      reason: { kind: "install" },
    });
    expect(fixture.modelCalls()).toBe(0);
    await expect(access(fixture.sentinel)).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it.runIf(process.platform === "linux")(
  "defaults to Full access and runs bare when the native sandbox package is partial",
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
        waitForAgentSettlement(
          host.session,
          accepted.commandId,
          3_000,
          new AbortController().signal,
        ).then(({ terminal }) => terminal),
      ).resolves.toMatchObject({ outcome: "completed" });
      expect(host.sandboxStatus()).toMatchObject({
        mode: "full-access",
        available: false,
        reason: { kind: "install" },
      });
      expect(await readFile(fixture.sentinel, "utf8")).toBe("executed");
    } finally {
      await host.close();
    }
  },
);

it.runIf(process.platform === "linux")(
  "enforces persisted Workspace, then recovers after explicit Full access and native repair",
  async () => {
    const fixture = await sandboxProductionFixture();
    const initial = await openProductionHost(fixture.options, fixture.models);
    const databasePath = initial.databasePath;
    await initial.close();
    const profile = new DatabaseSync(databasePath);
    try {
      profile
        .prepare(
          "UPDATE private_local_identity SET mode = ? WHERE singleton = 1",
        )
        .run("workspace");
    } finally {
      profile.close();
    }

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
      openProductionHost({ ...options, mode: "workspace" }, fixture.models),
    ).rejects.toMatchObject({
      name: "LocalSandboxUnavailable",
      reason: { kind: "install" },
    });
    // No flag is passed on this second open: persisted Workspace must still
    // win over the new-Agent default before any recovered model/tool work.
    await expect(
      openProductionHost(options, fixture.models),
    ).rejects.toMatchObject({
      name: "LocalSandboxUnavailable",
      reason: { kind: "install" },
    });
    expect(fixture.modelCalls()).toBe(0);
    await expect(access(fixture.sentinel)).rejects.toMatchObject({
      code: "ENOENT",
    });

    // Repair the partial package before the positive recovery control.
    for (const name of [
      "fungi-bwrap",
      "fungi-seccomp.bpf",
      "fungi-seccomp-workspace.bpf",
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
      { ...options, mode: "workspace" },
      fixture.models,
    );
    try {
      await expect(
        waitForAgentSettlement(
          recovered.session,
          commandId,
          3_000,
          new AbortController().signal,
        ).then(({ terminal }) => terminal),
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
    answer: (request, sourceSessionId, signal) =>
      directory.answer(request, creator, sourceSessionId, signal),
    escalate: (request, sourceSessionId, signal) =>
      directory.escalate(request, creator, sourceSessionId, signal),
    create: (request, signal) =>
      directory.create(
        {
          ...request,
          createdBy: creator,
          createdBySessionId: "creator-session",
        },
        signal,
      ),
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

it("joins real Local control and recovers a committed create after its first Session open fails", async () => {
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
    await waitForAgentSettlement(
      seedSession,
      seed.commandId,
      5_000,
      new AbortController().signal,
    ).then(({ terminal }) => terminal);

    const parentHost = await owners.select({
      invocationRoot: root,
      databasePath: agentPaths["agent-parent"],
      sessionId: "parent-main",
    });
    const parent = opened.get(parentHost.databasePath);
    if (parent === undefined) throw new Error("Request-owning parent missing");
    let failNextOpen = false;
    let failNextSessionOpen = false;
    let failedOpenAgentId: string | undefined;
    const localTools = await createBuiltPrivateLocalTools(root, {
      ...parent.control,
      open: async (agentId, signal) => {
        if (failNextOpen) {
          failNextOpen = false;
          failedOpenAgentId = agentId;
          return Promise.reject(
            new Error("Injected first Session open failure"),
          );
        }
        const opened = await parent.control.open(agentId, signal);
        return {
          ...opened,
          agent: {
            ...opened.agent,
            createSession: (requestId) => {
              if (failNextSessionOpen) {
                failNextSessionOpen = false;
                return Promise.reject(
                  new Error("Injected Session creation failure"),
                );
              }
              return opened.agent.createSession(requestId);
            },
          },
        };
      },
    });
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

      const createdAgentSchema = agentsSchema.element.extend({
        sessionId: z.string().min(1),
      });
      failNextOpen = true;
      await expect(
        executeSource(
          runtime,
          'return agents.create({ requestId: "model-agent-create" })',
        ),
      ).rejects.toThrow();
      expect(failedOpenAgentId).toBeDefined();
      // Create committed before open failed: the same request must recover that
      // exact durable identity, not create another Agent or invent a Session.
      const committedStore = await resolvePrivateLocalCreateStore(
        await realpath(root),
        "model-agent-create",
        { agentId: "agent-parent", sessionId: "creator-session" },
      );
      expect(committedStore.agentId).toBe(failedOpenAgentId);
      expect(
        agentsSchema.parse(
          await executeSource(runtime, "return agents.list({})"),
        ),
      ).toContainEqual(
        expect.objectContaining({ agentId: committedStore.agentId }),
      );
      const beforeRecovery = await directory.open(
        committedStore.agentId,
        new AbortController().signal,
      );
      try {
        expect((await beforeRecovery.agent.listSessions()).sessions).toEqual(
          [],
        );
      } finally {
        await beforeRecovery.release();
      }
      failNextSessionOpen = true;
      await expect(
        executeSource(
          runtime,
          'return agents.create({ requestId: "model-agent-create" })',
        ),
      ).rejects.toThrow();
      expect(failNextSessionOpen).toBe(false);
      const created = z
        .strictObject({
          agent: createdAgentSchema,
          accepted: acceptedSchema,
        })
        .parse(
          await executeSource(
            runtime,
            'const agent = await agents.create({ requestId: "model-agent-create" }); const accepted = await agents.send({ agentId: agent.agentId, sessionId: agent.sessionId, requestId: "child-first", text: "Work on the new goal", delivery: "steer" }); return { agent, accepted }',
          ),
        );
      expect(created.agent.agentId).toBe(committedStore.agentId);
      await expect(
        executeSource(
          runtime,
          `return agents.create({ requestId: ${JSON.stringify("é".repeat(200))} })`,
        ),
      ).rejects.toThrow();
      const replayed = createdAgentSchema.parse(
        await executeSource(
          runtime,
          'return agents.create({ requestId: "model-agent-create" })',
        ),
      );
      expect(replayed).toEqual(created.agent);
      const childTerminal = terminalSchema.parse(
        await executeSource(
          runtime,
          `return agents.wait({ agentId: ${JSON.stringify(created.agent.agentId)}, sessionId: ${JSON.stringify(created.agent.sessionId)}, commandId: ${JSON.stringify(created.accepted.commandId)}, timeoutMs: 5000 })`,
        ),
      );
      expect(childTerminal).toEqual({
        commandId: created.accepted.commandId,
        outcome: "completed",
        text: "B reply",
        truncated: false,
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
        ).toEqual([created.agent.sessionId]);
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
        sessionId: created.agent.sessionId,
      });
      expect(selectedChild.session.address).toContain(
        `/sessions/${created.agent.sessionId}`,
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
