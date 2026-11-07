import type { BirdDogMail } from "@fungi.computer/bird-dog";
import { logEvent } from "./log-event.js";
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
  isOneWayAncestorNotice,
  type AgentDelegationTask,
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
     * Remind this exact Session when a carrying turn settles. Silence and
     * shutdown never hand an item to a person.
     */
    unattended?: Readonly<{
      /** Exact settled facts of one command of this Agent's own Sessions. */
      readSettlement: (
        sessionId: string,
        commandId: string,
      ) => Promise<CommandSettlement | undefined>;
      /** Check the child's current item and admit one idempotent reminder if still owed. */
      remind: (
        item: Readonly<{ agentId: string; sessionId: string; itemId: string }>,
        receiverSessionId: string,
        number: number,
      ) => Promise<
        | Readonly<{ status: "settled" }>
        | Readonly<{ status: "reminded"; commandId: string }>
      >;
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
   * One process-local reminder budget per exact child item and receiver. A
   * duplicate reply never resets it. A restart may lose reminders, not the
   * durable ask or its presence checks. Above this memory ceiling we stay quiet.
   */
  const unattended = new Map<
    string,
    {
      sessionId: string;
      child: Readonly<{ agentId: string; sessionId: string }>;
      itemId: string;
      commandId: string;
      reminders: number;
    }
  >();
  let poll: ReturnType<typeof setInterval> | undefined;
  let polling = false;
  let closed = false;

  /** Remind at most twice, watching each reminder's own carrying turn next. */
  async function settleUnattended(): Promise<void> {
    const handling = input.unattended;
    if (handling === undefined || polling || closed) return;
    polling = true;
    try {
      for (const [key, entry] of unattended) {
        if (entry.reminders >= 2) continue;
        const settlement = await handling
          .readSettlement(entry.sessionId, entry.commandId)
          .catch((cause: unknown) => {
            // Not settled as far as anyone can tell; try again on the next poll.
            logEvent("delegation.settlement", cause);
            return undefined;
          });
        // Close or eviction can retire this exact entry while the read is pending.
        if (settlement === undefined || unattended.get(key) !== entry) continue;
        // Charge before transport: uncertain delivery must not buy a third
        // reminder. Exhausted entries retain the budget against duplicate replies.
        entry.reminders += 1;
        try {
          const result = await handling.remind(
            { ...entry.child, itemId: entry.itemId },
            entry.sessionId,
            entry.reminders,
          );
          if (unattended.get(key) !== entry) continue;
          if (result.status === "settled") unattended.delete(key);
          else entry.commandId = result.commandId;
        } catch (cause) {
          logEvent("delegation.remind", cause);
        }
      }
      if (
        ![...unattended.values()].some((entry) => entry.reminders < 2) &&
        poll !== undefined
      ) {
        clearInterval(poll);
        poll = undefined;
      }
    } finally {
      polling = false;
    }
  }

  function watchUnattended(
    accepted: Accepted,
    receiverSessionId: string | undefined,
    reply: VerifiedAgentReply,
  ): void {
    if (
      closed ||
      input.unattended === undefined ||
      reply.outcome === "undeliverable" ||
      reply.waitingOnYou === undefined
    )
      return;
    if (receiverSessionId === undefined) return;
    for (const { itemId } of reply.waitingOnYou) {
      const key = JSON.stringify([
        reply.agentId,
        reply.sessionId,
        itemId,
        receiverSessionId,
      ]);
      if (unattended.has(key) || unattended.size >= 4096) continue;
      unattended.set(key, {
        sessionId: receiverSessionId,
        child: { agentId: reply.agentId, sessionId: reply.sessionId },
        itemId,
        commandId: accepted.commandId,
        reminders: 0,
      });
    }
    poll ??= setInterval(() => {
      void settleUnattended();
    }, 1_000);
    poll.unref();
  }

  /** Stop watching without admitting or escalating anything on shutdown. */
  function close(): Promise<void> {
    closed = true;
    unattended.clear();
    if (poll !== undefined) clearInterval(poll);
    poll = undefined;
    return Promise.resolve();
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
    let delegation: AgentDelegationTask = {
      agentId: task.agentId,
      sessionId: task.sessionId,
      delivery: task.delivery,
      text: task.text,
      requestId,
    };
    if (task.delivery === "followUp" && task.goal !== undefined)
      delegation = { ...delegation, goal: task.goal };
    return fleet.start(
      {
        agents: agents.map(({ agentId }) => agentId),
        actions: ["delegate"],
        expiresAt: Date.now() + grantLifetimeMs,
        provenance,
        meta,
      },
      delegation,
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
   * Admit delegated work, one-way ancestor notices and authenticated replies.
   * Other reply-less mail is refused.
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
    if (isOneWayAncestorNotice(mail)) return input.accept(mail, mail.meta);
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
