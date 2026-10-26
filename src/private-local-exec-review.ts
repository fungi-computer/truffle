import type { LocalApprovalReview } from "./private-mcp-form-session.js";
import { gitRuleCoverage, rulePrefix } from "./private-local-exec-rules.js";

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
  gitGrant?: { configuredRemotes: ReadonlySet<string> },
): LocalApprovalReview {
  if (request.escape === undefined)
    throw new Error("An escape requires a justification");
  const command =
    request.command ??
    JSON.stringify([request.executable, ...(request.args ?? [])]);
  const prefix =
    request.executable === undefined ||
    (request.executable === "git" && gitGrant === undefined)
      ? undefined
      : rulePrefix(
          [request.executable, ...(request.args ?? [])],
          gitGrant?.configuredRemotes,
        );
  const review: LocalApprovalReview = {
    command,
    cwd,
    justification: request.escape.justification,
  };
  if (prefix !== undefined) {
    review.prefix = prefix;
    review.alwaysAllowCoverage =
      prefix[0] === "git"
        ? gitRuleCoverage(prefix[1] ?? "")
        : `Direct argv commands beginning ${JSON.stringify(prefix)} in this project; shell commands still ask.`;
  }
  if (request.executable === "git") {
    const hookCapable = gitHookGrantSubcommands.has(request.args?.[0] ?? "");
    review.warning =
      (hookCapable
        ? "Project hooks can run code as you under this grant. Only the hooksPath setting must pre-exist; this Agent can create missing hook files there. A configured fsmonitor path in the worktree may also be Agent-writable."
        : "This command runs as you outside the sandbox.") +
      (request.args?.[0] === "push"
        ? " This grant can push all branches, force-update them, or delete remote branches."
        : "") +
      (["push", "fetch", "pull"].includes(request.args?.[0] ?? "")
        ? " Remote URLs can invoke ssh with your HOME and keys."
        : "");
  }
  if (prefix === undefined)
    review.alwaysAllowUnavailableReason =
      request.executable === undefined
        ? "Shell command text cannot match a saved argv rule; Approve once or Deny."
        : request.executable === "git" && gitGrant === undefined
          ? "A protected project Git repository is unavailable; no reusable Git rule can match."
          : "This command or option cannot match a safe reusable rule; Approve once or Deny.";
  return review;
}
