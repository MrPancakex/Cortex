/**
 * Pure helper functions for channel message formatting.
 *
 * Lifted verbatim from plugins/cortex-channel/format.js — the wire format
 * must be identical so Claude Code's channel-message handler keeps working.
 * No sdk imports; pure transforms only.
 */

export function formatMessage(msg) {
  const parts = [];
  if (msg.subject) parts.push(`Subject: ${msg.subject}`);
  parts.push(msg.body || msg.content || '');
  if (msg.context) {
    try {
      const ctx = typeof msg.context === 'string' ? JSON.parse(msg.context) : msg.context;
      if (ctx && typeof ctx === 'object' && Object.keys(ctx).length > 0) {
        parts.push(`Context: ${JSON.stringify(ctx)}`);
      }
      // eslint-disable-next-line cortex-local/catch-has-metric -- best-effort context parse in a pure formatter
    } catch {
      // Intentional no-op: malformed context strings are dropped silently.
    }
  }
  return parts.join('\n');
}

export function buildMeta(msg) {
  const meta = {
    source: 'cortex',
    type: msg.message_type || msg.type || 'text',
    from: msg.from,
    message_id: msg.message_id,
    ts: msg.sent_at || msg.created_at,
  };
  if (msg.task_id) meta.task_id = msg.task_id;
  if (msg.blocking) meta.blocking = 'true';
  if (msg.priority && msg.priority !== 'normal') meta.priority = msg.priority;
  return meta;
}
