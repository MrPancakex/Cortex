import { z } from 'zod';
import { swallow } from '@cortex/sdk/errors';
import { getAgentId } from '@cortex/sdk/auth';

export const ReleaseStaleAgentTasksInputSchema = z.object({
  seconds: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

export const definition = {
  name: 'release_stale_agent_tasks',
  protocolVersion: '1.0',
  description: 'Release tasks assigned to agents that have not heartbeated within the threshold. Admin-only.',
  inputSchema: {
    type: 'object',
    properties: {
      seconds: { type: 'integer' },
      reason: { type: 'string' },
    },
    required: [],
  },
  schema: ReleaseStaleAgentTasksInputSchema,
  capability: 'admin.release',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const seconds = Number(args?.seconds) || 600;
  const reason = typeof args?.reason === 'string' ? args.reason : 'agent went stale';
  const db = gateway.db;
  if (!db) throw new Error('gateway.db not available');
  const cutoff = Math.floor(Date.now() / 1000) - seconds;
  const staleRows = db.prepare(
    `SELECT ct.id, ct.assigned_agent, ct.title
     FROM cortex_tasks ct
     WHERE ct.status IN ('claimed', 'in_progress')
       AND ct.assigned_agent IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM heartbeats h
         WHERE h.agent_id = ct.assigned_agent
           AND COALESCE(h.last_seen, 0) > ?
       )`
  ).all(cutoff);

  let released = 0;
  const results = [];
  for (const row of staleRows) {
    const r = db.prepare(
      `UPDATE cortex_tasks
       SET status = 'pending', assigned_agent = NULL, assigned_platform = NULL,
           claimed_at = NULL, updated_at = unixepoch()
       WHERE id = ? AND status IN ('claimed', 'in_progress')`
    ).run(row.id);
    if (r.changes === 1) {
      released++;
      try {
        gateway.stmts?.insertAudit?.run(
          row.id,
          getAgentId(gateway) || 'system',
          'stale_task_released',
          JSON.stringify({ previous_agent: row.assigned_agent, reason, threshold_seconds: seconds }),
        );
      } catch (err) { swallow('stale_release_audit_failed', err); }
      results.push({ task_id: row.id, previous_agent: row.assigned_agent, title: row.title });
    }
  }
  return { released, threshold_seconds: seconds, results };
}
