import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";

import type { Accepted } from "@fungi.computer/shiitake";
import type { AgentControlAgent } from "@fungi.computer/shiitake/agent-control";
import {
  createPrivateLocalAgentControl,
  type LocalAgentControlAgent,
  type LocalAgentControlDirectory,
} from "../src/private-local-agent-control.js";
import { createPrivateSqliteOwner } from "../src/private-sqlite-owner.js";

const signal = new AbortController().signal;

function fixture(
  listed: readonly LocalAgentControlAgent[] = [],
  archived: readonly LocalAgentControlAgent[] = [],
) {
  const create = vi.fn((): Promise<AgentControlAgent> =>
    Promise.resolve({ agentId: "created", name: "created" }),
  );
  const archive = vi.fn((): Promise<void> => Promise.resolve());
  const unarchive = vi.fn((): Promise<void> => Promise.resolve());
  const accepted: Accepted = { status: "accepted", commandId: "command" };
  const send = vi.fn(() => Promise.resolve(accepted));
  const directory: LocalAgentControlDirectory = {
    list: (_signal, options) =>
      Promise.resolve(options?.archived === true ? archived : listed),
    create,
    answer: () =>
      Promise.resolve({ status: "unavailable", reason: "unsupported" }),
    escalate: () =>
      Promise.resolve({ status: "unavailable", reason: "unsupported" }),
    send,
    archive,
    unarchive,
    open: () => Promise.reject(new Error("unused")),
  };
  const database = new DatabaseSync(":memory:");
  const subagents = createPrivateLocalAgentControl({
    agentId: "maker",
    directory,
    storage: createPrivateSqliteOwner(database),
  });
  return { create, send, archive, unarchive, subagents };
}

it("refuses a create that has no invoking Session, so no Agent is identified as its creator", async () => {
  const { create, subagents } = fixture();
  const createAgent = subagents.directory.create;
  if (createAgent === undefined) throw new Error("create is unavailable");
  await expect(
    createAgent({ requestId: "orphan" }, signal),
  ).rejects.toMatchObject({
    name: "AgentCreateRefused",
    reason: "no_creator",
  });
  expect(create).not.toHaveBeenCalled();
});

it("lists the Agents this Agent created, the same in every conversation, and no peer it only sent work to", async () => {
  const { subagents } = fixture([
    { agentId: "maker", name: "Maker", createdBy: null },
    { agentId: "child", name: "Child", createdBy: "maker" },
    { agentId: "peer", name: "Peer", createdBy: null },
    { agentId: "elsewhere", name: "Elsewhere", createdBy: "maker" },
    { agentId: "cousin", name: "Cousin", createdBy: "child" },
  ]);
  const send = subagents.directory.send;
  if (send === undefined) throw new Error("send is unavailable");
  const invocation = { toolCallId: "call", sendIndex: 0 };
  await send(
    {
      agentId: "peer",
      sessionId: "work",
      requestId: "peer-help",
      text: "Help",
      delivery: "followUp",
    },
    "main",
    signal,
    invocation,
  );
  const children = {
    agents: [
      { agentId: "child", name: "Child", sessionId: null },
      { agentId: "elsewhere", name: "Elsewhere", sessionId: null },
    ],
    more: 0,
  };
  expect(await subagents.source.read("main", 10)).toEqual(children);
  expect(await subagents.source.read("another-session", 10)).toEqual(children);
  expect(await subagents.source.read("untouched", 10)).toEqual(children);
  expect(await subagents.source.read("main", 1)).toEqual({
    agents: [{ agentId: "child", name: "Child", sessionId: null }],
    more: 1,
  });
});

it("names the Agent that archives, so the host never trusts the caller for it", async () => {
  const { archive, unarchive, subagents } = fixture();
  await subagents.directory.archive?.({ agentId: "fixer" }, signal);
  await subagents.directory.unarchive?.({ agentId: "fixer" }, signal);
  expect(archive).toHaveBeenCalledWith(
    { agentId: "fixer", by: { kind: "agent", agentId: "maker" } },
    signal,
  );
  expect(unarchive).toHaveBeenCalledWith(
    { agentId: "fixer", by: { kind: "agent", agentId: "maker" } },
    signal,
  );
});

it("an archived Agent leaves the footer", async () => {
  const { subagents } = fixture(
    [{ agentId: "active", name: "Active", createdBy: "maker" }],
    [{ agentId: "archived", name: "Archived", createdBy: "maker" }],
  );
  expect(
    (await subagents.source.read("main", 10)).agents.map(
      ({ agentId }) => agentId,
    ),
  ).toEqual(["active"]);
});
