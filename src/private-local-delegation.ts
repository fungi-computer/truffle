import type { BirdDogMail } from "@fungi.computer/bird-dog";
import { deterministicReplayKey } from "@fungi.computer/cairn";
import type {
  Accepted,
  CommandSettlement,
  VerifiedAgentReply,
} from "@fungi.computer/shiitake";
import type {
  AgentControlDirectory,
  AgentDelegationInput,
  AgentDelegationInvocation,
} from "@fungi.computer/shiitake/agent-control";
import {
  createFleetDelegation,
  delegationProvenance,
  delegationReplyMeta,
  delegationSendMeta,
} from "@fungi.computer/shiitake/fleet";

/** How long one Local delegation grant stays valid while it is admitted. */
const grantLifetimeMs = 60_000;

/**
 * The Local service's project mail routing, shared by every Agent it owns.
 * `deliver` admits frozen mail at its addressed Agent, opening that Agent's
 * owner when it is idle; `readSettlement` reads one exact command there.
 */
export type PrivateLocalMailRouting = Readonly<{
  deliver: (mail: BirdDogMail) => Promise<Accepted>;
  readSettlement: (
    agentId: string,
    sessionId: string,
    commandId: string,
  ) => Promise<CommandSettlement | undefined>;
}>;

/**
 * One Local Agent's side of delegation, over the same fleet contract as the
 * Hub: a `followUp` send freezes BirdDog mail in this Agent's store, and an
 * arriving reply is admitted only after `fleet.authenticateReply` checks it
 * against that frozen mail. The replying child authors the reply line.
 */
export function createPrivateLocalDelegation(
  input: Readonly<{
    agentId: string;
    storage: Parameters<typeof createFleetDelegation>[0]["storage"];
    directory: AgentControlDirectory;
    routing: PrivateLocalMailRouting;
    accept: (
      mail: BirdDogMail,
      meta?: BirdDogMail["meta"],
      reply?: VerifiedAgentReply,
    ) => Promise<Accepted>;
  }>,
) {
  const fleet = createFleetDelegation({
    storage: input.storage,
    deliver: input.routing.deliver,
    readSettlement: input.routing.readSettlement,
    open: (agentId) =>
      input.directory.open(agentId, new AbortController().signal),
  });

  async function members(signal: AbortSignal) {
    return (await input.directory.list(signal)).map(({ agentId, name }) => ({
      agentId,
      name,
    }));
  }

  /** Delegate follow-up work; its reply returns to the invoking Session. */
  async function send(
    task: AgentDelegationInput,
    sourceSessionId: string,
    signal: AbortSignal,
    invocation?: AgentDelegationInvocation,
  ): Promise<Accepted> {
    if (invocation === undefined)
      throw new Error("Delegation requires a tool invocation");
    const agents = await members(signal);
    if (!agents.some(({ agentId }) => agentId === task.agentId))
      throw new Error("Agent is outside this Local project");
    const meta = delegationSendMeta(
      { id: input.agentId, name: input.agentId },
      invocation.meta,
    );
    const provenance = await delegationProvenance(
      { agentId: input.agentId, sessionId: sourceSessionId },
      invocation.toolCallCode,
    );
    const requestId = await deterministicReplayKey("local-agent-delegation", [
      input.agentId,
      sourceSessionId,
      invocation.commandId ?? "",
      invocation.toolCallId,
      String(invocation.sendIndex),
    ]);
    signal.throwIfAborted();
    return fleet.start(
      {
        agents: agents.map(({ agentId }) => agentId),
        actions: ["delegate"],
        expiresAt: Date.now() + grantLifetimeMs,
        provenance,
        meta,
      },
      { ...task, requestId },
    );
  }

  /**
   * Admit one mail addressed to this Agent. New work must name its sender as
   * its only reply destination; a reply-less mail is admitted only as an
   * authenticated reply. Everything else is refused.
   */
  async function receive(mail: BirdDogMail): Promise<Accepted> {
    if (mail.to.agentId !== input.agentId)
      throw new Error("Local addressed mail recipient is not authorized");
    const agents = await members(new AbortController().signal);
    if (!agents.some(({ agentId }) => agentId === mail.from.agentId))
      throw new Error("Local mail sender is outside this project");
    if (mail.replyTo.length > 0) {
      const [destination] = mail.replyTo;
      if (
        mail.replyTo.length !== 1 ||
        destination?.agentId !== mail.from.agentId ||
        destination.sessionId !== mail.from.sessionId
      )
        throw new Error("Local delegated work must reply to its sender");
      return input.accept(mail, mail.meta);
    }
    const delegation = fleet.authenticateReply(mail);
    if (delegation === undefined)
      throw new Error("Local reply does not match work this Agent sent");
    const replier = agents.find(
      ({ agentId }) => agentId === delegation.reply.agentId,
    );
    if (replier === undefined)
      throw new Error("Local reply sender is outside this project");
    const meta = delegationReplyMeta(delegation, replier.name);
    return input.accept({ ...mail, meta }, meta, delegation.reply);
  }

  /** The distinct Agents one of this Agent's Sessions sent work to. */
  function recipients(sessionId: string, limit: number) {
    return fleet.recipients({ agentId: input.agentId, sessionId }, limit);
  }

  return { send, receive, recipients };
}
