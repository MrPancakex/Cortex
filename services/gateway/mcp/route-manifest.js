/**
 * Public route manifest — the lean carve's MCP route shapes.
 *
 * Derived from the live TOOL_ROUTES by OMITTING the cut-plane rows
 * (bridge_*, subagent_*, provider_list, plugin_register). Deriving by
 * omission (rather than re-listing the kept rows) means a kept row's
 * shape can only change in ONE place (route-manifest.js) — the public
 * manifest tracks it automatically. The export pipeline (Plan E) renames
 * this file to route-manifest.js in the staged tree.
 *
 * cost_summary / my_stats / cost_per_project / bridge_delete are NOT
 * listed here for the same reason they are absent from TOOL_ROUTES: they
 * are in-process tools (no HTTP hop, no manifest row). cost_* + the
 * subagent/bridge/provider/plugin MCP tools are pruned from the public
 * registry in route-manifest.public's sibling (_registry.public.js).
 */

import { TOOL_ROUTES } from './route-manifest.js';

const CUT_MANIFEST_ROWS = new Set([
  // bridge plane (8 manifest rows; bridge_delete is in-process, no row)
  'bridge_send', 'bridge_broadcast', 'bridge_inbox', 'bridge_poll',
  'bridge_reply', 'bridge_ack', 'bridge_thread', 'bridge_mark_read',
  // subagents plane (6 rows)
  'subagent_register', 'subagent_complete', 'subagent_list',
  'subagent_spawn', 'subagent_wait', 'subagent_close',
  // providers + plugins planes
  'provider_list', 'plugin_register',
]);

export const PUBLIC_TOOL_ROUTES = Object.freeze(
  Object.fromEntries(
    Object.entries(TOOL_ROUTES).filter(([name]) => !CUT_MANIFEST_ROWS.has(name)),
  ),
);
