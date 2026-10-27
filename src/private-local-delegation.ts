import type { BirdDogMail } from "@fungi.computer/bird-dog";
import type {
  Accepted,
  CancelResult,
  CommandSettlement,
  DelegationReceipt,
  VerifiedAgentReply,
} from "@fungi.computer/shiitake";
import type {
  AgentControlDirectory,
  AgentDelegationInput,
  AgentDelegationInvocation,
  AgentRecallInput,
} from "@fungi.computer/shiitake/agent-control";
import { AgentArchiveRefused } from "@fungi.computer/shiitake/agent-control";
import {
  agentDelegationRequestKey,
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
  deliver: (mail: BirdDogMail) => Promise<DelegationReceipt>;
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
    directory: Pick<AgentControlDirectory, "list" | "open">;
    routing: PrivateLocalMailRouting;
    /** Current Team role of this physical store, projected by its enrolled link. */
    meshAdmission?:
      | ((
          recipientAgentId: string,
        ) => Promise<readonly { agentId: string; name: string }[] | undefined>)
      | undefined;
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

  async function authorizedMembers(agentId: string, signal: AbortSignal) {
    const agents = await members(signal);
    if (!agents.some(({ agentId: memberId }) => memberId === agentId)) {
      const archived = await input.directory.list(signal, { archived: true });
      if (archived.some(({ agentId: memberId }) => memberId === agentId))
        throw new AgentArchiveRefused(
          "archived",
          `Agent ${agentId} is archived; unarchive it to send it work`,
        );
      throw new Error("Agent is outside this Local project");
    }
    return agents;
  }

  /** Send with one caller-owned identity; follow-up replies return here. */
  async function send(
    task: AgentDelegationInput,
    sourceSessionId: string,
    signal: AbortSignal,
    invocation?: AgentDelegationInvocation,
  ): Promise<DelegationReceipt> {
    if (invocation === undefined)
      throw new Error("Delegation requires a tool invocation");
    const agents = await authorizedMembers(task.agentId, signal);
    const requestId = await agentDelegationRequestKey({
      owner: { kind: "local", agentId: input.agentId },
      sourceSessionId,
      targetAgentId: task.agentId,
      requestId: task.requestId,
    });
    signal.throwIfAborted();
    if (task.delivery === "steer") {
      const opened = await input.directory.open(task.agentId, signal);
      try {
        return await opened.agent.session(task.sessionId).send(task.text, {
          requestId,
          delivery: "steer",
        });
      } finally {
        await opened.release();
      }
    }
    const meta = delegationSendMeta(
      { id: input.agentId, name: input.agentId },
      invocation.meta,
    );
    // The caller's request key owns replay, not the current model program's bytes.
    const provenance = await delegationProvenance({
      agentId: input.agentId,
      sessionId: sourceSessionId,
    });
    signal.throwIfAborted();
    return fleet.start(
      {
        agents: agents.map(({ agentId }) => agentId),
        actions: ["delegate"],
        expiresAt: Date.now() + grantLifetimeMs,
        provenance,
        meta,
      },
      {
        agentId: task.agentId,
        sessionId: task.sessionId,
        text: task.text,
        requestId,
      },
    );
  }

  /** Resolve only this sender's receipt, then let the target own the pending guard. */
  async function recall(
    task: AgentRecallInput,
    sourceSessionId: string,
    signal: AbortSignal,
  ): Promise<CancelResult> {
    await authorizedMembers(task.agentId, signal);
    const requestId = await agentDelegationRequestKey({
      owner: { kind: "local", agentId: input.agentId },
      sourceSessionId,
      targetAgentId: task.agentId,
      requestId: task.requestId,
    });
    signal.throwIfAborted();
    const opened = await input.directory.open(task.agentId, signal);
    try {
      const receipt = fleet.receipt(requestId);
      if (
        receipt?.sessionId !== undefined &&
        receipt.sessionId !== task.sessionId
      )
        return { status: "unknown" };
      const session = opened.agent.session(
        receipt?.sessionId ?? task.sessionId,
      );
      const admitted = receipt ?? (await session.withdraw(requestId));
      return admitted.status === "accepted"
        ? await session.cancel({
            commandId: admitted.commandId,
            onlyIfPending: true,
          })
        : admitted;
    } finally {
      await opened.release();
    }
  }

  /**
   * Admit one mail addressed to this Agent. New work must name its sender as
   * its only reply destination; a reply-less mail is admitted only as an
   * authenticated reply. Everything else is refused.
   */
  async function receive(mail: BirdDogMail): Promise<Accepted> {
    const mesh = await input.meshAdmission?.(mail.to.agentId);
    if (mail.to.agentId !== input.agentId && mesh === undefined)
      throw new Error("Local addressed mail recipient is not authorized");
    const agents = mesh ?? (await members(new AbortController().signal));
    const sender = mail.from;
    const delegation =
      mail.replyTo.length === 0 ? fleet.authenticateReply(mail) : undefined;
    const authenticatedUndeliverable =
      delegation?.reply.outcome === "undeliverable";
    const senderIsMember =
      sender.kind === "agent" &&
      agents.some(({ agentId }) => agentId === sender.agentId);
    if (!senderIsMember && !authenticatedUndeliverable) {
      if (
        sender.kind === "system" &&
        mail.replyTo.length === 0 &&
        mail.reply?.outcome !== "accepted"
      )
        throw new Error("Local reply does not match work this Agent sent");
      throw new Error("Local mail sender is outside this project");
    }
    if (mail.replyTo.length > 0) {
      const [destination] = mail.replyTo;
      if (
        mail.replyTo.length !== 1 ||
        mail.from.kind !== "agent" ||
        destination?.agentId !== mail.from.agentId ||
        destination.sessionId !== mail.from.sessionId
      )
        throw new Error("Local delegated work must reply to its sender");
      return input.accept(mail, mail.meta);
    }
    if (mail.reply?.outcome === "accepted") {
      const receipt = fleet.recordAcceptedNotice(mail);
      if (receipt === undefined)
        throw new Error("Local acceptance notice does not match sent work");
      return receipt;
    }
    if (delegation === undefined)
      throw new Error("Local reply does not match work this Agent sent");
    const replier = agents.find(
      ({ agentId }) => agentId === delegation.reply.agentId,
    );
    if (replier === undefined && !authenticatedUndeliverable)
      throw new Error("Local reply sender is outside this project");
    const meta = delegationReplyMeta(
      delegation,
      replier?.name ?? delegation.reply.agentId,
    );
    return input.accept({ ...mail, meta }, meta, delegation.reply);
  }

  return { send, recall, receive, outstanding: fleet.outstanding };
}
