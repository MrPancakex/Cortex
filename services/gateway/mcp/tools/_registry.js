// Public MCP tool registry — the lean carve's kept tools only.
//
// Imports ONLY the kept tool modules so the public bundle never references
// a cut-plane handler. The 23 cut tools (9 bridge_*, 6 subagent_*, 2
// codex_review_*, route_request, model_list, provider_list, plugin_register,
// cost_summary, cost_per_project) are intentionally NOT imported here.
//
// Mirror of _registry.js minus those imports. The export pipeline (Plan E)
// renames this file to _registry.js in the staged tree; the cut tool files
// are removed from the staged tree at the same step.

import * as health_check         from './health_check.js';
import * as agent_status         from './agent_status.js';
import * as task_get             from './task_get.js';
import * as get_next_task        from './get_next_task.js';
import * as claim_task           from './claim_task.js';
import * as report_progress      from './report_progress.js';
import * as submit_result        from './submit_result.js';
import * as request_verification from './request_verification.js';
import * as task_approve         from './task_approve.js';
import * as task_reject          from './task_reject.js';
import * as task_update          from './task_update.js';
import * as task_cancel          from './task_cancel.js';
import * as heartbeat            from './heartbeat.js';
import * as agent_register       from './agent_register.js';
import * as task_create          from './task_create.js';
import * as task_list            from './task_list.js';
import * as task_release         from './task_release.js';
import * as task_reassign        from './task_reassign.js';
import * as task_comment         from './task_comment.js';
import * as task_journal         from './task_journal.js';
import * as task_reopen          from './task_reopen.js';
import * as gateway_stats        from './gateway_stats.js';
import * as logs_query           from './logs_query.js';
import * as error_history        from './error_history.js';
import * as project_create       from './project_create.js';
import * as project_list         from './project_list.js';
import * as project_get          from './project_get.js';
import * as project_summary      from './project_summary.js';
import * as project_connect      from './project_connect.js';
import * as project_disconnect   from './project_disconnect.js';
import * as task_delete          from './task_delete.js';
import * as task_audit           from './task_audit.js';
import * as task_batch_status    from './task_batch_status.js';
import * as project_update       from './project_update.js';
import * as project_delete       from './project_delete.js';
import * as phase_add            from './phase_add.js';
import * as phase_delete         from './phase_delete.js';
import * as phase_list           from './phase_list.js';
import * as telemetry_report     from './telemetry_report.js';
import * as my_stats             from './my_stats.js';
import * as stale_agents         from './stale_agents.js';
import * as agent_update         from './agent_update.js';
import * as agent_delete         from './agent_delete.js';
import * as release_stale_agent_tasks from './release_stale_agent_tasks.js';
import * as task_force_release   from './task_force_release.js';
import * as phase_update         from './phase_update.js';
import * as task_rework_start    from './task_rework_start.js';
import * as task_submit_for_review from './task_submit_for_review.js';

const modules = [
  health_check, agent_status, task_get, get_next_task,
  claim_task, report_progress, submit_result, request_verification,
  task_approve, task_reject, task_update, task_cancel, heartbeat,
  agent_register, task_create, task_list, task_release, task_reassign,
  task_comment, task_journal, task_reopen, gateway_stats, logs_query,
  error_history, project_create, project_list, project_get, project_summary,
  project_connect, project_disconnect, task_delete, task_audit, task_batch_status,
  project_update, project_delete, phase_add, phase_delete, phase_list,
  telemetry_report, my_stats, stale_agents,
  agent_update, agent_delete, release_stale_agent_tasks, task_force_release,
  phase_update, task_rework_start, task_submit_for_review,
];

export const PUBLIC_TOOL_REGISTRY = Object.freeze(
  Object.fromEntries(modules.map(m => [m.definition.name, {
    definition: m.definition,
    handler: m.handler,
  }])),
);

// The export pipeline (Plan E) renames this file to _registry.js.
// transport.js and dispatch.js import the canonical name `TOOL_REGISTRY`
// from this module; re-export so those files work without modification.
export { PUBLIC_TOOL_REGISTRY as TOOL_REGISTRY };
