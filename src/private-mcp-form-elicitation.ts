import type { Client, ElicitResult } from "@modelcontextprotocol/client";
import { AsyncLocalStorage } from "node:async_hooks";
import { addAbortListener } from "node:events";
import * as Schema from "effect/Schema";
import {
  McpFormApprovalRequestSchema,
  type McpFormApprovalRequest,
  type McpFormApprovalDecision,
} from "./private-mcp-form-contract.js";

const decodePendingForm = Schema.decodeUnknownSync(
  McpFormApprovalRequestSchema,
);

/** Host-owned human interaction. No callback means immediate cancellation. */
export type RequestMcpFormApproval = (
  pending: McpFormApprovalRequest,
  signal: AbortSignal,
  /** Session captured by source acquisition, never supplied by tool arguments. */
  sessionId: string | undefined,
) => Promise<McpFormApprovalDecision>;

/** A refused form is a failed tool call, not an uncertain transport outcome. */
export class McpFormApprovalError extends Error {
  readonly kind = "mcp_approval_refused";

  constructor(readonly reason: "declined" | "cancelled") {
    super(`MCP approval was ${reason}.`);
    this.name = "McpFormApprovalError";
  }
}

/** Discriminant carried in a failed MCP tool result's structuredContent. */
export type McpFormApprovalRefusal = Readonly<
  Pick<McpFormApprovalError, "kind" | "reason">
>;

type FormCall = {
  signal: AbortSignal;
  cancel: () => void;
  pending: number;
  failure?: McpFormApprovalError;
};

export function registerMcpFormElicitation(
  client: Client,
  requestApproval: RequestMcpFormApproval | undefined,
  sessionId: string | undefined,
) {
  // The producer sends its form on the requesting tools/call response stream.
  // Keep that call's refusal local even when another call shares this client.
  const calls = new AsyncLocalStorage<FormCall>();
  const lifetime = new AbortController();
  const close = () => {
    lifetime.abort();
    calls.disable();
  };
  client.onclose = close;
  client.registerCapabilities({ elicitation: { form: {} } });
  client.setRequestHandler(
    "elicitation/create",
    async (request, context): Promise<ElicitResult> => {
      const call = calls.getStore();
      if (call === undefined || call.failure !== undefined)
        return { action: "cancel" };
      const signal = AbortSignal.any([call.signal, context.mcpReq.signal]);
      let abortListener: ReturnType<typeof addAbortListener> | undefined;
      call.pending++;
      try {
        signal.throwIfAborted();
        const pending = decodePendingForm(request.params);
        const aborted = new Promise<never>((_resolve, reject) => {
          abortListener = addAbortListener(signal, () => {
            reject(new McpFormApprovalError("cancelled"));
          });
        });
        const decision = await Promise.race([
          requestApproval === undefined
            ? Promise.resolve<McpFormApprovalDecision>("cancel")
            : Promise.resolve().then(() =>
                requestApproval(pending, signal, sessionId),
              ),
          aborted,
        ]);
        // Cancellation wins over a late Approve, including a UI ignoring abort.
        signal.throwIfAborted();
        if (decision === "approve")
          return { action: "accept", content: { approve: true } };
        call.failure ??= new McpFormApprovalError(
          decision === "decline" ? "declined" : "cancelled",
        );
        call.cancel();
        return { action: decision };
      } catch {
        call.failure ??= new McpFormApprovalError("cancelled");
        call.cancel();
        return { action: "cancel" };
      } finally {
        call.pending--;
        abortListener?.[Symbol.dispose]();
      }
    },
  );
  return {
    close,
    run: <T>(
      signal: AbortSignal,
      invoke: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> => {
      const settled = new AbortController();
      const call: FormCall = {
        signal: AbortSignal.any([signal, lifetime.signal, settled.signal]),
        cancel: () => {
          settled.abort();
        },
        pending: 0,
      };
      return calls.run(call, async () => {
        try {
          const result = await invoke(call.signal);
          if (call.failure !== undefined) throw call.failure;
          return result;
        } catch (cause) {
          if (call.failure !== undefined) throw call.failure;
          if (call.pending > 0) throw new McpFormApprovalError("cancelled");
          throw cause;
        } finally {
          settled.abort();
        }
      });
    },
  };
}
