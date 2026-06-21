import { swallow } from '@cortex/sdk/errors';
import { getAgentId } from '@cortex/sdk/auth';
import { TOOL_REGISTRY } from './tools/_registry.js';
import { insertTelemetry } from '../meta/telemetry.js';

// Tools whose result is augmented with unread-inbox count.
const INBOX_PIGGYBACK_TOOLS = new Set(['task_get', 'get_next_task', 'claim_task']);

/**
 * Build the inbox piggyback function with injected statement store.
 * DI here keeps the prepared-statement cache testable and scoped to
 * the dispatch call rather than module-global.
 */
export function makePiggybackInbox(statements) {
  return function piggybackInbox(result, gateway, toolName) {
    if (!INBOX_PIGGYBACK_TOOLS.has(toolName)) return result;
    try {
      const agent = getAgentId(gateway);
      if (!agent) return result;
      if (!statements.inbox) {
        statements.inbox = gateway.db.prepare(
          `SELECT COUNT(*) as count, MAX(blocking) as has_blocking
           FROM bridge_messages
           WHERE to_agent = ? AND read = 0
           AND (expires_at IS NULL OR expires_at > unixepoch())`
        );
      }
      const row = statements.inbox.get(agent) ?? { count: 0, has_blocking: 0 };
      const count = row.count ?? 0;
      if (count > 0) {
        return { _inbox: { count, has_blocking: row.has_blocking === 1 }, ...result };
      }
    } catch (err) {
      swallow('mcp.piggyback_failed', err);
    }
    return result;
  };
}

// Auto-telemetry (Foundation F2). The telemetry-ingest plane is now mounted
// (POST /api/gateway/telemetry → meta/telemetry.js insertTelemetry, backed by
// migration 016). Rather than a self-HTTP hop (the 404-spam the no-op was
// guarding against), the in-process dispatch path inserts DIRECTLY via
// insertTelemetry — the dispatch `gateway` carries a `.db` handle in the
// composed gateway. The stdio gateway has no `.db`; insertTelemetry resolves
// its own getDb() handle, but we still gate on gateway.db so a stdio dispatch
// (which runs in a process with no gateway DB) is a clean skip rather than a
// best-effort insert into an unrelated handle. One row per dispatch: endpoint
// = the tool name, latency_ms = the measured wall time; token/cost columns
// stay 0 unless the tool itself reported them (most MCP tools don't, so these
// are latency-only observability rows — harmless to cost sums).
function logTelemetry(ctx) {
  try {
    const { gateway, name, latency, error } = ctx || {};
    if (!gateway || !gateway.db) return;
    // R1-5: telemetry_report self-POSTs its own (authoritative) row via the
    // ingest route. Auto-logging it here too would double-count — one report
    // would land TWO rows (the auto-row is latency-only/cost-0, inflating
    // total_requests). Skip the auto-row; the tool's own POST is the record.
    if (name === 'telemetry_report') return;
    insertTelemetry({
      agent_id: getAgentId(gateway) || null,
      endpoint: typeof name === 'string' ? name : null,
      method: 'mcp',
      latency_ms: latency,
      // error rows still record (an erroring dispatch is real latency); mark
      // the provider field so error rows are filterable downstream.
      provider: error ? 'mcp_error' : 'mcp',
    });
  } catch (err) {
    // Telemetry must never break a dispatch — swallow and move on.
    swallow('mcp.telemetry_log_failed', err);
  }
}

/**
 * Dispatch an MCP tool call. Looks the handler up in TOOL_REGISTRY (O(1) map),
 * invokes it, logs telemetry regardless of outcome, and optionally adds
 * inbox piggyback context to the response.
 */
export async function dispatchTool(name, args, gateway, { statements = {} } = {}) {
  const entry = TOOL_REGISTRY[name];
  if (!entry) throw new Error(`Unknown tool: ${name}`);

  const start = Date.now();
  let result, error;
  try {
    result = await entry.handler(args || {}, gateway);
  } catch (e) {
    error = e;
  }
  const latency = Date.now() - start;
  logTelemetry({ gateway, name, args, result, error, latency });

  if (error) throw error;
  const piggybackInbox = makePiggybackInbox(statements);
  return piggybackInbox(result, gateway, name);
}

// Export a HANDLERS map for the schema/handler parity test in tests/.
// Frozen so the test suite cannot accidentally mutate it.
export const HANDLERS = Object.freeze(
  Object.fromEntries(
    Object.entries(TOOL_REGISTRY).map(([name, entry]) => [name, entry.handler]),
  ),
);
