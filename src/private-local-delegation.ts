import type { BirdDogMail } from "@fungi.computer/bird-dog";
import * as Effect from "effect/Effect";
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
    /**
     * What happens to items a child left waiting on this Agent when the work
     * that was told about them ends. Without it a host leaves them to expire.
     */
    unattended?: Readonly<{
      /** Exact settled facts of one command of this Agent's own Sessions. */
      readSettlement: (
        sessionId: string,
        commandId: string,
      ) => Promise<CommandSettlement | undefined>;
      /**
       * Pass one child item on to a person, as this Agent's Session that was
       * told about it. A child that already moved on answers that and nothing changes.
       */
      escalate: (
        item: Readonly<{ agentId: string; sessionId: string; itemId: string }>,
        receiverSessionId: string,
      ) => Promise<void>;
    }>;
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

  /**
   * Items a child left waiting on this Agent, by the reply command that told
   * it. When the work that carried the reply ends, whatever the Agent neither
   * answered nor escalated goes to a person, so no waiting item is silent.
   */
  const unattended = new Map<
    string,
    Readonly<{
      sessionId: string;
      child: Readonly<{ agentId: string; sessionId: string }>;
      items: readonly string[];
    }>
  >();
  let poll: ReturnType<typeof setInterval> | undefined;

  /** Escalate the items of every reply whose carrying work has settled. */
  async function settleUnattended(): Promise<void> {
    const handling = input.unattended;
    if (handling === undefined) return;
    for (const [commandId, entry] of unattended) {
      const settlement = await handling
        .readSettlement(entry.sessionId, commandId)
        .catch((cause: unknown) => {
          // Not settled as far as anyone can tell; try again on the next poll.
          Effect.runFork(Effect.logWarning("delegation.settlement", cause));
          return undefined;
        });
      if (settlement === undefined) continue;
      unattended.delete(commandId);
      for (const itemId of entry.items)
        await handling
          .escalate({ ...entry.child, itemId }, entry.sessionId)
          .catch((cause: unknown) => {
            Effect.runFork(Effect.logWarning("delegation.escalate", cause));
          });
    }
    if (unattended.size === 0 && poll !== undefined) {
      clearInterval(poll);
      poll = undefined;
    }
  }

  function watchUnattended(
    accepted: Accepted,
    receiverSessionId: string | undefined,
    reply: VerifiedAgentReply,
  ): void {
    if (
      input.unattended === undefined ||
      reply.outcome === "undeliverable" ||
      reply.waitingOnYou === undefined
    )
      return;
    if (receiverSessionId === undefined) return;
    unattended.set(accepted.commandId, {
      sessionId: receiverSessionId,
      child: { agentId: reply.agentId, sessionId: reply.sessionId },
      items: reply.waitingOnYou.map(({ itemId }) => itemId),
    });
    poll ??= setInterval(() => {
      void settleUnattended();
    }, 1_000);
    poll.unref();
  }

  /** Escalate what is owed now and stop watching; the Agent is closing. */
  async function close(): Promise<void> {
    await settleUnattended();
    unattended.clear();
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
  }

  /** Send with one caller-owned identity; follow-up and steer replies return here. */
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
    // A person reads this name where work waits on its sender.
    const sender = agents.find(({ agentId }) => agentId === input.agentId);
    const meta = delegationSendMeta(
      { id: input.agentId, name: sender?.name ?? input.agentId },
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
        delivery: task.delivery,
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
    const accepted = await input.accept(
      { ...mail, meta },
      meta,
      delegation.reply,
    );
    watchUnattended(accepted, mail.to.sessionId, delegation.reply);
    return accepted;
  }

  return { send, recall, receive, close, outstanding: fleet.outstanding };
}
