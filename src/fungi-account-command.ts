import type { FetchLike } from "@modelcontextprotocol/client";
import {
  readFungiAccountStatus,
  readFungiAccountTeams,
  readFungiTeamBalance,
  switchFungiAccountTeam,
  type FungiAccountTeam,
  type FungiTeamBalance,
  type FungiTeamCredit,
} from "./private-fungi-account.js";

export type FungiAccountCommand =
  | Readonly<{ action: "status" | "teams" | "balance" }>
  | Readonly<{ action: "use-team"; teamId: string }>;

export type FungiAccountCommandOptions = Readonly<{
  json: boolean;
  stdout: Readonly<{ write: (text: string) => void }>;
  credentialPath?: string | undefined;
  fetch?: FetchLike | undefined;
}>;

/** What the account owner reads with: a credential home and a Hub transport. */
type AccountOwnerOptions = { credentialPath?: string; fetch?: FetchLike };

/** Every `--json` reply; each is built from named non-secret fields only. */
type AccountStatusReply =
  | { signedIn: false }
  | {
      signedIn: true;
      hub: string;
      team?: FungiAccountTeam;
      teamCount?: number;
      accessExpiresAt: string;
    };
type AccountReply =
  | AccountStatusReply
  | { teams: (FungiAccountTeam & { selected: boolean })[] }
  | { team: FungiAccountTeam | undefined }
  | { kind: "balance"; teamId: string; credit: Omit<FungiTeamCredit, "teamId"> }
  | {
      kind: "not-available";
      reason: Extract<FungiTeamBalance, { kind: "not-available" }>["reason"];
    };

export const fungiAccountCommandHelp = `Usage: fungi account [--json]
       fungi account teams [--json]
       fungi account use-team <team-id>
       fungi account balance [--json]

Read the signed-in Fungi account without exposing its credentials. The plain
command shows the Hub and the Team that pays for models; teams lists your
current memberships; use-team selects one of them (the prior Team is kept when
you are not a current member); balance reads that Team's credit when you may
see its billing.
`;

function teamFields({ teamId, handle, name }: FungiAccountTeam) {
  return { teamId, handle, name };
}

/** `fungi account`: non-secret reads over Local's one Fungi account owner. */
export async function runFungiAccountCommand(
  command: FungiAccountCommand,
  options: FungiAccountCommandOptions,
): Promise<void> {
  const owner: AccountOwnerOptions = {};
  if (options.credentialPath !== undefined)
    owner.credentialPath = options.credentialPath;
  if (options.fetch !== undefined) owner.fetch = options.fetch;
  const emit = (reply: AccountReply, text: string) => {
    options.stdout.write(
      options.json
        ? `${JSON.stringify({ schemaVersion: 1, ...reply })}\n`
        : `${text}\n`,
    );
  };
  if (command.action === "use-team") {
    await switchFungiAccountTeam(command.teamId, owner);
    const team = (await readFungiAccountStatus(owner))?.team;
    emit(
      { team: team === undefined ? undefined : teamFields(team) },
      `Fungi models now bill ${team?.name ?? command.teamId}.`,
    );
    return;
  }
  if (command.action === "teams") {
    const { teams, selectedTeamId } = await readFungiAccountTeams(owner);
    emit(
      {
        teams: teams.map((team) => ({
          ...teamFields(team),
          selected: team.teamId === selectedTeamId,
        })),
      },
      teams
        .map(
          (team) =>
            `${team.teamId === selectedTeamId ? "*" : " "} ${team.name} (${team.handle}) ${team.teamId}`,
        )
        .join("\n") || "You are not a member of any Team.",
    );
    return;
  }
  if (command.action === "balance") {
    const balance = await readFungiTeamBalance(owner);
    emit(balanceReply(balance), balanceText(balance));
    return;
  }
  const status = await readFungiAccountStatus(owner);
  if (status === undefined) {
    emit(
      { signedIn: false },
      "Not signed in to Fungi. Run fungi login --provider fungi.",
    );
    return;
  }
  const reply: AccountStatusReply = {
    signedIn: true,
    hub: status.issuer,
    accessExpiresAt: status.accessExpiresAt.toISOString(),
  };
  if (status.team !== undefined) reply.team = teamFields(status.team);
  if (status.teamCount !== undefined) reply.teamCount = status.teamCount;
  emit(
    reply,
    `Signed in to ${status.issuer}. ${status.team === undefined ? "No Team selected for Fungi models." : `Fungi models bill ${status.team.name} (${status.team.handle}).`}`,
  );
}

function balanceReply(balance: FungiTeamBalance) {
  if (balance.kind === "not-available")
    return {
      kind: balance.kind,
      reason: balance.reason,
    } satisfies AccountReply;
  const { teamId, ...credit } = balance.credit;
  return { kind: balance.kind, teamId, credit } satisfies AccountReply;
}

function dollars(money: FungiTeamCredit["available"]): string {
  const cents = BigInt(money.amount) / 10n ** BigInt(money.scale - 2);
  const whole = cents / 100n;
  const rest = (cents % 100n).toString().padStart(2, "0");
  return `$${whole.toString()}.${rest}`;
}

function balanceText(balance: FungiTeamBalance): string {
  if (balance.kind === "balance")
    return `Available ${dollars(balance.credit.available)} (purchased ${dollars(balance.credit.balance)}, reserved ${dollars(balance.credit.reserved)}${balance.credit.included === null ? "" : `, included ${dollars(balance.credit.included.remaining)} left`}).`;
  if (balance.reason === "no-team")
    return "No Team selected. Run fungi account use-team <team-id>.";
  if (balance.reason === "not-a-member")
    return "You are not a current member of the selected Team. Run fungi account teams.";
  if (balance.reason === "sign-in-again")
    return "This sign-in lacks billing permission. Run fungi login --provider fungi again.";
  return "This Fungi Hub does not admit Local sign-ins for Team balance.";
}
