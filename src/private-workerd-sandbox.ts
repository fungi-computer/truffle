import { sandboxBindingNames } from "@fungi.computer/mycelium/sandbox-guest";
import {
  recoverSandboxFailure,
  sandboxTransportMessage,
  sandboxCapabilityFailure,
  sandboxTransportErrno,
} from "@fungi.computer/mycelium/sandbox-boundary";
import { nanoid } from "@fungi.computer/cairn";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";

import {
  SandboxCrashed,
  DispatchLost,
  BadResponse,
  Cancelled,
  sandboxFailure,
  type SandboxFailure,
  type Sandbox,
  type SandboxRequest,
  type SandboxValue,
} from "@fungi.computer/mycelium";
import { FilesEditError } from "@fungi.computer/knapsack";
import {
  convertV4MiniflareOptions,
  Miniflare,
  Response as MiniflareResponse,
  type V4FetchHandler,
} from "miniflare";
import { z } from "zod";
import {
  sandboxWireSchema,
  sandboxWireFailure,
} from "@fungi.computer/mycelium/sandbox-wire";
import { FilesPathError } from "./private-invocation-files.js";

const jsonValueSchema = z.json();
const bindingCallSchema = z.strictObject({
  namespace: z.string().max(160),
  operation: z.string().max(160),
  input: jsonValueSchema,
});
const bindingErrorSchema = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("no_such_operation"),
    path: z.string().max(321),
    suggestions: z.array(z.string().max(160)).max(3),
  }),
  z.strictObject({
    code: z.enum(["invalid_input", "operation_failed", "closing"]),
    message: z.string().max(512),
  }),
]);
const bindingResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: jsonValueSchema }),
  z.strictObject({ ok: z.literal(false), error: bindingErrorSchema }),
]);
const workerBundle = readFile(
  new URL("./internal/private-workerd-sandbox-worker.mjs", import.meta.url),
  "utf8",
);

type SandboxResult =
  | Readonly<{ ok: true; value: SandboxValue }>
  | Readonly<{ ok: false; cause: SandboxFailure }>;
type InvocationCallbacks = Readonly<{
  fetch: V4FetchHandler;
  closeAdmission: () => void;
  drain: () => Promise<void>;
  failures: ReadonlyMap<string, SandboxFailure>;
}>;

// Files owns admission of its diagnostics; the shared boundary alone decodes rejections.
const filesDiagnosticSchema = z
  .union([z.instanceof(FilesPathError), z.instanceof(FilesEditError)])
  .transform((error) => ({ kind: "Files" as const, message: error.message }));

function operationTokens(path: string): string[] {
  return path
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left[index] === right[index]
  )
    index += 1;
  return index;
}

function oneEditApart(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 1) return false;
  let leftIndex = 0;
  let rightIndex = 0;
  let changed = false;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    if (changed) return false;
    changed = true;
    if (left.length >= right.length) leftIndex += 1;
    if (right.length >= left.length) rightIndex += 1;
  }
  return changed || left.length !== right.length;
}

function operationSuggestions(
  request: SandboxRequest,
  operation: string,
): string[] {
  const requestedTokens = operationTokens(operation);
  const scored = Object.entries(request.bindings).flatMap(
    ([namespace, methods]) =>
      Object.keys(methods).map((method) => {
        const path = `${namespace}.${method}`;
        const candidateTokens = operationTokens(path);
        const score = requestedTokens.reduce(
          (total, requested) =>
            total +
            Math.max(
              0,
              ...candidateTokens.map((candidate) =>
                candidate === requested
                  ? 4
                  : oneEditApart(candidate, requested)
                    ? 3
                    : commonPrefixLength(candidate, requested) >= 3
                      ? 2
                      : 0,
              ),
            ),
          0,
        );
        return { path, score };
      }),
  );
  return scored
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) =>
        right.score - left.score || left.path.localeCompare(right.path),
    )
    .slice(0, 3)
    .map(({ path }) => path);
}

function jsonResponse(
  value: z.output<typeof bindingResponseSchema>,
  status = 200,
) {
  return new MiniflareResponse(
    JSON.stringify(bindingResponseSchema.parse(value)),
    {
      status,
      headers: { "content-type": "application/json" },
    },
  );
}

async function invokeBinding(
  request: SandboxRequest,
  bindingRequest: Parameters<V4FetchHandler>[0],
  failures: Map<string, SandboxFailure>,
): Promise<MiniflareResponse> {
  let call: z.output<typeof bindingCallSchema>;
  try {
    call = bindingCallSchema.parse(await bindingRequest.json());
  } catch {
    return jsonResponse(
      {
        ok: false,
        error: { code: "invalid_input", message: "Invalid binding call" },
      },
      400,
    );
  }
  const operation = request.bindings[call.namespace]?.[call.operation];
  if (operation === undefined) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: "no_such_operation",
          path: `${call.namespace}.${call.operation}`,
          suggestions: operationSuggestions(request, call.operation),
        },
      },
      404,
    );
  }
  try {
    const value = jsonValueSchema.parse(await operation(call.input));
    return jsonResponse({ ok: true, value });
  } catch (cause) {
    const failure = sandboxCapabilityFailure(
      cause,
      call.namespace,
      call.operation,
      filesDiagnosticSchema,
    );
    const ref = nanoid();
    if (failures.size === 128)
      failures.delete(failures.keys().next().value ?? "");
    failures.set(ref, failure);
    return jsonResponse(
      {
        ok: false,
        error: {
          code:
            failure._tag === "CapabilityFailed" &&
            failure.cause.kind === "InvalidInput"
              ? "invalid_input"
              : "operation_failed",
          message: sandboxTransportMessage(failure, ref),
        },
      },
      400,
    );
  }
}

function createInvocationCallbacks(
  request: SandboxRequest,
): InvocationCallbacks {
  const failures = new Map<string, SandboxFailure>();
  const activeCallbacks = new Set<Promise<MiniflareResponse>>();
  let acceptingCallbacks = true;
  const fetch: V4FetchHandler = (bindingRequest) => {
    if (!acceptingCallbacks) {
      return Promise.resolve(
        jsonResponse(
          {
            ok: false,
            error: { code: "closing", message: "Invocation is closing" },
          },
          503,
        ),
      );
    }
    const callback = invokeBinding(request, bindingRequest, failures);
    activeCallbacks.add(callback);
    void callback.then(
      () => activeCallbacks.delete(callback),
      () => activeCallbacks.delete(callback),
    );
    return callback;
  };
  return Object.freeze({
    failures,
    fetch,
    closeAdmission: () => {
      acceptingCallbacks = false;
    },
    drain: async () => {
      await Promise.allSettled(activeCallbacks);
    },
  });
}

function createInvocationMiniflare(
  bundle: string,
  serviceBinding: V4FetchHandler,
): Miniflare {
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: [
        {
          type: "ESModule",
          path: "private-workerd-sandbox-worker.mjs",
          contents: bundle,
        },
      ],
      compatibilityDate: "2026-09-02",
      compatibilityFlags: ["nodejs_compat"],
      workerLoaders: { LOADER: {} },
      serviceBindings: { INVOCATION: serviceBinding },
    }),
  );
}

async function dispatchInvocation(
  miniflare: Miniflare,
  request: SandboxRequest,
  signal: AbortSignal,
): Promise<SandboxResult> {
  let response: MiniflareResponse;
  const startedAt = performance.now();
  let startedDispatch = false;
  try {
    // Bun's built-in undici Pool ignores Miniflare's zero-timeout settings;
    // dispatchFetch inherits Bun.fetch's 300 s idle timer. Use the public
    // workerd listener with node:http, whose request has no implicit deadline.
    // Mycelium's signal remains the invocation's cancellation authority.
    const url = new URL("/execute", await miniflare.ready);
    startedDispatch = true;
    response = await new Promise<MiniflareResponse>((resolve, reject) => {
      const outgoing = httpRequest(
        url,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          agent: false,
          signal,
        },
        (incoming) => {
          resolve(
            new MiniflareResponse(incoming, {
              status: incoming.statusCode ?? 500,
            }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(
        JSON.stringify({
          code: request.code,
          timeoutMs: request.timeoutMs,
          bindings: sandboxBindingNames(request.bindings),
          namespacePaths: request.namespacePaths ?? {},
        }),
      );
    });
  } catch (cause) {
    return {
      ok: false,
      cause: signal.aborted
        ? new Cancelled({ by: "caller" })
        : startedDispatch
          ? new DispatchLost({
              elapsedMs: Math.round(performance.now() - startedAt),
              transport: "node:http",
              errno: sandboxTransportErrno(cause),
              rawCause: cause,
            })
          : new SandboxCrashed({ rawCause: cause }),
    };
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    return {
      ok: false,
      cause: new BadResponse({
        reason: "response is not JSON",
        rawCause: cause,
      }),
    };
  }
  const parsed = sandboxWireSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      cause: new BadResponse({
        reason: "response does not match sandbox envelope",
        rawCause: parsed.error,
      }),
    };
  }
  const envelope = parsed.data;
  return envelope.ok
    ? { ok: true, value: envelope.value }
    : {
        ok: false,
        cause: sandboxWireFailure(envelope.error),
      };
}

function createDisposal(
  miniflare: Miniflare,
  callbacks: InvocationCallbacks,
): () => Promise<void> {
  let disposal: Promise<void> | undefined;
  return () => {
    callbacks.closeAdmission();
    disposal ??= miniflare.dispose();
    return disposal;
  };
}

async function awaitCleanup(
  disposal: Promise<void>,
  callbacks: InvocationCallbacks,
): Promise<void> {
  const [disposed] = await Promise.allSettled([disposal, callbacks.drain()]);
  if (disposed.status === "rejected") throw disposed.reason;
}

async function executeInvocation(
  request: SandboxRequest,
  signal: AbortSignal,
): Promise<SandboxValue> {
  signal.throwIfAborted();
  let bundle: string;
  try {
    bundle = await workerBundle;
  } catch (rawCause) {
    throw new SandboxCrashed({ rawCause });
  }
  signal.throwIfAborted();
  const callbacks = createInvocationCallbacks(request);
  let miniflare: Miniflare;
  try {
    miniflare = createInvocationMiniflare(bundle, callbacks.fetch);
  } catch (rawCause) {
    throw new SandboxCrashed({ rawCause });
  }
  const beginDisposal = createDisposal(miniflare, callbacks);
  const onAbort = (): void => {
    void beginDisposal().catch((cause: unknown) => {
      console.error("Local workerd disposal failed", cause);
      return undefined;
    });
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });

  let result: SandboxResult;
  try {
    signal.throwIfAborted();
    result = await dispatchInvocation(miniflare, request, signal);
  } catch (cause) {
    result = { ok: false, cause: sandboxFailure(cause) };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }

  try {
    await awaitCleanup(beginDisposal(), callbacks);
  } catch (cause) {
    // Disposal is an operator annotation. Keep the original guest/transport outcome.
    console.error("sandbox_cleanup_failure", {
      executionId: request.executionId,
      rawCause: cause,
    });
  }
  if (!result.ok) {
    throw recoverSandboxFailure(result.cause, callbacks.failures);
  }
  return result.value;
}

/** Construct the private per-invocation workerd Sandbox. */
export function createPrivateWorkerdSandbox(): Sandbox {
  return Object.freeze({
    adapter: "local-workerd",
    execute: async (request: SandboxRequest, signal: AbortSignal) => {
      try {
        return await executeInvocation(request, signal);
      } catch (cause) {
        throw signal.aborted
          ? new Cancelled({ by: "caller" })
          : sandboxFailure(cause);
      }
    },
  });
}
