import { DynamicWorkerExecutor, normalizeCode } from "@cloudflare/codemode";
import {
  submittedSourceLocation,
  sandboxGuestProgram,
  sandboxBindingNamesSchema,
  sandboxNamespacePathsSchema,
  sandboxGuestResultSchema,
} from "@fungi.computer/mycelium/sandbox-guest";
import {
  sandboxOperatorValue,
  sandboxValueKind,
} from "@fungi.computer/mycelium/sandbox-boundary";
import { RpcTarget } from "cloudflare:workers";
import { z } from "zod";

const jsonValueSchema = z.json();
const sandboxRequestSchema = z.strictObject({
  code: z.string(),
  timeoutMs: z.number().int().min(1),
  bindings: sandboxBindingNamesSchema,
  namespacePaths: sandboxNamespacePathsSchema,
});
const bindingResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ ok: z.literal(true), value: jsonValueSchema }),
  z.strictObject({
    ok: z.literal(false),
    error: z.discriminatedUnion("code", [
      z.strictObject({
        code: z.literal("no_such_operation"),
        path: z.string().max(321),
        suggestions: z.array(z.string().max(160)).max(3),
      }),
      z.strictObject({
        code: z.enum(["invalid_input", "operation_failed", "closing"]),
        message: z.string().max(512),
      }),
    ]),
  }),
]);
function failedResponse(error) {
  return globalThis.Response.json({ ok: false, error }, { status: 400 });
}

class InvocationBindingTarget extends RpcTarget {
  #binding;
  #namespace;

  constructor(binding, namespace) {
    super();
    this.#binding = binding;
    this.#namespace = namespace;
  }

  async callTool(operation, input) {
    const response = await this.#binding.fetch("http://invocation.local/call", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        namespace: this.#namespace,
        operation,
        input,
      }),
    });
    const envelope = bindingResponseSchema.parse(await response.json());
    if (!envelope.ok) {
      if (envelope.error.code === "no_such_operation") {
        const { path, suggestions } = envelope.error;
        const hint =
          suggestions.length === 0
            ? "Use forage.search to discover available operations."
            : `Did you mean ${suggestions.join(", ")}?`;
        const cause = new Error(`No such operation ${path}. ${hint}`);
        cause.name = "NoSuchOperationError";
        throw cause;
      }
      throw new Error(envelope.error.message);
    }
    return envelope.value;
  }
}

export default {
  async fetch(request, environment) {
    let input;
    try {
      input = sandboxRequestSchema.parse(await request.json());
    } catch {
      return failedResponse({
        kind: "bad_response",
        reason: "invalid sandbox request",
        rawCause: null,
      });
    }

    const normalized = normalizeCode(input.code);
    const location = submittedSourceLocation(normalized, input.code);
    if (location !== null)
      return failedResponse({ kind: "invalid_source", ...location });
    const startedAt = Date.now();
    let output;
    try {
      const connectors = Object.keys(input.bindings).map((namespace) => ({
        name: namespace,
        binding: new InvocationBindingTarget(environment.INVOCATION, namespace),
      }));
      const executor = new DynamicWorkerExecutor({
        loader: environment.LOADER,
        timeout: input.timeoutMs,
        globalOutbound: null,
      });
      output = await executor.execute(
        sandboxGuestProgram(normalized, input.bindings, input.namespacePaths),
        [],
        {
          connectors,
        },
      );
    } catch (cause) {
      return failedResponse({
        kind: "sandbox_crashed",
        rawCause: sandboxOperatorValue(cause),
      });
    }
    if (output.error !== undefined)
      return failedResponse(
        output.error === "Execution timed out"
          ? {
              kind: "deadline_exceeded",
              limitMs: input.timeoutMs,
              elapsedMs: Date.now() - startedAt,
            }
          : {
              kind: "bad_response",
              reason: "executor failed outside guest handler",
              rawCause: output.error,
            },
      );
    const guest = sandboxGuestResultSchema.safeParse(output.result);
    if (!guest.success)
      return failedResponse({
        kind: "bad_response",
        reason: "invalid guest envelope",
        rawCause: sandboxOperatorValue(guest.error),
      });
    if (!guest.data.ok) return failedResponse(guest.data.error);
    try {
      return globalThis.Response.json({
        ok: true,
        value: jsonValueSchema.parse(guest.data.value),
      });
    } catch (cause) {
      return failedResponse({
        kind: "result_not_json",
        valueKind: sandboxValueKind(guest.data.value),
        rawCause: sandboxOperatorValue(cause),
      });
    }
  },
};
