import type { LocalApprovalReview } from "./private-mcp-form-session.js";
import { rulePrefix } from "./private-local-exec-rules.js";

const gitHookGrantSubcommands = new Set([
  "add",
  "branch",
  "checkout",
  "commit",
  "diff",
  "fetch",
  "merge",
  "pull",
  "push",
  "reset",
  "restore",
  "stash",
  "status",
  "switch",
  "tag",
]);

/** Build the host's review before the approval record is staged or displayed. */
export function localExecEscapeReview(
  request: {
    command?: string | undefined;
    executable?: string | undefined;
    args?: string[] | undefined;
    escape?: { justification: string } | undefined;
  },
  cwd: string,
): LocalApprovalReview {
  if (request.escape === undefined)
    throw new Error("An escape requires a justification");
  const command =
    request.command ??
    JSON.stringify([request.executable, ...(request.args ?? [])]);
  const prefix =
    request.executable === undefined
      ? undefined
      : rulePrefix([request.executable, ...(request.args ?? [])]);
  const review: LocalApprovalReview = {
    command,
    cwd,
    justification: request.escape.justification,
  };
  if (prefix !== undefined) {
    review.prefix = prefix;
    if (prefix[0] === "git") {
      const hookCapable = gitHookGrantSubcommands.has(prefix[1] ?? "");
      review.warning =
        (hookCapable
          ? "Project hooks can run code as you under this grant. Only the hooksPath setting must pre-exist; this Agent can create missing hook files there. A configured fsmonitor path in the worktree may also be Agent-writable."
          : "This command runs as you outside the sandbox.") +
        (prefix[1] === "push"
          ? " This grant can push all branches, force-update them, or delete remote branches."
          : "") +
        (["push", "fetch", "pull"].includes(prefix[1] ?? "")
          ? " Remote URLs can invoke ssh with your HOME and keys."
          : "");
    }
  }
  return review;
}
