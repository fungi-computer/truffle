import type { LocalApprovalReview } from "./private-mcp-form-session.js";
import { gitRuleCoverage, rulePrefix } from "./private-local-exec-rules.js";
import { quote } from "shell-quote";

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
  const argv =
    request.executable === undefined
      ? undefined
      : [request.executable, ...(request.args ?? [])];
  const command = request.command ?? quote(argv ?? []);
  const prefix =
    argv === undefined || (argv[0] === "git" && gitGrant === undefined)
      ? undefined
      : rulePrefix(argv, gitGrant?.configuredRemotes);
  const review: LocalApprovalReview = {
    command,
    cwd,
    justification: request.escape.justification,
    form: argv === undefined ? "shell" : "direct",
    kind:
      argv?.[0] === "fungi" && argv[1] === "extension" && argv[2] === "add"
        ? "extension-install"
        : "exec",
  };
  if (argv !== undefined) review.argv = argv;
  if (prefix !== undefined && review.kind === "exec") {
    review.prefix = prefix;
    review.alwaysAllowCoverage =
      prefix[0] === "git"
        ? gitRuleCoverage(prefix[1] ?? "")
        : `Direct argv commands beginning ${JSON.stringify(prefix)} in this project; shell commands still ask.`;
    if (prefix[0] === "git") {
      const hookCapable = gitHookGrantSubcommands.has(prefix[1] ?? "");
      const summary =
        (hookCapable
          ? "Git hooks in this project can run code as you, and this Agent can add hooks."
          : "This Git command will run outside the sandbox, as you.") +
        (prefix[1] === "push"
          ? " It can push, force-push or delete any branch."
          : "") +
        (["push", "fetch", "pull"].includes(prefix[1] ?? "")
          ? " Remotes can use your SSH keys."
          : "");
      const detail =
        (hookCapable
          ? "Git runs hook scripts from the folder the project's hooksPath setting names. That setting must already exist, but this Agent can add hook files there. A configured fsmonitor program in this folder may also be writable by this Agent."
          : summary) +
        (prefix[1] === "push"
          ? " A push grant can push all branches, force-update them or delete remote branches."
          : "") +
        (["push", "fetch", "pull"].includes(prefix[1] ?? "")
          ? " Remote URLs can run ssh with your HOME and keys."
          : "");
      review.risk = { summary, detail };
    } else {
      const summary = `Every \`${prefix.join(" ")} …\` command will run outside the sandbox, as you.`;
      review.risk = { summary, detail: summary };
    }
  }
  if (request.executable === "git") {
    const hookCapable = gitHookGrantSubcommands.has(request.args?.[0] ?? "");
    review.warning =
      (hookCapable
        ? `Project hooks can run code as you ${review.prefix === undefined ? "when this command runs" : "under this grant"}. Only the hooksPath setting must pre-exist; this Agent can create missing hook files there. A configured fsmonitor path in the worktree may also be Agent-writable.`
        : "This command runs as you outside the sandbox.") +
      (request.args?.[0] === "push"
        ? " This grant can push all branches, force-update them, or delete remote branches."
        : "") +
      (["push", "fetch", "pull"].includes(request.args?.[0] ?? "")
        ? " Remote URLs can invoke ssh with your HOME and keys."
        : "");
  }
  if (review.kind === "extension-install")
    review.alwaysAllowUnavailableReason =
      "Extension installs require a fresh approval; no reusable rule applies.";
  else if (review.prefix === undefined)
    review.alwaysAllowUnavailableReason =
      request.executable === undefined
        ? "Shell command text cannot match a saved argv rule; Approve once or Deny."
        : request.executable === "git" && gitGrant === undefined
          ? "A protected project Git repository is unavailable; no reusable Git rule can match."
          : "This command or option cannot match a safe reusable rule; Approve once or Deny.";
  return review;
}
