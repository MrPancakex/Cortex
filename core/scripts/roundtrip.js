#!/usr/bin/env bun
/**
 * Build-time smoke for Phase 1. Imports every public barrel to prove the
 * module graph resolves cleanly. Run with `bun run core/scripts/roundtrip.js`.
 */
import * as core from '../index.js';
import * as schemas from '../schemas/index.js';
import * as constants from '../constants/index.js';

const report = {
  core_exports: Object.keys(core).length,
  schemas_exports: Object.keys(schemas).length,
  constants_exports: Object.keys(constants).length,
  has_TaskCreateSchema: typeof core.TaskCreateSchema?.safeParse === 'function',
  has_BridgeSendSchema: typeof core.BridgeSendSchema?.safeParse === 'function',
  has_AgentRegisterSchema: typeof core.AgentRegisterSchema?.safeParse === 'function',
  has_ProgressReportSchema: typeof core.ProgressReportSchema?.safeParse === 'function',
  has_PluginManifestSchema: typeof core.PluginManifestSchema?.safeParse === 'function',
  has_ToolDefinitionSchema: typeof core.ToolDefinitionSchema?.safeParse === 'function',
  gateway_port: core.GATEWAY_PORT,
  task_statuses: core.TASK_STATUSES,
  agent_statuses: core.AGENT_STATUSES,
  // Phase 5 added 'orphaned' — this flag is now positive.
  orphaned_present_as_of_phase_5: core.TASK_STATUSES.includes('orphaned'),
  priority_rank_critical: core.PRIORITY_RANK.critical,
  max_rejections: core.MAX_REJECTIONS,
  rotation_escalate_after: core.ROTATION_ESCALATE_AFTER,
  provider_routes_count: core.PROVIDER_ROUTES.length,
  process_state_online: core.ProcessState.ONLINE,
  credential_map_keys: Object.keys(core.CREDENTIAL_MAP),
  models_resolved: constants.resolveModel('claude-opus'),
};

console.log(JSON.stringify(report, null, 2));

// Non-zero exit if any critical invariant fails.
const required = [
  'has_TaskCreateSchema',
  'has_BridgeSendSchema',
  'has_AgentRegisterSchema',
  'has_ProgressReportSchema',
  'has_PluginManifestSchema',
  'has_ToolDefinitionSchema',
];
for (const key of required) {
  if (!report[key]) {
    console.error(`roundtrip: missing ${key}`);
    process.exit(1);
  }
}
if (!report.orphaned_present_as_of_phase_5) {
  console.error('roundtrip: Phase 5 must include the orphaned status (session reaper target)');
  process.exit(1);
}
if (report.priority_rank_critical !== 4) {
  console.error('roundtrip: PRIORITY_RANK.critical must be 4 (from cortex-tasks.js:119-127)');
  process.exit(1);
}
if (report.rotation_escalate_after !== 3) {
  console.error('roundtrip: ROTATION_ESCALATE_AFTER must be 3 (from lib/log-manager.js:17)');
  process.exit(1);
}
if (report.models_resolved !== 'claude-opus-4-7') {
  console.error('roundtrip: model alias resolution broken');
  process.exit(1);
}
