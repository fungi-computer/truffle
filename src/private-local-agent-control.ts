import type { CapabilitySource } from "@fungi.computer/mycelium";
import {
  AgentCreateRefused,
  type AgentControlAgent,
  type AgentControlDirectory,
} from "@fungi.computer/shiitake/agent-control";
import { createConversationAgents } from "@fungi.computer/shiitake-extensions/roster/conversation-agents";

/** One Agent creating an Agent, as the project's Agent directory receives it. */
export type LocalCreateRequest = Parameters<
  NonNullable<AgentControlDirectory["create"]>
>[0] &
  Readonly<{
    /** The Agent creating, resolved by the creator's own host, never by the caller. */
    createdBy: string;
    /** The creating Session, captured by the Local Agent-control host. */
    createdBySessionId: string;
  }>;

/**
 * One ordinary Agent as the project's directory lists it. `unreadable` is
 * set when this Agent's own store cannot be read (for
 * example one written before the current schema); only that row is affected.
 */
export type LocalAgentControlAgent = AgentControlAgent &
  Readonly<{ unreadable?: string }>;

/**
 * Who archives or restores an Agent: an Agent, named by its own host and never
 * by the caller, or a person at the CLI or TUI. A person may archive any
 * Agent; an Agent only one it created.
 */
export type LocalArchiver =
  Readonly<{ kind: "agent"; agentId: string }> | Readonly<{ kind: "human" }>;

/** One archive or restore request, as the project's Agent directory receives it. */
export type LocalArchiveRequest = Readonly<{
  agentId: string;
  by: LocalArchiver;
}>;

/**
 * The project's Agent directory a Local host receives. Its create names the
 * creating Agent, so the directory owner can hold the created Agent to what
 * the creator holds; its archive names who archives.
 */
export type LocalAgentControlDirectory = Omit<
  AgentControlDirectory,
  "create" | "list" | "archive" | "unarchive"
> &
  Readonly<{
    list: (
      signal: AbortSignal,
      options?: Readonly<{ archived?: boolean }>,
    ) => Promise<readonly LocalAgentControlAgent[]>;
    create: (
      input: LocalCreateRequest,
      signal: AbortSignal,
    ) => Promise<AgentControlAgent>;
    archive: (input: LocalArchiveRequest, signal: AbortSignal) => Promise<void>;
    unarchive: (
      input: LocalArchiveRequest,
      signal: AbortSignal,
    ) => Promise<void>;
  }>;

/**
 * Ordinary Agent controls bound to this authenticated creating Agent; each
 * conversation's accepted creates and sends are recorded in this Agent's own
 * store for its footer.
 */
export function createPrivateLocalAgentControl(
  input: Readonly<{
    agentId: string;
    directory: LocalAgentControlDirectory;
    storage: Parameters<typeof createConversationAgents>[0];
  }>,
) {
  const conversations = createConversationAgents(input.storage);
  function bound(parentSessionId: string | undefined): AgentControlDirectory {
    const { create, archive, unarchive } = input.directory;
    const by: LocalArchiver = { kind: "agent", agentId: input.agentId };
    return {
      ...input.directory,
      archive: ({ agentId }, signal) => archive({ agentId, by }, signal),
      unarchive: ({ agentId }, signal) => unarchive({ agentId, by }, signal),
      create: async (request, signal) => {
        if (parentSessionId === undefined)
          throw new AgentCreateRefused(
            "no_creator",
            "creation requires an invoking Session",
          );
        return create(
          {
            ...request,
            createdBy: input.agentId,
            createdBySessionId: parentSessionId,
          },
          signal,
        );
      },
    };
  }
  const control: CapabilitySource = conversations.control(bound);
  return {
    control,
    source: conversations.source(input.directory),
    directory: conversations.recording(undefined, bound(undefined)),
  };
}
