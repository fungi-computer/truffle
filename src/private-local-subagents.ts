import type { CapabilitySource } from "@fungi.computer/mycelium";
import {
  createAgentControlSource,
  type AgentControlDirectory,
} from "@fungi.computer/shiitake/agent-control";
import type { SubagentSource } from "@fungi.computer/shiitake-extensions/subagents/host";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const subagentRow = z.lazy(() =>
  z.strictObject({
    agent_id: z.string().min(1).max(256),
    session_id: z.string().min(1).max(256).nullable(),
    total: z.number().int().nonnegative(),
  }),
);

/**
 * One Local Agent's own record of the Agents each of its Sessions created or
 * sent work to. This host writes it as its Agent-control directory accepts a
 * create or a send. It feeds the read-only sub-agent view and is not a managed
 * parent/child relationship.
 */
export function createPrivateLocalSubagents(
  input: Readonly<{ database: DatabaseSync; directory: AgentControlDirectory }>,
) {
  input.database.exec(`CREATE TABLE IF NOT EXISTS private_local_subagents (
    parent_session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    session_id TEXT,
    at INTEGER NOT NULL,
    PRIMARY KEY (parent_session_id, agent_id)
  ) STRICT`);
  input.database.exec(
    "CREATE INDEX IF NOT EXISTS idx_private_local_subagents_parent ON private_local_subagents(parent_session_id, at)",
  );
  // A retried create keeps its first row.
  const created = input.database.prepare(
    "INSERT OR IGNORE INTO private_local_subagents(parent_session_id, agent_id, session_id, at) VALUES (?, ?, NULL, ?)",
  );
  // A send names the conversation to open and moves the row to the front.
  const sent = input.database.prepare(
    "INSERT INTO private_local_subagents(parent_session_id, agent_id, session_id, at) VALUES (?, ?, ?, ?) ON CONFLICT(parent_session_id, agent_id) DO UPDATE SET session_id = excluded.session_id, at = excluded.at",
  );
  const page = input.database.prepare(
    "SELECT agent_id, session_id, COUNT(*) OVER () AS total FROM private_local_subagents WHERE parent_session_id = ? ORDER BY at DESC, agent_id LIMIT ?",
  );

  /** One Session's directory: its accepted creates and sends are recorded. */
  function recording(parentSessionId: string | undefined) {
    const { create, send } = input.directory;
    let directory: AgentControlDirectory = input.directory;
    if (create !== undefined && parentSessionId !== undefined)
      directory = {
        ...directory,
        create: async (request, signal) => {
          const agent = await create(request, signal);
          created.run(parentSessionId, agent.agentId, Date.now());
          return agent;
        },
      };
    if (send !== undefined)
      directory = {
        ...directory,
        send: async (task, sourceSessionId, signal, invocation) => {
          const accepted = await send(
            task,
            sourceSessionId,
            signal,
            invocation,
          );
          sent.run(sourceSessionId, task.agentId, task.sessionId, Date.now());
          return accepted;
        },
      };
    return directory;
  }

  /**
   * The ordinary Agent-control tools, bound to the Session that acquires them
   * for one run, so a create is recorded against that Session.
   */
  const control: CapabilitySource = {
    id: createAgentControlSource(input.directory).id,
    acquire: (context) =>
      createAgentControlSource(recording(context.session?.sessionId)).acquire(
        context,
      ),
  };

  const source: SubagentSource = {
    read: (sessionId, limit) => {
      const rows = page
        .all(sessionId, limit)
        .map((row) => subagentRow.parse(row));
      return Promise.resolve({
        agents: rows.map((row) => ({
          agentId: row.agent_id,
          name: row.agent_id,
          sessionId: row.session_id,
        })),
        more: Math.max(0, (rows[0]?.total ?? 0) - rows.length),
      });
    },
    open: input.directory.open,
  };
  return { control, source };
}
