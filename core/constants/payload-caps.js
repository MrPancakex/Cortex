/**
 * Hard caps enforced at the edge. Values are chosen so a single rogue client
 * cannot OOM the gateway or monopolise a WebSocket fan-out.
 */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;          // 2 MiB per HTTP body
export const MAX_EVENT_BYTES = 64 * 1024;               // 64 KiB per event envelope
export const MAX_BRIDGE_BODY_BYTES = 128 * 1024;        // 128 KiB per bridge message
export const MAX_WS_PER_AGENT = 4;                      // concurrent sockets per agent
export const MAX_WS_QUEUE = 256;                        // per-socket backlog before drop
export const MAX_REJECTIONS = 6;                        // rejections before task is orphaned (raised 3→6 on 2026-05-29; gives agents more iteration room before escalating)
export const MAX_PROGRESS_PER_TASK = 1000;              // progress rows before roll-up
export const MAX_COMMENTS_PER_TASK = 500;

export const PAYLOAD_CAPS = Object.freeze({
  body: MAX_BODY_BYTES,
  event: MAX_EVENT_BYTES,
  bridge_body: MAX_BRIDGE_BODY_BYTES,
  ws_per_agent: MAX_WS_PER_AGENT,
  ws_queue: MAX_WS_QUEUE,
  rejections: MAX_REJECTIONS,
  progress_per_task: MAX_PROGRESS_PER_TASK,
  comments_per_task: MAX_COMMENTS_PER_TASK,
});
