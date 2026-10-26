import { correlationKey } from "@fungi.computer/cairn";
import type {
  Approvals,
  ApprovalView,
  PendingApproval,
} from "@fungi.computer/approvals";
import { defineExtension } from "@fungi.computer/shiitake/extensions";
import type { ShiitakeSession } from "@fungi.computer/shiitake";
import * as Effect from "effect/Effect";
import {
  mcpFormApprovalContract,
  type McpFormAnswerResult,
} from "./private-mcp-form-contract.js";
import {
  consumeLocalUiCommand,
  runLocalUiCommand,
  startLocalUiWatch,
  type LocalUiAttachment,
} from "./private-local-ui-attachment.js";

export type LocalApprovalReview = {
  command: string;
  cwd: string;
  justification: string;
  prefix?: readonly string[];
  warning?: string;
};

type Pending = {
  sessionId: string;
  approval: ApprovalView;
  approvals: Approvals;
  answering: boolean;
  review: LocalApprovalReview | undefined;
  alwaysAllow: ((selected: "prefix" | false) => void) | undefined;
};

const maximumPendingForms = 100;

/** Host-owned references to canonical approvals; no suspended tool or second ledger. */
export function createMcpFormSession() {
  const pending = new Map<string, Pending>();
  let publish: ((sessionId: string) => Promise<void>) | undefined;
  const extension = defineExtension({
    id: mcpFormApprovalContract.id,
    version: "1.0.0",
  }).define({
    commands: {
      specs: mcpFormApprovalContract.commands,
      handlers: (context) => ({
        answer: ({ sessionId, input }) =>
          Effect.gen(function* () {
            const onComplete = consumeLocalUiCommand(sessionId);
            if (onComplete === undefined) {
              const result: McpFormAnswerResult = {
                kind: "refused",
                reason: "not-attached",
              };
              return result;
            }
            const entry = pending.get(input.id);
            if (entry?.sessionId !== sessionId) {
              const result: McpFormAnswerResult = {
                kind: "refused",
                reason: "not-pending",
              };
              return result;
            }
            if (entry.answering) {
              const result: McpFormAnswerResult = {
                kind: "refused",
                reason: "in-flight",
              };
              return result;
            }
            entry.answering = true;
            onComplete(async (committed) => {
              try {
                if (!committed)
                  return { kind: "refused", reason: "not-attached" };
                // Session commit and live UI recheck precede the canonical
                // decision. Its bound host, never MCP accept, owns apply.
                if (
                  input.decision === "always-allow" &&
                  entry.alwaysAllow === undefined
                )
                  return { kind: "refused", reason: "not-pending" };
                if (input.decision === "always-allow")
                  entry.alwaysAllow?.("prefix");
                const result = await entry.approvals.answer({
                  recordId: entry.approval.record.recordId,
                  decision:
                    input.decision === "always-allow"
                      ? "approve"
                      : input.decision,
                  expectedRevision: input.expectedRevision,
                });
                return result;
              } finally {
                entry.alwaysAllow?.(false);
                entry.answering = false;
                const view = await entry.approvals.get({
                  recordId: entry.approval.record.recordId,
                });
                if (view?.record.state !== "pending") pending.delete(input.id);
                else entry.approval = view;
                await publish?.(sessionId);
              }
            });
            yield* context.observe(sessionId);
            const result: McpFormAnswerResult = { kind: "submitted" };
            return result;
          }),
      }),
    },
    hooks: {
      start: (context) => {
        publish = (sessionId) =>
          Effect.runPromise(context.transact(context.observe(sessionId)));
      },
    },
    projection: {
      schema: mcpFormApprovalContract.projection.schema,
      read: (_context, sessionId) => ({
        pending: [...pending.entries()]
          .filter(([, entry]) => entry.sessionId === sessionId)
          .map(([id, entry]) => {
            const item = { id, approval: entry.approval };
            return entry.review === undefined
              ? item
              : { ...item, review: entry.review };
          }),
      }),
    },
  });
  /**
   * Native host port, never a model or UI command. The caller supplies the
   * actual submit result and a member-bound capability, not form JSON.
   */
  async function presentApproval(
    sessionId: string,
    submitted: PendingApproval,
    approvals: Approvals,
    review?: Pending["review"],
    alwaysAllow?: (selected: "prefix" | false) => void,
  ) {
    const approval = await approvals.get({ recordId: submitted.recordId });
    if (
      approval?.record.state !== "pending" ||
      approval.record.requester.sessionId !== sessionId
    )
      return { kind: "refused", reason: "not-pending" } as const;
    const existing = [...pending.entries()].find(
      ([, entry]) =>
        entry.sessionId === sessionId &&
        entry.approval.record.recordId === submitted.recordId,
    );
    if (existing !== undefined) {
      const [id, entry] = existing;
      entry.approval = approval;
      entry.approvals = approvals;
      entry.review = review;
      entry.alwaysAllow = alwaysAllow;
      await publish?.(sessionId);
      return { kind: "presented", id } as const;
    }
    if (pending.size >= maximumPendingForms)
      return { kind: "refused", reason: "capacity" } as const;
    const id = correlationKey();
    pending.set(id, {
      sessionId,
      approval,
      approvals,
      answering: false,
      review,
      alwaysAllow,
    });
    await publish?.(sessionId);
    return { kind: "presented", id } as const;
  }
  function bindSession(
    sessionId: string,
    session: ShiitakeSession,
    attachment: LocalUiAttachment | undefined,
  ): ShiitakeSession {
    if (attachment === undefined) return session;
    return {
      ...session,
      extension: (id) => {
        const client = session.extension(id);
        return {
          ...client,
          call: (command, input) =>
            id === mcpFormApprovalContract.id && command === "answer"
              ? runLocalUiCommand(attachment, sessionId, () =>
                  client.call(command, input),
                )
              : client.call(command, input),
        };
      },
      watch: async (input) => {
        const stopWatching = startLocalUiWatch(attachment, sessionId);
        if (stopWatching === undefined) return session.watch(input);
        try {
          const watch = await session.watch(input);
          return {
            ...watch,
            close: async () => {
              stopWatching();
              await watch.close();
            },
          };
        } catch (error) {
          stopWatching();
          throw error;
        }
      },
    };
  }
  return { extension, presentApproval, bindSession };
}
