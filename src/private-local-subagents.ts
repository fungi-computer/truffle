import type { AgentControlDirectory } from "@fungi.computer/shiitake/agent-control";
import type { FleetRecipients } from "@fungi.computer/shiitake/fleet";
import type { SubagentSource } from "@fungi.computer/shiitake-extensions/subagents/host";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const creationRow = z.strictObject({
  agent_id: z.string().min(1).max(256),
  created_at: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
});

/**
 * One Local Agent's record of which of its Sessions created which Agents, in
 * that Agent's own store beside its frozen sends. It is creation provenance
 * for the read-only sub-agent view, not a managed parent/child relationship.
 */
export function createPrivateLocalSubagents(
  input: Readonly<{
    database: DatabaseSync;
    directory: AgentControlDirectory;
    /** This Agent's grouped read of the Agents a Session sent work to. */
    recipients?:
      ((sessionId: string, limit: number) => FleetRecipients) | undefined;
  }>,
) {
  input.database
    .exec(`CREATE TABLE IF NOT EXISTS private_local_agent_creations (
    agent_id TEXT PRIMARY KEY,
    creator_session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`);
  input.database.exec(
    "CREATE INDEX IF NOT EXISTS idx_private_local_agent_creations_creator ON private_local_agent_creations(creator_session_id, created_at)",
  );

  /** Record once; a retried create of the same Agent keeps its first creator. */
  function recordCreation(sessionId: string, agentId: string) {
    input.database
      .prepare(
        "INSERT OR IGNORE INTO private_local_agent_creations(agent_id, creator_session_id, created_at) VALUES (?, ?, ?)",
      )
      .run(agentId, sessionId, Date.now());
  }

  const source: SubagentSource = {
    read: (sessionId, limit) => {
      const sent = input.recipients?.(sessionId, limit) ?? {
        recipients: [],
        more: 0,
      };
      const created = input.database
        .prepare(
          "SELECT agent_id, created_at, COUNT(*) OVER () AS total FROM private_local_agent_creations WHERE creator_session_id = ? ORDER BY created_at DESC, agent_id LIMIT ?",
        )
        .all(sessionId, limit)
        .map((row) => creationRow.parse(row));
      // A sent row names the conversation to open; creation only adds Agents
      // this Session never messaged.
      const rows = new Map<string, { sessionId: string | null; at: number }>();
      for (const row of sent.recipients)
        rows.set(row.agentId, { sessionId: row.sessionId, at: row.sentAt });
      for (const row of created)
        if (!rows.has(row.agent_id))
          rows.set(row.agent_id, { sessionId: null, at: row.created_at });
      const listed = [...rows]
        .sort(([, left], [, right]) => right.at - left.at)
        .slice(0, limit);
      // Overlap beyond the fetched pages is unknown, so `more` may overcount
      // only when both lists exceed the bound.
      const total =
        sent.recipients.length +
        sent.more +
        (created[0]?.total ?? 0) -
        (sent.recipients.length + created.length - rows.size);
      return Promise.resolve({
        agents: listed.map(([agentId, row]) => ({
          agentId,
          name: agentId,
          sessionId: row.sessionId,
        })),
        more: Math.max(0, total - listed.length),
      });
    },
    open: input.directory.open,
  };
  return { recordCreation, source };
}
