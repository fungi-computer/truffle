import {
  settledBeforeAdmission,
  deferred,
  execute,
  observeExecution,
  openRuntime,
  openRuntimes,
  closeRuntime,
  ownedWorkerdProcesses,
  WORKERD_ADMISSION_BUDGET_MS,
  WORKERD_TEST_TIMEOUT_MS,
} from "./fixtures/private-workerd.fixture.mjs";
/* global AbortController, DOMException, URL, console */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { setImmediate } from "node:timers";

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { Miniflare } from "miniflare";

import { Knapsack } from "@fungi.computer/knapsack";
import { Mycelium, sandboxFailureMessage } from "@fungi.computer/mycelium";
import {
  createPrivateInvocationComputer,
  createPrivateInvocationFilesPort,
  createPrivateWorkerdSandbox,
} from "../dist/index.js";

describe("private local workerd Sandbox", () => {
  it.each([
    { code: 'throw new TypeError("guest-owned message")', name: "TypeError" },
    { code: 'throw "guest-owned message"', name: "ThrownValue" },
    {
      code: 'throw new DOMException("guest-owned message", "AbortError")',
      name: "AbortError",
    },
  ])("keeps a real guest $name typed with its name", async ({ code, name }) => {
    const failure = await createPrivateWorkerdSandbox()
      .execute(
        { executionId: "typed-guest", code, timeoutMs: 1000, bindings: {} },
        new AbortController().signal,
      )
      .catch((cause) => cause);
    expect(failure).toMatchObject({
      _tag: "GuestThrew",
      name,
      message: "guest-owned message",
    });
  });

  it("retains guest failure before disposal failure", async () => {
    const disposalFailure = new Error("disposal failure");
    const operatorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const originalDispose = Miniflare.prototype.dispose;
    const disposeSpy = vi
      .spyOn(Miniflare.prototype, "dispose")
      .mockImplementationOnce(async function (...args) {
        await originalDispose.apply(this, args);
        throw disposalFailure;
      });
    const sandbox = createPrivateWorkerdSandbox();
    const controller = new globalThis.AbortController();

    try {
      const failure = await sandbox
        .execute(
          {
            executionId: "double-failure",
            code: 'async () => { throw new Error("guest failure") }',
            timeoutMs: 17_003,
            bindings: {},
          },
          controller.signal,
        )
        .then(
          () => undefined,
          (cause) => cause,
        );

      expect(failure).toMatchObject({
        _tag: "GuestThrew",
        name: "Error",
        message: "guest failure",
      });
      expect(operatorLog).toHaveBeenCalledWith("sandbox_cleanup_failure", {
        executionId: "double-failure",
        rawCause: disposalFailure,
      });
    } finally {
      disposeSpy.mockRestore();
      operatorLog.mockRestore();
    }
  });

  it.each([
    { name: "TypeError", cause: new TypeError("private startup marker") },
    { name: "string", cause: "private startup marker" },
    {
      name: "AbortError",
      cause: new DOMException("private startup marker", "AbortError"),
    },
    {
      name: "fetch failure",
      cause: new TypeError("fetch failed", {
        cause: new Error("private startup marker"),
      }),
    },
  ])(
    "classifies a host startup $name without exposing its cause",
    async ({ cause }) => {
      const ready = vi
        .spyOn(Miniflare.prototype, "ready", "get")
        .mockRejectedValueOnce(cause);
      try {
        const failure = await createPrivateWorkerdSandbox()
          .execute(
            {
              executionId: "startup-proof",
              code: "return 1",
              timeoutMs: 1000,
              bindings: {},
            },
            new AbortController().signal,
          )
          .catch((caught) => caught);
        expect(failure).toMatchObject({
          _tag: "SandboxCrashed",
          rawCause: cause,
        });
        expect(sandboxFailureMessage(failure)).not.toContain("marker");
      } finally {
        ready.mockRestore();
      }
    },
  );

  it.each([
    {
      name: "lost socket",
      tag: "DispatchLost",
      reply: (_request, response) => response.destroy(),
    },
    {
      name: "invalid JSON",
      tag: "BadResponse",
      reply: (_request, response) => response.end("private response marker"),
    },
    {
      name: "invalid envelope",
      tag: "BadResponse",
      reply: (_request, response) =>
        response.end(
          JSON.stringify({ operatorMarker: "private response marker" }),
        ),
    },
  ])(
    "classifies a real HTTP $name without exposing response text",
    async ({ tag, reply }) => {
      const server = createServer(reply);
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const { port } = z.object({ port: z.number() }).parse(server.address());
      const ready = vi
        .spyOn(Miniflare.prototype, "ready", "get")
        .mockResolvedValueOnce(new URL(`http://127.0.0.1:${port}`));
      try {
        const failure = await createPrivateWorkerdSandbox()
          .execute(
            {
              executionId: "transport-proof",
              code: "return 1",
              timeoutMs: 1000,
              bindings: {},
            },
            new AbortController().signal,
          )
          .catch((cause) => cause);
        expect(failure).toMatchObject({
          _tag: tag,
          rawCause: expect.anything(),
        });
        expect(sandboxFailureMessage(failure)).not.toContain("marker");
        if (tag === "DispatchLost")
          expect(failure.elapsedMs).toBeGreaterThanOrEqual(0);
      } finally {
        ready.mockRestore();
        await new Promise((resolve, reject) =>
          server.close((error) =>
            error === undefined ? resolve() : reject(error),
          ),
        );
      }
    },
  );

  it("returns real detail from a failed forage.search or forage.describe", async () => {
    const runtime = await openRuntime({
      modules: [],
      sandbox: createPrivateWorkerdSandbox(),
    });
    const lease = await runtime.acquire();
    try {
      await expect(
        execute(lease, 'async () => await forage.search({ query: "   " })'),
      ).rejects.toThrow(/Search query must not be empty/u);
      await expect(
        execute(lease, 'async () => await forage.describe({ path: "   " })'),
      ).rejects.toThrow(/Description target must not be empty/u);
    } finally {
      await closeRuntime(runtime, lease);
    }
  });

  it("runs Knapsack's retained BOM and CRLF edit against real local files", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-local-files-knapsack-"));
    const path = join(root, "retained.txt");
    const initial = "\uFEFFalpha\r\nsmart \u201Cquote\u201D  \r\nomega\r\n";
    await writeFile(path, initial);
    const files = Knapsack.files({
      port: await createPrivateInvocationFilesPort(root),
    });
    const runtime = await openRuntime({
      modules: [files.module],
      sandbox: createPrivateWorkerdSandbox(),
    });
    const lease = await runtime.acquire();

    try {
      await expect(
        execute(
          lease,
          'async () => await files.edit({ path: "retained.txt", oldText: "smart \\"quote\\"", newText: "changed" })',
        ),
      ).resolves.toMatchObject({ path: "retained.txt" });
      // Only the fuzzy-matched span is replaced; the trailing spaces stay.
      await expect(readFile(path, "utf8")).resolves.toBe(
        "\uFEFFalpha\r\nchanged  \r\nomega\r\n",
      );
    } finally {
      await closeRuntime(runtime, lease);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("explains real Files read path failures at the public tool boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-local-files-errors-"));
    await writeFile(join(root, "present.txt"), "present\n");
    const files = Knapsack.files({
      port: await createPrivateInvocationFilesPort(root),
    });
    const runtime = await openRuntime({
      modules: [files.module],
      sandbox: createPrivateWorkerdSandbox(),
    });
    const lease = await runtime.acquire();
    try {
      await expect(
        execute(lease, 'return await files.read({ path: "present.txt" });'),
      ).resolves.toMatchObject({ content: "present\n" });
      await expect(
        execute(lease, 'return await files.read({ path: "/etc/hosts" });'),
      ).rejects.toThrow(/Files path resolves outside the invocation root/u);
      await expect(
        execute(lease, 'return await files.read({ path: "missing.txt" });'),
      ).rejects.toThrow(/Files path does not exist/u);
      await expect(
        execute(lease, 'return await files.read({ path: "." });'),
      ).rejects.toThrow(/Files path is not a file/u);
    } finally {
      await closeRuntime(runtime, lease);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("executes one files.read-shaped call and two legitimate repeated calls", async () => {
    const calls = [];
    const files = Knapsack.files({
      port: {
        read: (input, context) => {
          calls.push({ input, context });
          return Promise.resolve({
            path: input.path,
            content: `content:${input.path}`,
            offset: input.offset,
            nextOffset: null,
            truncated: false,
          });
        },
        find: (input) =>
          Promise.resolve({ path: input.path, results: [], truncated: null }),
        replace: (input) =>
          Promise.resolve({ path: input.path, bytes: input.content.length }),
      },
    });
    const runtime = await openRuntime({
      modules: [files.module],
      sandbox: createPrivateWorkerdSandbox(),
    });
    const lease = await runtime.acquire();

    try {
      await expect(
        execute(lease, 'async () => await files.read({ path: "one.txt" })'),
      ).resolves.toEqual({
        path: "one.txt",
        content: "content:one.txt",
        offset: 0,
        nextOffset: null,
        truncated: false,
      });
      await expect(
        execute(
          lease,
          'async () => ({ first: await files.read({ path: "two.txt" }), second: await files.read({ path: "three.txt" }) })',
        ),
      ).resolves.toMatchObject({
        first: { path: "two.txt", content: "content:two.txt" },
        second: { path: "three.txt", content: "content:three.txt" },
      });
      expect(calls).toHaveLength(3);
      expect(calls.map(({ input }) => input.path)).toEqual([
        "one.txt",
        "two.txt",
        "three.txt",
      ]);
      expect(
        calls.every(
          ({ context }) => context.signal instanceof globalThis.AbortSignal,
        ),
      ).toBe(true);
    } finally {
      await closeRuntime(runtime, lease);
    }
  });

  it.each([
    {
      name: "rejects a non-object Files argument before calling the host",
      code: 'async () => await files.read("not an object")',
      error:
        /Invalid operation input:.*expected object.*use forage.describe/isu,
    },
    {
      name: "rejects an unknown Files input key before calling the host",
      code: 'async () => await files.read({ path: "okay.txt", cwd: "elsewhere" })',
      error: /Invalid operation input.*Unrecognized key:.*cwd/su,
    },
    {
      name: "directs a missing Files operation to discovery without calling the host",
      code: 'async () => await files.remove({ path: "no.txt" })',
      error:
        /NoSuchOperationError: No such operation files\.remove.*forage\.search/u,
    },
    {
      name: "suggests files.glob for a nonexistent forage operation",
      code: 'async () => await forage.files_glob({ path: ".", pattern: "*.txt" })',
      error:
        /NoSuchOperationError: No such operation forage\.files_glob.*files\.glob/u,
    },
    {
      name: "suggests files.read for a misspelled Files operation",
      code: 'async () => await files.reed({ path: "no.txt" })',
      error: /No such operation files\.reed.*files\.read/u,
    },
    {
      name: "bounds a guest failure message at the execute boundary",
      code: 'async () => { throw new Error("guest\\nfailure") }',
      error: /guest failure/u,
    },
    {
      name: "bounds an opaque Files host failure after exactly one host call",
      code: 'async () => await files.read({ path: "opaque-host-failure.txt" })',
      error: /The sandbox failed for an unrecognized reason/u,
      readPaths: ["opaque-host-failure.txt"],
    },
  ])("$name", async ({ code, error, readPaths = [] }) => {
    const calls = [];
    const files = Knapsack.files({
      port: {
        read: (input) => {
          calls.push(input);
          if (input.path === "opaque-host-failure.txt")
            return Promise.reject(new Error("private host diagnostic"));
          return Promise.resolve({
            path: input.path,
            content: "unused",
            offset: input.offset,
            nextOffset: null,
            truncated: false,
          });
        },
        find: (input) =>
          Promise.resolve({ path: input.path, results: [], truncated: null }),
        replace: (input) =>
          Promise.resolve({ path: input.path, bytes: input.content.length }),
      },
    });
    const runtime = await openRuntime({
      modules: [files.module],
      sandbox: createPrivateWorkerdSandbox(),
    });
    const lease = await runtime.acquire();

    try {
      await expect(execute(lease, code)).rejects.toThrow(error);
      expect(calls.map((input) => input.path)).toEqual(readPaths);
    } finally {
      await closeRuntime(runtime, lease);
    }
  });

  it("denies guest fetch without an outgoing network binding", async () => {
    const runtime = await openRuntime({
      sandbox: createPrivateWorkerdSandbox(),
    });
    const lease = await runtime.acquire();
    try {
      await expect(
        execute(
          lease,
          'async () => { try { await fetch("https://example.com") } catch { return { denied: true } } return { denied: false } }',
        ),
      ).resolves.toEqual({ denied: true });
    } finally {
      await closeRuntime(runtime, lease);
    }
  });

  it("names an undeclared assignment and the const/let fix through the execute tool", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-sandbox-declaration-"));
    const runtime = await openRuntime({
      sources: [
        Knapsack.computer({
          id: "local-computer",
          name: "Local Computer",
          computer: await createPrivateInvocationComputer(root),
        }),
      ],
      sandbox: createPrivateWorkerdSandbox(),
    });
    const lease = await runtime.acquire();
    try {
      await expect(
        execute(
          lease,
          'cat_r = await Local_Computer.exec({ command: "printf recovered" }); return cat_r;',
        ),
      ).rejects.toThrow(
        /cat_r is not defined\. Declare cat_r with const or let/u,
      );
      for (const declaration of ["const", "let"]) {
        await expect(
          execute(
            lease,
            `${declaration} cat_r = await Local_Computer.exec({ command: "printf recovered" }); return cat_r;`,
          ),
        ).resolves.toMatchObject({ status: "completed", stdout: "recovered" });
      }
    } finally {
      await closeRuntime(runtime, lease);
      await rm(root, { recursive: true, force: true });
    }
  });

  it(
    "returns a typed command deadline with elapsed time and partial output through execute",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "fungi-command-deadline-"));
      const runtime = await openRuntime({
        execution: { timeoutMs: 17_003 },
        sources: [
          Knapsack.computer({
            id: "local-computer",
            name: "Local Computer",
            computer: await createPrivateInvocationComputer(root),
          }),
        ],
        sandbox: createPrivateWorkerdSandbox(),
      });
      const lease = await runtime.acquire();
      try {
        const result = await execute(
          lease,
          'return await Local_Computer.exec({ command: "printf partial; printf warning >&2; sleep 10", timeoutMs: 500 });',
        );
        expect(result).toMatchObject({
          status: "deadline_exceeded",
          timeoutMs: 500,
          elapsedMs: expect.any(Number),
          exitCode: -1,
          stdout: "partial",
          stderr: "warning",
          truncated: false,
        });
        expect(result.elapsedMs).toBeGreaterThanOrEqual(500);
      } finally {
        await closeRuntime(runtime, lease);
        await rm(root, { recursive: true, force: true });
      }
    },
    WORKERD_TEST_TIMEOUT_MS,
  );

  it("reports typed Files edit causes through the workerd binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-edit-causes-"));
    await writeFile(join(root, "missing.txt"), "alpha\n");
    await writeFile(join(root, "ambiguous.txt"), "same\nother\nsame\n");
    await writeFile(join(root, "large.txt"), "x".repeat(128 * 1024 + 1));
    const files = Knapsack.files({
      port: await createPrivateInvocationFilesPort(root),
    });
    const runtime = await openRuntime({
      modules: [files.module],
      sandbox: createPrivateWorkerdSandbox(),
    });
    const lease = await runtime.acquire();
    try {
      await expect(
        execute(
          lease,
          'return await files.edit({ path: "missing.txt", oldText: "beta", newText: "fixed" });',
        ),
      ).resolves.toMatchObject({
        status: "failed",
        error: { kind: "not-found", path: "missing.txt" },
      });
      await expect(
        execute(
          lease,
          'return await files.edit({ path: "ambiguous.txt", oldText: "same", newText: "fixed" });',
        ),
      ).resolves.toMatchObject({
        status: "failed",
        error: { kind: "ambiguous", path: "ambiguous.txt" },
      });
      await expect(
        execute(
          lease,
          'return await files.edit({ path: "large.txt", oldText: "x", newText: "y" });',
        ),
      ).resolves.toMatchObject({
        status: "failed",
        error: { kind: "file-too-large", path: "large.txt" },
      });
    } finally {
      await closeRuntime(runtime, lease);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a missing JSON result after the tool call has completed", async () => {
    let completedCalls = 0;
    const sample = Mycelium.module({
      id: "sample",
      operations: {
        touch: Mycelium.operation({
          input: z.strictObject({}),
          output: z.strictObject({ done: z.literal(true) }),
          execute: async () => {
            completedCalls++;
            return { done: true };
          },
        }),
      },
    });
    const runtime = await openRuntime({
      modules: [sample],
      sandbox: createPrivateWorkerdSandbox(),
    });
    const lease = await runtime.acquire();

    try {
      await expect(
        execute(lease, "async () => { await sample.touch({}); }"),
      ).rejects.toThrow("Sandbox returned non-JSON data");
      expect(completedCalls).toBe(1);

      for (const code of [
        "async () => { return await sample.touch({}); }",
        "return await sample.touch({});",
        "sample.touch({});",
      ]) {
        await expect(execute(lease, code)).resolves.toEqual({ done: true });
      }
      expect(completedCalls).toBe(4);
      await expect(execute(lease, "return null;")).resolves.toBeNull();
    } finally {
      await closeRuntime(runtime, lease);
    }
  });

  it("reports denied Computer cwd through the real binding without widening access", async () => {
    const root = await mkdtemp(join(tmpdir(), "fungi-sandbox-cwd-"));
    const outside = await mkdtemp(join(tmpdir(), "fungi-sandbox-outside-"));
    const runtime = await openRuntime({
      sources: [
        Knapsack.computer({
          id: "local-computer",
          name: "Local Computer",
          computer: await createPrivateInvocationComputer(root),
        }),
      ],
      sandbox: createPrivateWorkerdSandbox(),
    });
    const lease = await runtime.acquire();

    try {
      await expect(
        execute(
          lease,
          `return await Local_Computer.exec(${JSON.stringify({ command: "printf denied", cwd: outside })});`,
        ),
      ).rejects.toThrow("Computer cwd resolves outside the invocation root");
      await expect(
        execute(
          lease,
          `return await Local_Computer.exec(${JSON.stringify({ command: "printf allowed" })});`,
        ),
      ).resolves.toMatchObject({ status: "completed", stdout: "allowed" });
    } finally {
      await closeRuntime(runtime, lease);
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(outside, { recursive: true, force: true }),
      ]);
    }
  });

  describe("direct argv/stdin exec", () => {
    async function withComputer(run) {
      const root = await mkdtemp(join(tmpdir(), "fungi-sandbox-direct-exec-"));
      const runtime = await openRuntime({
        sources: [
          Knapsack.computer({
            id: "local-computer",
            name: "Local Computer",
            computer: await createPrivateInvocationComputer(root),
          }),
        ],
        sandbox: createPrivateWorkerdSandbox(),
      });
      const lease = await runtime.acquire();
      try {
        return await run(lease);
      } finally {
        await closeRuntime(runtime, lease);
        await rm(root, { recursive: true, force: true });
      }
    }

    it('runs python3 -, args:["-"], with the program delivered as stdin and no shell involved', async () => {
      const script = 'import sys\nprint("direct-exec-ok")\n';
      const result = await withComputer((lease) =>
        execute(
          lease,
          `return await Local_Computer.exec(${JSON.stringify({ executable: "python3", args: ["-"], stdin: script })});`,
        ),
      );
      expect(result).toMatchObject({
        status: "completed",
        exitCode: 0,
        stdout: "direct-exec-ok\n",
        stderr: "",
      });
    });

    it("delivers stdin byte-identical through the direct form (quotes, backslashes, newlines, $(), Unicode)", async () => {
      const tricky =
        "quote:' dquote:\" backslash:\\\\ newline:\nline2\r\nline3 dollar:$(whoami) backtick:`id` semicolon:; ampersand:&& heredoc:<<'PY'\nEOF\nPY unicode: héllo 日本語 🍄 combining: é (e + U+0301)";
      const program =
        "import sys; d = sys.stdin.buffer.read(); sys.stdout.buffer.write(d)";
      const result = await withComputer((lease) =>
        execute(
          lease,
          `return await Local_Computer.exec(${JSON.stringify({ executable: "python3", args: ["-c", program], stdin: tricky })});`,
        ),
      );
      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(tricky);
      expect(result.stderr).toBe("");
    });

    it("delivers argv byte-identical through the direct form; shell metacharacters never expand", async () => {
      const trickyArg = "a'b\"c$(whoami)`id`\\d;e&&f\ng日本語🍄é(combining: é)";
      const program = "import sys; sys.stdout.write(sys.argv[1])";
      const result = await withComputer((lease) =>
        execute(
          lease,
          `return await Local_Computer.exec(${JSON.stringify({ executable: "python3", args: ["-c", program, trickyArg] })});`,
        ),
      );
      expect(result.status).toBe("completed");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe(trickyArg);
    });

    it("keeps python's own exit code (7) through the direct form; no later command can mask it", async () => {
      const script = 'print("x")\nraise SystemExit(7)\n';
      const result = await withComputer((lease) =>
        execute(
          lease,
          `return await Local_Computer.exec(${JSON.stringify({ executable: "python3", args: ["-"], stdin: script })});`,
        ),
      );
      expect(result).toMatchObject({
        status: "failed",
        exitCode: 7,
        stdout: "x\n",
      });
    });

    it("reports an uncaught Python exception as exit 1 with the traceback on stderr only", async () => {
      const script = 'raise ValueError("boom")\n';
      const result = await withComputer((lease) =>
        execute(
          lease,
          `return await Local_Computer.exec(${JSON.stringify({ executable: "python3", args: ["-"], stdin: script })});`,
        ),
      );
      expect(result.status).toBe("failed");
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("Traceback");
      expect(result.stderr).toContain("ValueError: boom");
    });

    it("refuses both command and executable, and neither, at the Zod boundary", async () => {
      // Through the real sandbox, Mycelium's own invocation wraps the Zod
      // union failure as a typed InvalidOperationInput/CapabilityFailed,
      // which the guest sees as this MuleError; verified empirically for
      // both shapes, not assumed.
      const refusal = {
        _tag: "MuleError",
        phase: "tool",
        message: expect.stringContaining("Invalid operation input"),
      };
      await expect(
        withComputer((lease) =>
          execute(
            lease,
            `return await Local_Computer.exec(${JSON.stringify({ command: "printf a", executable: "python3" })});`,
          ),
        ),
      ).rejects.toMatchObject(refusal);
      await expect(
        withComputer((lease) =>
          execute(lease, `return await Local_Computer.exec({});`),
        ),
      ).rejects.toMatchObject(refusal);
    });

    it("reports a missing direct executable by name, as a typed refusal with no health alert", async () => {
      // Spawning a direct executable that does not exist fails at the OS
      // level (ENOENT) before any ExecOutput is built, so this never
      // resolves as a `completed` status. runCommandAtInvocationBoundary
      // maps that spawn failure to a typed CapabilityFailed naming the
      // executable, the same way the NUL refusal is typed, so the guest
      // gets an actionable message and the box health monitor is not paged
      // for an ordinary model typo.
      await expect(
        withComputer((lease) =>
          execute(
            lease,
            `return await Local_Computer.exec(${JSON.stringify({ executable: "fungi-proof-definitely-missing-binary-xyz", args: [] })});`,
          ),
        ),
      ).rejects.toMatchObject({
        _tag: "MuleError",
        phase: "tool",
        message: expect.stringContaining(
          "fungi-proof-definitely-missing-binary-xyz was not found on PATH or could not be run; no process was started.",
        ),
      });
    });
  });

  it("distinguishes invalid requests from actionable native compiler failures", async () => {
    const sandbox = createPrivateWorkerdSandbox();
    const signal = new globalThis.AbortController().signal;
    const request = {
      executionId: "sandbox-diagnostic-stages",
      code: "return null;",
      timeoutMs: 17_003,
      bindings: {},
    };
    await expect(
      sandbox.execute({ ...request, timeoutMs: 0 }, signal),
    ).rejects.toMatchObject({ _tag: "BadResponse" });
    const failure = await sandbox
      .execute({ ...request, code: 'return "first\nsecond";' }, signal)
      .catch((cause) => cause);
    expect(failure._tag).toBe("SourceInvalid");
    expect(failure).toMatchObject({
      line: 1,
      column: 8,
      excerpt: 'return "first',
    });
    expect(sandboxFailureMessage(failure)).toContain("submitted source line 1");
    expect(sandboxFailureMessage(failure)).not.toContain("executor.js:");
    expect(sandboxFailureMessage(failure)).not.toMatch(/\p{Cc}/u);
    expect(sandboxFailureMessage(failure)).not.toContain(
      "Tool calls may have completed",
    );
    const secondLineFailure = await sandbox
      .execute(
        {
          ...request,
          code: '// first line\nreturn await files.patch({patch: "x"}});',
        },
        signal,
      )
      .catch((cause) => cause);
    expect(secondLineFailure._tag).toBe("SourceInvalid");
    expect(secondLineFailure).toMatchObject({
      line: 2,
      excerpt: 'return await files.patch({patch: "x"}});',
    });
    await expect(
      sandbox.execute({ ...request, code: 'return "first\\nsecond";' }, signal),
    ).resolves.toBe("first\nsecond");
    await expect(
      sandbox.execute({ ...request, code: "return `first\nsecond`;" }, signal),
    ).resolves.toBe("first\nsecond");
  });

  it.each([
    { cancellation: "deadline", timeoutMs: WORKERD_ADMISSION_BUDGET_MS },
    { cancellation: "caller", timeoutMs: 17_003 },
  ])(
    "projects $cancellation cancellation into a cooperative binding and drains it before settlement",
    async ({ cancellation, timeoutMs }) => {
      const started = deferred();
      const events = [];
      const controller = new globalThis.AbortController();
      const observedTimeouts = [];
      const sandbox = createPrivateWorkerdSandbox();
      const cooperative = Mycelium.module({
        id: "cooperative",
        operations: {
          wait: Mycelium.operation({
            input: z.strictObject({}),
            output: z.strictObject({ drained: z.literal(true) }),
            execute: (_input, context) => {
              events.push("binding-started");
              started.resolve();
              return new Promise((resolve) => {
                const drain = () => {
                  events.push("signal-observed");
                  setImmediate(() => {
                    events.push("binding-drained");
                    resolve({ drained: true });
                  });
                };
                if (context.signal.aborted) drain();
                else
                  context.signal.addEventListener("abort", drain, {
                    once: true,
                  });
              });
            },
          }),
        },
      });
      const runtime = await openRuntime({
        execution: { timeoutMs, abortGraceMs: 500 },
        modules: [cooperative],
        sandbox: {
          execute: (request, signal) => {
            observedTimeouts.push(request.timeoutMs);
            return sandbox.execute(request, signal);
          },
        },
      });
      const lease = await runtime.acquire();

      try {
        const execution = execute(
          lease,
          "async () => await cooperative.wait({})",
          controller.signal,
        ).catch((cause) => {
          events.push("execution-settled");
          throw cause;
        });
        await Promise.race([
          started.promise,
          execution.then(settledBeforeAdmission, settledBeforeAdmission),
        ]);
        if (cancellation === "caller") {
          controller.abort();
          await expect(execution).rejects.toThrow();
        } else {
          await expect(execution).rejects.toThrow(
            /execute hit its .* ms deadline/u,
          );
        }
        expect(observedTimeouts).toEqual([timeoutMs]);
        expect(events).toEqual([
          "binding-started",
          "signal-observed",
          "binding-drained",
          "execution-settled",
        ]);
      } finally {
        await closeRuntime(runtime, lease);
      }
    },
    WORKERD_TEST_TIMEOUT_MS,
  );

  it.runIf(process.platform === "linux")(
    "keeps unacknowledged callbacks tracked until every admitted callback and workerd process drains",
    async () => {
      const firstStarted = deferred();
      const secondStarted = deferred();
      const releaseFirst = deferred();
      const releaseSecond = deferred();
      const firstDrained = deferred();
      const events = [];
      const terminalParts = [];
      let admittedCallCount = 0;
      let laterCallCount = 0;
      const held = Mycelium.module({
        id: "held",
        operations: {
          wait: Mycelium.operation({
            input: z.strictObject({ id: z.enum(["first", "second"]) }),
            output: z.strictObject({ id: z.enum(["first", "second"]) }),
            execute: async ({ id }, context) => {
              admittedCallCount += 1;
              events.push(`${id}-started`);
              (id === "first" ? firstStarted : secondStarted).resolve(context);
              await (id === "first"
                ? releaseFirst.promise
                : releaseSecond.promise);
              events.push(`${id}-drained`);
              if (id === "first") firstDrained.resolve();
              return { id };
            },
          }),
          later: Mycelium.operation({
            input: z.strictObject({}),
            output: z.strictObject({ started: z.literal(true) }),
            execute: () => {
              laterCallCount += 1;
              events.push("later-started");
              return Promise.resolve({ started: true });
            },
          }),
        },
      });
      const runtime = await openRuntime({
        execution: {
          timeoutMs: WORKERD_ADMISSION_BUDGET_MS,
          abortGraceMs: 50,
        },
        modules: [held],
        sandbox: createPrivateWorkerdSandbox(),
      });
      const lease = await runtime.acquire();
      let released = false;

      try {
        expect(await ownedWorkerdProcesses()).toEqual([]);
        const execution = observeExecution(
          lease,
          'async () => { const admitted = await Promise.all([held.wait({ id: "first" }), held.wait({ id: "second" })]); return { admitted, later: await held.later({}) }; }',
          terminalParts,
        );
        // Handle the rejection now: the execution deadline can pass while the
        // process listing below is still running on a loaded host.
        const unacknowledged = expect(execution).rejects.toThrow(
          /sandbox did not acknowledge cancellation/iu,
        );
        const [firstContext, secondContext] = await Promise.race([
          Promise.all([firstStarted.promise, secondStarted.promise]),
          execution.then(settledBeforeAdmission, settledBeforeAdmission),
        ]);
        const during = await ownedWorkerdProcesses();
        expect(during.length).toBeGreaterThan(0);
        expect(during.every(({ parentId }) => parentId > 0)).toBe(true);

        await unacknowledged;
        expect(firstContext.signal.aborted).toBe(true);
        expect(secondContext.signal).toBe(firstContext.signal);
        expect(events).not.toContain("first-drained");
        expect(events).not.toContain("second-drained");

        await lease.release();
        released = true;
        let closeSettled = false;
        const closing = runtime.close().then(() => {
          closeSettled = true;
          openRuntimes.delete(runtime);
        });
        releaseFirst.resolve();
        await firstDrained.promise;
        await new Promise(setImmediate);
        expect(closeSettled).toBe(false);

        releaseSecond.resolve();
        await closing;
        expect(events.slice(0, 2).sort()).toEqual([
          "first-started",
          "second-started",
        ]);
        expect(events.slice(2)).toEqual(["first-drained", "second-drained"]);
        expect(admittedCallCount).toBe(2);
        expect(laterCallCount).toBe(0);
        expect(terminalParts).toEqual([]);
        expect(await ownedWorkerdProcesses()).toEqual([]);
      } finally {
        releaseFirst.resolve();
        releaseSecond.resolve();
        if (!released) await lease.release();
        await runtime.close();
        openRuntimes.delete(runtime);
      }
    },
    WORKERD_TEST_TIMEOUT_MS,
  );
});

it(
  "executes a nested App namespace through the local serialized Worker boundary",
  async () => {
    const calls = [];
    await expect(
      createPrivateWorkerdSandbox().execute(
        {
          executionId: "nested-app",
          code: 'return [await env.apps.bazaar.windows.panels.open({value: "deep"}), await env.demo.ping({value: "flat"}), await demo.ping({value: "legacy-flat"})]',
          timeoutMs: WORKERD_ADMISSION_BUDGET_MS,
          namespacePaths: { bazaar: ["apps", "bazaar"], demo: ["demo"] },
          bindings: {
            bazaar: {
              "windows.panels.open": async ({ value }) => {
                calls.push(value);
                return value;
              },
            },
            demo: {
              ping: async ({ value }) => {
                calls.push(value);
                return value;
              },
            },
          },
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual(["deep", "flat", "legacy-flat"]);
    expect(calls).toEqual(["deep", "flat", "legacy-flat"]);
  },
  WORKERD_TEST_TIMEOUT_MS,
);
