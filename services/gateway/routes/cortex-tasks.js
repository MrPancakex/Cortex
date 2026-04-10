import { getStmts, getDb, genId, jsonParse, MAX_REJECTIONS } from '../lib/db.js';
import { broadcastLog } from '../lib/proxy.js';
import { syncTaskFileLifecycle, renameOnApprove, renameOnRejectOrReopen } from '../lib/task-files.js';
import { getRegistry } from '../lib/auth.js';

// ═══ Bridge Protocol v2 — typed message validation ═══
const VALID_MESSAGE_TYPES = new Set([
  'text', 'review_request', 'review_verdict', 'task_handoff', 'question',
  'answer', 'status_update', 'context_share', 'error_report',
  'task_complete_notify', 'human_directive', 'task_event',
]);

const REQUIRED_FIELDS_BY_TYPE = {
  review_request:       ['task_id', 'context'],
  review_verdict:       ['task_id', 'verdict'],
  task_handoff:         ['task_id', 'context'],
  question:             ['question'],
  answer:               ['question_ref', 'choice'],
  status_update:        ['status', 'summary'],
  context_share:        ['topic', 'data'],
  error_report:         ['error', 'request'],
  task_complete_notify: ['task_id', 'final_status'],
  human_directive:      ['directive'],
  task_event:           ['task_id', 'event'],
};

function validateTypedMessage(type, body) {
  if (!type || type === 'text') return null; // legacy untyped — no validation
  if (!VALID_MESSAGE_TYPES.has(type)) return `unknown message_type: ${type}`;
  const required = REQUIRED_FIELDS_BY_TYPE[type];
  if (!required) return null;
  for (const field of required) {
    if (body[field] === undefined && body[field] === null) continue; // present
    if (!(field in body) || body[field] === undefined || body[field] === null) {
      return `message_type '${type}' requires field '${field}'`;
    }
  }
  return null;
}

function nowIso(value) {
  if (!value) return null;
  return new Date(Number(value) * 1000).toISOString();
}

function sanitizeText(value, maxLen, { multiline = false } = {}) {
  if (value == null) return null;
  if (typeof value !== 'string') return null;
  // Strip null bytes, BOM, RTL override, ANSI escapes, and other control characters
  let cleaned = value.replace(/[\u0000\uFEFF\u202E\u200B-\u200F\u2028-\u202D\u2060-\u206F]/g, '');
  cleaned = cleaned.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, ''); // ANSI escape sequences
  // Strip HTML tags
  cleaned = cleaned.replace(/<[^>]*>/g, '');
  // For single-line fields, strip newlines; for multi-line, keep them
  if (!multiline) {
    cleaned = cleaned.replace(/[\r\n]/g, ' ');
  }
  return cleaned.trim().slice(0, maxLen);
}

function parseTags(tags) {
  if (Array.isArray(tags)) return tags.map((tag) => String(tag).slice(0, 100));
  if (typeof tags === 'string') return jsonParse(tags, []);
  return [];
}

function audit(stmts, taskId, agentId, event, payload) {
  stmts.insertAudit.run(taskId, agentId, event, JSON.stringify(payload || {}));
}

function nextStepHint(text) {
  return { next_step_hint: text };
}

// ═══ Cortex Ping System — shared emitter (v0.1) ═══
function emitTaskNotification(stmts, { event, taskId, previousStatus, newStatus, sourceAgent, targetAgent: rawTarget, reviewNotes }) {
  const targetAgent = (rawTarget || '').toLowerCase();
  if (!targetAgent) {
    console.log(`[ping] skipped ${event} for task=${taskId}: no target agent`);
    return;
  }
  try {
    const task = stmts.getCortexTask.get(taskId);
    if (!task) return;
    const project = task.project_id ? stmts.getProject.get(task.project_id) : null;
    const projectName = project?.name || 'unknown';
    const projectSlug = project?.slug || 'unknown';
    const phase = task.phase_number || 1;
    const taskPath = `projects/${projectSlug}/tasks/phase-${phase}/${taskId}/`;
    const eventId = genId();
    const payload = JSON.stringify({
      event_id: eventId,
      event,
      source_agent: sourceAgent,
      target_agent: targetAgent,
      message_type: 'task_event',
      task_id: taskId,
      task_path: taskPath,
      project: projectName,
      phase: `phase-${phase}`,
      previous_status: previousStatus,
      new_status: newStatus,
      actor: sourceAgent,
      timestamp: new Date().toISOString(),
      review_notes: reviewNotes || null,
    });
    stmts.bridgeSend.run(
      eventId, 'cortex-system', targetAgent, 'notification', payload,
      taskId, '[]', event, 'normal', taskId, null,
      'task_event', '{}', 0, null
    );
    console.log(`[ping] ${event} → ${targetAgent} (task=${taskId}, event_id=${eventId})`);
  } catch (err) {
    console.error(`[ping] emission failed: ${event} → ${targetAgent} (task=${taskId}): ${err.message}`);
  }
}

function serializeProgress(row) {
  return {
    timestamp: nowIso(row.timestamp),
    status: row.status,
    summary: row.summary,
    files_changed: jsonParse(row.files_changed, []),
    stub_detected: !!row.stub_detected,
    stub_reason: row.stub_reason || null,
  };
}

function serializeComment(row) {
  return {
    comment_id: row.id,
    author: row.author,
    comment: row.comment,
    comment_type: row.comment_type,
    timestamp: nowIso(row.created_at),
  };
}

function serializeRejection(row) {
  return {
    rejected_by: row.rejected_by,
    reason: row.reason,
    guidance: row.guidance,
    timestamp: nowIso(row.created_at),
  };
}

function serializeTaskSummary(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assigned_agent: row.assigned_agent,
    source: row.source,
    priority: row.priority || 'medium',
    project_id: row.project_id,
    phase_number: row.phase_number || 1,
    created_at: nowIso(row.created_at),
    updated_at: nowIso(row.updated_at || row.created_at),
  };
}

function serializeTaskDetail(stmts, row) {
  const progress = stmts.progressByTaskAsc.all(row.id).map(serializeProgress);
  const comments = stmts.getTaskComments.all(row.id).map(serializeComment);
  const rejections = stmts.getTaskRejections.all(row.id).map(serializeRejection);
  const cost = stmts.projectCostSummary.get(row.project_id || '__none__')?.total_cost_usd || 0;
  const today = stmts.modelCallsToday.get(row.assigned_agent || row.created_by || '') || {};

  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    source: row.source,
    created_by: row.created_by,
    assigned_agent: row.assigned_agent,
    reviewer: row.reviewer_agent,
    reviewer_agent: row.reviewer_agent,
    project_id: row.project_id,
    phase_number: row.phase_number || 1,
    priority: row.priority || 'medium',
    tags: parseTags(row.tags),
    created_at: nowIso(row.created_at),
    updated_at: nowIso(row.updated_at || row.created_at),
    claimed_at: nowIso(row.claimed_at),
    submitted_at: nowIso(row.submitted_at),
    approved_at: nowIso(row.approved_at),
    rejected_at: nowIso(row.rejected_at),
    cancelled_at: nowIso(row.cancelled_at),
    progress_reports: progress,
    comments,
    rejection_count: row.rejection_count || 0,
    rejection_history: rejections,
    total_tokens: (today.tokens_in || 0) + (today.tokens_out || 0),
    total_cost_usd: cost,
  };
}

function broadcastTaskEvent(type, data) {
  broadcastLog({ type, data });
}

function requireTask(stmts, taskId) {
  const task = stmts.getCortexTask.get(taskId);
  if (!task) return { status: 404, body: { error: 'task not found' } };
  return { task };
}

export default function cortexTasksRoutes() {
  return {
    health() {
      const stmts = getStmts();
      const dbOk = !!stmts.getCortexTask.get;
      return {
        status: 200,
        body: {
          status: dbOk ? 'operational' : 'degraded',
          services: {
            gateway: { status: 'up', port: 4840, uptime_seconds: Math.floor(process.uptime()) },
            database: { status: dbOk ? 'up' : 'down' },
          },
          ...nextStepHint('Check your state, then task_list or get_next_task.'),
        },
      };
    },

    heartbeat(body, { agentIdentity } = {}) {
      const stmts = getStmts();
      const agentId = agentIdentity || body.agent_id;
      if (!agentId) return { status: 401, body: { error: 'missing or invalid token' } };
      stmts.upsertHeartbeat.run(agentId, null, body.task_id || null, body.task_id || null, body.status || 'active');
      broadcastTaskEvent('agent:heartbeat', {
        agent: agentId,
        status: body.status || 'active',
        current_task: body.task_id || null,
        timestamp: new Date().toISOString(),
      });
      return {
        status: 200,
        body: {
          agent_id: agentId,
          received_at: new Date().toISOString(),
          next_heartbeat_before: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          ...nextStepHint('Heartbeat recorded. Continue work.'),
        },
      };
    },

    agentStatus(agentId = null) {
      const stmts = getStmts();
      if (!agentId) {
        return {
          status: 200,
          body: {
            agents: stmts.listAgents.all().map((row) => {
              const heartbeat = stmts.getHeartbeat.get(row.id);
              // Clean stale task refs: if current_task points to a non-existent or terminal task, clear it
              let currentTask = null;
              if (heartbeat?.current_task) {
                const refTask = stmts.getCortexTask.get(heartbeat.current_task);
                if (refTask && !['approved', 'cancelled', 'rejected', 'failed'].includes(refTask.status)) {
                  currentTask = { id: heartbeat.current_task };
                } else {
                  try { stmts.markAgentIdle.run(row.id); } catch {}
                }
              }
              return {
                agent_id: row.id,
                platform: heartbeat?.platform || row.id,
                model: row.model,
                provider: row.provider,
                status: heartbeat?.status || row.status,
                current_task: currentTask,
                last_heartbeat: nowIso(heartbeat?.last_seen),
              };
            }),
            ...nextStepHint('Review your current state, then inspect active tasks or claim new work.'),
          },
        };
      }

      const row = stmts.getAgent.get(agentId) || { id: agentId, name: agentId, provider: null, model: null, status: 'unknown' };
      const heartbeat = stmts.getHeartbeat.get(agentId);
      const task = heartbeat?.current_task ? stmts.getCortexTask.get(heartbeat.current_task) : null;
      const today = stmts.modelCallsToday.get(agentId) || {};
      return {
        status: 200,
        body: {
          agent_id: agentId,
          platform: heartbeat?.platform || agentId,
          model: row.model,
          provider: row.provider,
          status: heartbeat?.status || row.status,
          current_task: task ? { id: task.id, title: task.title, status: task.status } : null,
          last_heartbeat: nowIso(heartbeat?.last_seen),
          session_metrics: {
            requests: today.requests || 0,
            tokens_in: today.tokens_in || 0,
            tokens_out: today.tokens_out || 0,
            cost_usd: today.cost || 0,
            errors: today.errors || 0,
          },
          ...nextStepHint(task ? 'Agent active with task in progress.' : 'Agent active. Call task_list or get_next_task to inspect work.'),
        },
      };
    },

    getNext(platform, { agentIdentity } = {}) {
      const stmts = getStmts();
      const reviewTask = agentIdentity
        ? stmts.listCortexTasksFiltered.all({ status: 'review', agent: null, project_id: null, source: null, limit: 200 }).find((task) => task.reviewer_agent === agentIdentity)
        : null;
      if (reviewTask) {
        return {
          status: 200,
          body: {
            id: reviewTask.id,
            title: reviewTask.title,
            description: reviewTask.description,
            status: reviewTask.status,
            reviewer: reviewTask.reviewer_agent,
            created_at: nowIso(reviewTask.created_at),
            ...nextStepHint('Pick up tasks in review status where you are the reviewer.'),
          },
        };
      }
      const task = stmts.getNextTask.get(platform || null, platform || null);
      if (!task) {
        return {
          status: 200,
          body: {
            id: null,
            message: 'No pending tasks available.',
            ...nextStepHint('No work available. Call task_create if you have work to do, or try again later.'),
          },
        };
      }
      return {
        status: 200,
        body: {
          id: task.id,
          title: task.title,
          description: task.description,
          status: task.status,
          priority: task.priority || 'medium',
          created_at: nowIso(task.created_at),
          ...nextStepHint('Claim it if it matches your work, or task_create if nothing fits.'),
        },
      };
    },

    getTask(taskId) {
      const stmts = getStmts();
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      return {
        status: 200,
        body: {
          ...serializeTaskDetail(stmts, result.task),
          ...nextStepHint(result.task.status === 'in_progress' ? 'Task is in_progress. Continue work, then call submit_result when done.' : 'Task retrieved. Decide the next lifecycle step from its current status.'),
        },
      };
    },

    create(body, { agentIdentity, isAdmin } = {}) {
      const stmts = getStmts();
      const title = sanitizeText(body.title, 200);
      const description = sanitizeText(body.description, 5000, { multiline: true });
      if (!title) return { status: 400, body: { error: 'title required' } };

      const projectId = body.project_id || null;
      if (!projectId) return { status: 400, body: { error: 'project_id is required' } };
      const project = stmts.getProject.get(projectId);
      if (!project) return { status: 404, body: { error: 'project not found' } };

      const phaseNumber = Number(body.phase_number);
      if (!phaseNumber || !Number.isInteger(phaseNumber) || phaseNumber < 1) {
        return { status: 400, body: { error: 'phase_number is required' } };
      }
      if (phaseNumber > (project.phase_count || 1)) {
        return { status: 400, body: { error: `phase ${phaseNumber} does not exist for this project` } };
      }

      const id = genId();
      const source = isAdmin ? 'human' : 'agent';
      const createdBy = agentIdentity || 'human';
      const priority = ['low', 'medium', 'high', 'critical'].includes(body.priority) ? body.priority : 'medium';
      const tags = JSON.stringify(parseTags(body.tags));
      // BUG-26: Tasks should only get assigned_agent through claim_task, not create
      const assignedAgent = null;
      stmts.createCortexTask.run(id, title, description, source, createdBy, assignedAgent, null, projectId, phaseNumber, priority, tags);
      const created = stmts.getCortexTask.get(id);

      // If project or phase had (finished) marker, remove it since we're adding a new task
      try {
        renameOnRejectOrReopen({ stmts, taskId: id });
      } catch { /* best effort */ }

      let fileSync = null;
      try {
        fileSync = syncTaskFileLifecycle({ stmts, taskId: id, phase: phaseNumber });
      } catch (err) {
        fileSync = { warning: err.message };
      }
      audit(stmts, id, createdBy, 'task_created', { title, project_id: projectId, phase_number: phaseNumber, priority, tags: parseTags(tags), source, assigned_agent: assignedAgent });
      broadcastTaskEvent('task:created', {
        id,
        title,
        status: 'pending',
        source,
        created_by: createdBy,
        priority,
        project_id: projectId,
        phase_number: phaseNumber,
        assigned_agent: assignedAgent,
      });
      if (assignedAgent) {
        emitTaskNotification(stmts, {
          event: 'task_assigned',
          taskId: id,
          previousStatus: null,
          newStatus: 'pending',
          sourceAgent: createdBy,
          targetAgent: assignedAgent,
        });
      }

      return {
        status: 201,
        body: {
          ...serializeTaskDetail(stmts, created),
          file_sync: fileSync,
          ...nextStepHint('Creates the task in the DB and the folder on disk. Now claim it.'),
        },
      };
    },

    list(query = {}, { agentIdentity, isAdmin } = {}) {
      const stmts = getStmts();
      const db = getDb();
      const limit = Math.min(Math.max(1, Number(query.limit) || 50), 200);
      const status = query.status || null;
      const agent = query.agent || null;
      const project_id = query.project_id || null;
      const source = query.source || null;

      // BUG-27: Get true total count before the LIMIT-capped query
      let total;
      let tasks;
      if (status || agent || project_id || source) {
        // BUG-02: Ensure limit is a number for SQLite named parameter binding
        tasks = stmts.listCortexTasksFiltered.all({ status, agent, project_id, source, limit: Number(limit) });
        total = db.prepare(`
          SELECT COUNT(*) as count FROM cortex_tasks
          WHERE (@status IS NULL OR status = @status)
            AND (@agent IS NULL OR assigned_agent = @agent)
            AND (@project_id IS NULL OR project_id = @project_id)
            AND (@source IS NULL OR source = @source)
        `).get({ status, agent, project_id, source })?.count || 0;
      } else {
        tasks = stmts.listCortexTasks.all(limit);
        total = db.prepare(`SELECT COUNT(*) as count FROM cortex_tasks`).get()?.count || 0;
      }

      // BUG-03: Apply scoping — non-admin agents only see their own tasks
      let scopedTasks = tasks;
      if (agentIdentity && !isAdmin) {
        const id = agentIdentity.toLowerCase();
        scopedTasks = tasks.filter(t =>
          (t.assigned_agent || '').toLowerCase() === id ||
          (t.assigned_platform || '').toLowerCase() === id ||
          (t.created_by || '').toLowerCase() === id
        );
        total = scopedTasks.length;
      }
      const serialized = scopedTasks.map(serializeTaskSummary);

      return {
        status: 200,
        body: {
          tasks: serialized,
          total,
          ...nextStepHint(query.status === 'review' ? 'Pick up tasks in review status where you are the reviewer.' : 'Use task_get with a task ID for full detail. Use claim_task to start working on a pending task.'),
        },
      };
    },

    claim(taskId, { agentIdentity, platform } = {}) {
      const stmts = getStmts();
      if (!agentIdentity) return { status: 401, body: { error: 'missing or invalid token' } };
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      if (result.task.status !== 'pending') return { status: 409, body: { error: `cannot claim: task status is '${result.task.status}', must be 'pending'` } };
      const changed = stmts.claimTask.run(agentIdentity, platform || agentIdentity, taskId);
      if (changed.changes === 0) return { status: 409, body: { error: 'task not in pending status' } };
      const task = stmts.getCortexTask.get(taskId);
      let fileSync = null;
      try {
        fileSync = syncTaskFileLifecycle({ stmts, taskId });
      } catch (err) {
        fileSync = { warning: err.message };
      }
      audit(stmts, taskId, agentIdentity, 'task_claimed', {});
      broadcastTaskEvent('task:claimed', { task_id: taskId, agent: agentIdentity, claimed_at: nowIso(task.claimed_at) });
      emitTaskNotification(stmts, {
        event: 'task.claimed',
        taskId,
        previousStatus: 'pending',
        newStatus: 'claimed',
        sourceAgent: agentIdentity,
        targetAgent: result.task.created_by,
        reviewNotes: null,
      });
      return {
        status: 200,
        body: {
          id: task.id,
          title: task.title,
          status: task.status,
          assigned_agent: task.assigned_agent,
          claimed_at: nowIso(task.claimed_at),
          file_sync: fileSync,
          ...nextStepHint("Task claimed. Call report_progress with status='planning' and a summary of your approach BEFORE writing any code."),
        },
      };
    },

    progress(taskId, body, { agentIdentity } = {}) {
      const stmts = getStmts();
      if (!agentIdentity) return { status: 401, body: { error: 'missing or invalid token' } };
      // Rate limit: max 1 progress report per 5 seconds per task
      const lastProgress = stmts.getProgressByTask.all(taskId)?.[0];
      if (lastProgress && lastProgress.timestamp) {
        const elapsed = Math.floor(Date.now() / 1000) - lastProgress.timestamp;
        if (elapsed < 5) return { status: 429, body: { error: `rate limited — wait ${5 - elapsed}s between progress reports` } };
      }
      let status = body.status;
      if (status === 'implementation') status = 'in_progress';
      if (!['planning', 'in_progress', 'testing', 'reviewing'].includes(status)) {
        return { status: 400, body: { error: 'invalid progress status' } };
      }
      const summary = sanitizeText(body.summary, 2000);
      if (!summary) return { status: 400, body: { error: 'summary required' } };
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      const task = result.task;
      const ownerProgress = task.assigned_agent === agentIdentity && ['claimed', 'in_progress', 'rejected'].includes(task.status) && status !== 'reviewing';
      const reviewerProgress = task.reviewer_agent === agentIdentity && task.status === 'review' && status === 'reviewing';
      if (!ownerProgress && !reviewerProgress) return { status: 403, body: { error: "agent cannot report progress for this task state" } };
      if (task.status == 'claimed') stmts.advanceTask.run('in_progress', taskId, 'claimed');
      if (task.status == 'rejected' && ownerProgress) stmts.advanceTask.run('in_progress', taskId, 'rejected');
      const filesChanged = JSON.stringify(Array.isArray(body.files_changed) ? body.files_changed : []);
      if (status === 'in_progress' && jsonParse(filesChanged, []).length === 0) {
        return { status: 409, body: { error: 'implementation progress must include files_changed' } };
      }
      stmts.insertProgress.run(taskId, agentIdentity, status, summary, filesChanged, 0, null);
      audit(stmts, taskId, agentIdentity, 'task_progress', { status, summary });
      const count = stmts.countProgressByTask.get(taskId)?.count || 0;
      let fileSync = null;
      try {
        fileSync = syncTaskFileLifecycle({ stmts, taskId });
      } catch (err) {
        fileSync = { warning: err.message };
      }
      broadcastTaskEvent('task:progress', {
        task_id: taskId,
        agent: agentIdentity,
        progress_count: count,
        status,
        summary,
        files_changed: jsonParse(filesChanged, []),
        timestamp: new Date().toISOString(),
      });
      return {
        status: 200,
        body: {
          task_id: taskId,
          progress_count: count,
          status: stmts.getCortexTask.get(taskId)?.status || 'in_progress',
          file_sync: fileSync,
          ...nextStepHint(status === 'planning'
            ? 'Begin implementation.'
            : status === 'in_progress'
              ? 'Must include files_changed. Report at least once more before submitting.'
              : status === 'testing'
                ? 'Run tests, report results, then submit_result.'
                : 'Document your findings.'),
        },
      };
    },

    submit(taskId, body, { agentIdentity } = {}) {
      const stmts = getStmts();
      if (!agentIdentity) return { status: 401, body: { error: 'missing or invalid token' } };
      const summary = sanitizeText(body.summary, 5000);
      if (!summary) return { status: 400, body: { error: 'summary required' } };
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      const task = result.task;
      if (task.assigned_agent !== agentIdentity) return { status: 403, body: { error: "agent doesn't own this task" } };
      if (task.status !== 'in_progress') return { status: 409, body: { error: 'task not in in_progress status' } };
      const count = stmts.countProgressByTask.get(taskId)?.count || 0;
      if (count < 2) return { status: 409, body: { error: 'fewer than 2 progress reports' } };
      // BUG-17: Validate that at least one planning and one testing report exist
      const progressRows = stmts.progressByTaskAsc.all(taskId);
      const hasPlanning = progressRows.some(r => r.status === 'planning');
      const hasTesting = progressRows.some(r => r.status === 'testing');
      if (!hasPlanning || !hasTesting) {
        return { status: 409, body: { error: 'submit requires at least one "planning" and one "testing" progress report' } };
      }
      const fileProgressCount = stmts.countProgressWithFiles.get(taskId)?.count || 0;
      if (fileProgressCount < 1) return { status: 409, body: { error: 'submit_result requires at least one progress report with files_changed' } };
      const stubCount = stmts.countStubsByTask.get(taskId)?.count || 0;
      if (stubCount > 0 && !body.override_stub_check) return { status: 409, body: { error: 'submit_result blocked: stubs detected', stub_count: stubCount } };
      stmts.submitTask.run(summary, taskId);
      const filesChanged = JSON.stringify(Array.isArray(body.files_changed) ? body.files_changed : []);
      stmts.insertProgress.run(taskId, agentIdentity, 'submitted', summary, filesChanged, 0, null);
      const updated = stmts.getCortexTask.get(taskId);
      let fileSync = null;
      try {
        fileSync = syncTaskFileLifecycle({ stmts, taskId });
      } catch (err) {
        fileSync = { warning: err.message };
      }
      audit(stmts, taskId, agentIdentity, 'task_submitted', { summary });
      broadcastTaskEvent('task:submitted', {
        task_id: taskId,
        agent: agentIdentity,
        summary,
        files_changed: jsonParse(filesChanged, []),
        submitted_at: nowIso(updated.submitted_at),
      });
      return {
        status: 200,
        body: {
          task_id: taskId,
          status: updated.status,
          submitted_at: nowIso(updated.submitted_at),
          file_sync: fileSync,
          ...nextStepHint('Blocked if stubs detected or no real file changes.'),
        },
      };
    },

    requestReview(taskId, body, { agentIdentity } = {}) {
      const stmts = getStmts();
      if (!agentIdentity) return { status: 401, body: { error: 'missing or invalid token' } };
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      const task = result.task;
      if (task.assigned_agent !== agentIdentity) return { status: 403, body: { error: "agent doesn't own this task" } };
      if (task.status !== 'submitted') return { status: 409, body: { error: 'not in submitted status' } };
      if (task.rejection_count >= MAX_REJECTIONS) {
        return { status: 422, body: { error: `Task has been rejected ${task.rejection_count} times (max ${MAX_REJECTIONS}). Use task_reopen + reassign or cancel instead.` } };
      }
      let reviewer = sanitizeText(body.reviewer || body.reviewer_agent, 100);
      // Fall back to project's default reviewer if none specified
      if (!reviewer && task.project_id) {
        const project = stmts.getProject.get(task.project_id);
        if (project?.default_reviewer) reviewer = project.default_reviewer;
      }
      if (!reviewer) return { status: 400, body: { error: 'reviewer required — set one here or configure a default reviewer on the project' } };
      if (reviewer === agentIdentity) return { status: 403, body: { error: 'cannot review your own work' } };
      stmts.verifyTask.run(reviewer, taskId);
      let fileSync = null;
      try {
        fileSync = syncTaskFileLifecycle({ stmts, taskId });
      } catch (err) {
        fileSync = { warning: err.message };
      }
      audit(stmts, taskId, agentIdentity, 'review_requested', { reviewer });
      broadcastTaskEvent('task:review_requested', { task_id: taskId, agent: agentIdentity, reviewer, timestamp: new Date().toISOString() });
      emitTaskNotification(stmts, {
        event: 'task.review_requested',
        taskId,
        previousStatus: 'submitted',
        newStatus: 'review',
        sourceAgent: agentIdentity,
        targetAgent: reviewer,
        reviewNotes: null,
      });
      return {
        status: 200,
        body: {
          task_id: taskId,
          status: 'review',
          reviewer,
          file_sync: fileSync,
          ...nextStepHint('Specify reviewer agent. Cannot be yourself.'),
        },
      };
    },

    approve(taskId, body, { agentIdentity, isAdmin } = {}) {
      const stmts = getStmts();
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      const task = result.task;
      if (task.status !== 'review') return { status: 409, body: { error: 'not in review status' } };
      if (!isAdmin && task.reviewer_agent !== agentIdentity) return { status: 403, body: { error: 'not the assigned reviewer and not admin' } };
      if (task.assigned_agent === agentIdentity) return { status: 403, body: { error: 'cannot review your own work' } };
      const comment = sanitizeText(body.comment, 2000);
      stmts.approveTask.run(comment || null, taskId);
      if (comment) stmts.insertTaskComment.run(genId(), taskId, agentIdentity || 'admin', comment, 'approval', null);
      const updated = stmts.getCortexTask.get(taskId);
      // Folder rename: task → (finished), cascade to phase/project
      let renameResult = null;
      try {
        renameResult = renameOnApprove({ stmts, taskId });
      } catch (err) {
        console.error(`[cortex-tasks] approve rename failed: ${err.message}`);
      }
      let fileSync = null;
      try {
        fileSync = syncTaskFileLifecycle({ stmts, taskId });
      } catch (err) {
        fileSync = { warning: err.message };
      }
      audit(stmts, taskId, agentIdentity || 'admin', 'task_approved', { comment });
      broadcastTaskEvent('task:approved', { task_id: taskId, approved_by: agentIdentity || 'admin', comment, approved_at: nowIso(updated.approved_at) });
      emitTaskNotification(stmts, {
        event: 'task.approved',
        taskId,
        previousStatus: 'review',
        newStatus: 'approved',
        sourceAgent: agentIdentity || 'admin',
        targetAgent: task.assigned_agent,
        reviewNotes: comment || null,
      });
      return {
        status: 200,
        body: {
          task_id: taskId,
          status: 'approved',
          approved_by: agentIdentity || 'admin',
          approved_at: nowIso(updated.approved_at),
          comment: comment || null,
          file_sync: fileSync,
          folder_rename: renameResult,
          ...nextStepHint('Cannot review your own work.'),
        },
      };
    },

    reject(taskId, body, { agentIdentity, isAdmin } = {}) {
      const stmts = getStmts();
      const reason = sanitizeText(body.reason, 2000);
      if (!reason) return { status: 400, body: { error: 'missing reason' } };
      const guidance = sanitizeText(body.guidance, 2000);
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      const task = result.task;
      if (task.status !== 'review') return { status: 409, body: { error: 'not in review status' } };
      if (!isAdmin && task.reviewer_agent !== agentIdentity) return { status: 403, body: { error: 'not reviewer/admin' } };
      if (task.assigned_agent === agentIdentity) return { status: 403, body: { error: 'cannot review your own work' } };
      stmts.rejectTask.run(reason, taskId);
      stmts.incrementRejectionCount.run(taskId);
      stmts.insertTaskComment.run(genId(), taskId, agentIdentity || 'admin', reason, 'rejection', null);
      stmts.insertTaskRejection.run(genId(), taskId, agentIdentity || 'admin', reason, guidance || null);
      const updated = stmts.getCortexTask.get(taskId);
      // Cascade remove (finished) markers from task, phase, project
      try {
        renameOnRejectOrReopen({ stmts, taskId });
      } catch (err) {
        console.error(`[cortex-tasks] reject rename failed: ${err.message}`);
      }
      let fileSync = null;
      try {
        fileSync = syncTaskFileLifecycle({ stmts, taskId });
      } catch (err) {
        fileSync = { warning: err.message };
      }
      audit(stmts, taskId, agentIdentity || 'admin', 'task_rejected', { reason, guidance });
      broadcastTaskEvent('task:rejected', { task_id: taskId, rejected_by: agentIdentity || 'admin', reason, guidance, rejected_at: nowIso(updated.rejected_at) });
      emitTaskNotification(stmts, {
        event: 'task.rejected',
        taskId,
        previousStatus: 'review',
        newStatus: 'in_progress',
        sourceAgent: agentIdentity || 'admin',
        targetAgent: task.assigned_agent,
        reviewNotes: reason,
      });
      return {
        status: 200,
        body: {
          task_id: taskId,
          status: 'in_progress',
          rejected_by: agentIdentity || 'admin',
          rejected_at: nowIso(updated.rejected_at),
          reason,
          guidance: guidance || null,
          file_sync: fileSync,
          ...nextStepHint('Cannot review your own work. If rejected, include feedback.'),
        },
      };
    },

    update(taskId, body, { agentIdentity, isAdmin } = {}) {
      const stmts = getStmts();
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      const task = result.task;
      if (!isAdmin && ['claimed', 'in_progress'].includes(task.status) && task.assigned_agent !== agentIdentity) {
        return { status: 403, body: { error: 'another agent owns this task' } };
      }
      const title = body.title === undefined ? null : sanitizeText(body.title, 200);
      const description = body.description === undefined ? null : sanitizeText(body.description, 5000, { multiline: true });
      const priority = body.priority === undefined ? null : body.priority;
      const tags = body.tags === undefined ? null : JSON.stringify(parseTags(body.tags));
      if (title == null && description == null && priority == null && tags == null) return { status: 400, body: { error: 'no fields to update' } };
      stmts.updateCortexTask.run(title, description, priority, tags, taskId);
      const updated = stmts.getCortexTask.get(taskId);
      audit(stmts, taskId, agentIdentity || 'admin', 'task_updated', { title, description, priority, tags: tags ? jsonParse(tags, []) : null });
      broadcastTaskEvent('task:updated', { task_id: taskId, updated_by: agentIdentity || 'admin', updated_at: nowIso(updated.updated_at) });
      return { status: 200, body: { id: taskId, title: updated.title, updated_at: nowIso(updated.updated_at), ...nextStepHint('Task updated.') } };
    },

    cancel(taskId, body, { agentIdentity, isAdmin } = {}) {
      try {
        const stmts = getStmts();
        const reason = sanitizeText(body?.reason, 1000);
        if (!reason) return { status: 400, body: { error: 'reason required' } };
        const result = requireTask(stmts, taskId);
        if (result.status) return result;
        const task = result.task;
        // BUG-29: Only creator, assigned agent, or admin can cancel
        if (!isAdmin && task.created_by !== agentIdentity && (!task.assigned_agent || task.assigned_agent !== agentIdentity)) {
          return { status: 403, body: { error: 'only task creator, assigned agent, or admin can cancel' } };
        }
        if (['approved', 'cancelled'].includes(task.status)) {
          return { status: 409, body: { error: `cannot cancel task in '${task.status}' status` } };
        }
        const changes = stmts.cancelTask.run(agentIdentity || 'admin', reason, taskId);
        if (changes.changes === 0) return { status: 409, body: { error: 'task could not be cancelled' } };
        const updated = stmts.getCortexTask.get(taskId);
        try { audit(stmts, taskId, agentIdentity || 'admin', 'task_cancelled', { reason }); } catch {}
        try { broadcastTaskEvent('task:cancelled', { task_id: taskId, cancelled_by: agentIdentity || 'admin', reason, cancelled_at: nowIso(updated?.cancelled_at) }); } catch {}
        return {
          status: 200,
          body: {
            task_id: taskId,
            status: 'cancelled',
            cancelled_at: nowIso(updated.cancelled_at),
            cancelled_by: agentIdentity || 'admin',
            reason,
            ...nextStepHint('Task cancelled. Call get_next_task for more work.'),
          },
        };
      } catch (err) {
        console.error(`[cortex-tasks] cancel failed for task=${taskId}: ${err.message}\n${err.stack}`);
        return { status: 500, body: { error: 'internal error during task cancellation', detail: err.message } };
      }
    },

    release(taskId, body, { agentIdentity, isAdmin } = {}) {
      const stmts = getStmts();
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      const task = result.task;
      if (!['claimed', 'in_progress'].includes(task.status)) return { status: 409, body: { error: 'not in claimed/in_progress' } };
      if (!isAdmin && task.assigned_agent !== agentIdentity) return { status: 403, body: { error: 'not owner/admin' } };
      stmts.releaseTask.run(taskId);
      let fileSync = null;
      try {
        fileSync = syncTaskFileLifecycle({ stmts, taskId });
      } catch (err) {
        fileSync = { warning: err.message };
      }
      audit(stmts, taskId, agentIdentity || 'admin', 'task_released', { reason: body.reason || null });
      broadcastTaskEvent('task:released', { task_id: taskId, released_by: agentIdentity || 'admin', reason: body.reason || null, timestamp: new Date().toISOString() });
      return {
        status: 200,
        body: {
          task_id: taskId,
          status: 'pending',
          assigned_agent: null,
          file_sync: fileSync,
          ...nextStepHint('Task released. Any agent can claim it.'),
        },
      };
    },

    reassign(taskId, body, { agentIdentity, isAdmin } = {}) {
      const stmts = getStmts();
      if (!isAdmin) return { status: 403, body: { error: 'admin access required' } };
      const newAgent = sanitizeText(body.new_agent || body.agent_id, 100);
      if (!newAgent) return { status: 400, body: { error: 'new_agent required' } };
      const registry = getRegistry();
      if (!registry.agents[newAgent] && !registry.agents[newAgent.toLowerCase()]) {
        return { status: 400, body: { error: `agent '${newAgent}' not found in registry` } };
      }
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      stmts.reassignTask.run(newAgent, taskId);
      let fileSync = null;
      try {
        fileSync = syncTaskFileLifecycle({ stmts, taskId });
      } catch (err) {
        fileSync = { warning: err.message };
      }
      stmts.insertTaskComment.run(genId(), taskId, agentIdentity || 'admin', `Reassigned to ${newAgent}`, 'system', null);
      audit(stmts, taskId, agentIdentity || 'admin', 'task_reassigned', { to: newAgent, from: result.task.assigned_agent });
      broadcastTaskEvent('task:reassigned', { task_id: taskId, reassigned_by: agentIdentity || 'admin', new_agent: newAgent, timestamp: new Date().toISOString() });
      emitTaskNotification(stmts, {
        event: 'task_assigned',
        taskId,
        previousStatus: result.task.status,
        newStatus: 'pending',
        sourceAgent: agentIdentity || 'admin',
        targetAgent: newAgent,
      });
      return {
        status: 200,
        body: {
          task_id: taskId,
          assigned_agent: newAgent,
          status: 'pending',
          file_sync: fileSync,
          ...nextStepHint(`Reassigned to ${newAgent} as pending. They can now claim it.`),
        },
      };
    },

    comment(taskId, body, { agentIdentity } = {}) {
      const stmts = getStmts();
      if (!agentIdentity) return { status: 401, body: { error: 'missing or invalid token' } };
      const comment = sanitizeText(body.comment, 2000);
      if (!comment) return { status: 400, body: { error: 'comment required' } };
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      const commentId = genId();
      stmts.insertTaskComment.run(commentId, taskId, agentIdentity, comment, 'note', null);
      audit(stmts, taskId, agentIdentity, 'task_comment', { comment });
      broadcastTaskEvent('task:comment', { task_id: taskId, author: agentIdentity, comment, timestamp: new Date().toISOString() });
      return {
        status: 201,
        body: {
          task_id: taskId,
          comment_id: commentId,
          author: agentIdentity,
          comment,
          timestamp: new Date().toISOString(),
          ...nextStepHint('Comment added. Continue work.'),
        },
      };
    },

    reopen(taskId, body, { agentIdentity, isAdmin } = {}) {
      const stmts = getStmts();
      const reason = sanitizeText(body.reason, 1000);
      if (!reason) return { status: 400, body: { error: 'reason required' } };
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      if (!['approved', 'rejected'].includes(result.task.status)) return { status: 409, body: { error: 'not in approved/rejected status' } };
      stmts.reopenTask.run(taskId);
      // Cascade remove (finished) markers from task, phase, project
      try {
        renameOnRejectOrReopen({ stmts, taskId });
      } catch (err) {
        console.error(`[cortex-tasks] reopen rename failed: ${err.message}`);
      }
      let fileSync = null;
      try {
        fileSync = syncTaskFileLifecycle({ stmts, taskId });
      } catch (err) {
        fileSync = { warning: err.message };
      }
      stmts.insertTaskComment.run(genId(), taskId, agentIdentity || 'admin', `Reopened: ${reason}`, 'system', null);
      audit(stmts, taskId, agentIdentity || 'admin', 'task_reopened', { reason, previous_status: result.task.status });
      broadcastTaskEvent('task:reopened', { task_id: taskId, reopened_by: agentIdentity || 'admin', reason, previous_status: result.task.status, timestamp: new Date().toISOString() });
      return {
        status: 200,
        body: {
          task_id: taskId,
          status: 'pending',
          assigned_agent: null,
          reopened_by: agentIdentity || 'admin',
          reason,
          file_sync: fileSync,
          ...nextStepHint('Reopened as pending. Call claim_task to rework.'),
        },
      };
    },

    getProgress(taskId) {
      const stmts = getStmts();
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      const progress = stmts.progressByTaskAsc.all(taskId).map(serializeProgress);
      return {
        status: 200,
        body: {
          task_id: taskId,
          progress_reports: progress,
          total: progress.length,
          ...nextStepHint('Progress history retrieved.'),
        },
      };
    },

    fail(taskId, body) {
      const stmts = getStmts();
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      const task = result.task;
      if (['approved', 'cancelled', 'failed'].includes(task.status)) {
        return { status: 409, body: { error: `cannot fail task in '${task.status}' state` } };
      }
      stmts.failTask.run(taskId);
      const updated = stmts.getCortexTask.get(taskId);
      let fileSync = null;
      try {
        fileSync = syncTaskFileLifecycle({ stmts, taskId });
      } catch (err) {
        fileSync = { warning: err.message };
      }
      audit(stmts, taskId, 'system', 'task_failed', { reason: body.reason || null });
      broadcastTaskEvent('task:failed', { task_id: taskId, timestamp: new Date().toISOString() });
      return {
        status: 200,
        body: {
          task_id: taskId,
          status: 'failed',
          file_sync: fileSync,
          ...nextStepHint('Task marked as failed.'),
        },
      };
    },

    getAudit(taskId) {
      const stmts = getStmts();
      const result = requireTask(stmts, taskId);
      if (result.status) return result;
      const events = stmts.getAuditByTask.all(taskId).map((row) => ({
        event_type: row.event_type,
        agent_id: row.agent_id,
        payload: jsonParse(row.payload, {}),
        timestamp: nowIso(row.timestamp),
      }));
      return {
        status: 200,
        body: {
          task_id: taskId,
          events,
          total: events.length,
          ...nextStepHint('Audit trail retrieved.'),
        },
      };
    },

    staleAgents(seconds) {
      const stmts = getStmts();
      const threshold = Number(seconds) || 300;
      const agents = stmts.getStaleAgents.all(threshold).map((row) => ({
        agent_id: row.agent_id,
        platform: row.platform,
        last_seen: nowIso(row.last_seen),
        current_task: row.current_task,
        status: row.status,
      }));
      return {
        status: 200,
        body: {
          agents,
          total: agents.length,
          threshold_seconds: threshold,
          ...nextStepHint('Stale agents retrieved.'),
        },
      };
    },

    bridgeSend(body, { agentIdentity } = {}) {
      const stmts = getStmts();
      if (!agentIdentity) return { status: 401, body: { error: 'missing or invalid token' } };
      const to = sanitizeText(body.to, 100);
      if (!to) return { status: 400, body: { error: 'to is required' } };

      // BUG-22: Validate target agent exists in registry (unless broadcast)
      if (to !== 'all') {
        const registry = getRegistry();
        const targetLower = to.toLowerCase();
        if (!registry.agents[to] && !registry.agents[targetLower]) {
          return { status: 404, body: { error: `target agent '${to}' not found in registry` } };
        }
      }

      // Typed message support — validate type and required fields
      const messageType = body.type || body.message_type || 'text';
      const validationError = validateTypedMessage(messageType, body);
      if (validationError) return { status: 400, body: { error: validationError } };

      // For typed messages, subject/body can be auto-derived
      const subject = sanitizeText(body.subject, 200) || messageType;
      const messageBody = sanitizeText(body.body, 5000) || body.summary || JSON.stringify(body.context || {}).slice(0, 5000);
      const context = body.context ? JSON.stringify(body.context) : '{}';
      const blocking = body.blocking ? 1 : 0;
      const expiresAt = body.expires_at ? Math.floor(new Date(body.expires_at).getTime() / 1000) : null;
      const priority = body.priority === 'urgent' || body.priority === 'critical' ? 'urgent' : 'normal';
      const messageId = genId();

      stmts.bridgeSend.run(
        messageId, agentIdentity, to, 'message', messageBody,
        body.task_id || body.reference_task_id || null, JSON.stringify([]),
        subject, priority, body.task_id || body.reference_task_id || null, null,
        messageType, context, blocking, expiresAt
      );

      return {
        status: 200,
        body: {
          message_id: messageId,
          from: agentIdentity,
          to,
          type: messageType,
          sent_at: new Date().toISOString(),
          ...nextStepHint('Message sent.'),
        },
      };
    },

    bridgeInbox(agentId, query = {}) {
      const stmts = getStmts();
      const limit = Math.min(Math.max(1, Number(query.limit) || 20), 100);
      const unreadOnly = query.unread_only !== 'false' && query.unread_only !== false;
      const markRead = query.mark_read !== 'false' && query.mark_read !== false;
      const messages = agentId
        ? (unreadOnly ? stmts.bridgeInbox.all(agentId, limit) : stmts.bridgeAll.all(agentId, limit))
        : stmts.bridgeRecent.all(limit);

      // Capture unread count BEFORE marking read
      const unreadCount = agentId
        ? (stmts.bridgeUnreadCountByAgent.get(agentId)?.count || 0)
        : (stmts.bridgeUnreadCountAll.get()?.count || 0);

      // Mark delivery for the returned page only.
      for (const row of messages) {
        stmts.bridgeMarkDelivered.run(row.id);
        if (agentId && markRead) stmts.bridgeMarkReadById.run(row.id, agentId);
      }

      return {
        status: 200,
        body: {
          messages: messages.map((row) => ({
            message_id: row.id,
            from: row.from_agent,
            to: row.to_agent,
            type: row.message_type || 'text',
            subject: row.subject || '',
            body: row.content,
            context: jsonParse(row.context, {}),
            blocking: !!row.blocking,
            priority: row.priority || 'normal',
            task_id: row.reference_task_id || row.task_id || null,
            reference_task_id: row.reference_task_id || row.task_id || null,
            in_reply_to: row.in_reply_to || null,
            sent_at: nowIso(row.sent_at || row.created_at),
            delivered_at: nowIso(row.delivered_at),
            acknowledged_at: nowIso(row.acknowledged_at),
            read: !!row.read,
          })),
          total_unread: unreadCount,
          ...nextStepHint(`${messages.length} message${messages.length === 1 ? '' : 's'} ${messages.length ? 'retrieved' : 'found'}.`),
        },
      };
    },

    bridgeReply(messageId, body, { agentIdentity } = {}) {
      const stmts = getStmts();
      if (!agentIdentity) return { status: 401, body: { error: 'missing or invalid token' } };
      const original = stmts.bridgeGetById.get(messageId);
      if (!original) return { status: 404, body: { error: 'message not found' } };
      if (original.to_agent !== agentIdentity) {
        return { status: 403, body: { error: 'can only reply to messages addressed to you' } };
      }
      const replyBody = sanitizeText(body.body, 5000);
      if (!replyBody) return { status: 400, body: { error: 'body required' } };
      const replyId = genId();
      stmts.bridgeSend.run(replyId, agentIdentity, original.from_agent, 'reply', replyBody, original.reference_task_id || original.task_id || null, JSON.stringify([]), `Re: ${original.subject || ''}`.trim(), original.priority || 'normal', original.reference_task_id || original.task_id || null, messageId, body.type || 'text', JSON.stringify(body.context || {}), 0, null);
      return {
        status: 200,
        body: {
          message_id: replyId,
          in_reply_to: messageId,
          from: agentIdentity,
          to: original.from_agent,
          sent_at: new Date().toISOString(),
          ...nextStepHint('Reply sent.'),
        },
      };
    },

    bridgeAck(messageId, { agentIdentity } = {}) {
      const stmts = getStmts();
      if (!agentIdentity) return { status: 401, body: { error: 'missing or invalid token' } };
      if (!messageId) return { status: 400, body: { error: 'message_id is required' } };
      const msg = stmts.bridgeGetById.get(messageId);
      if (!msg) return { status: 404, body: { error: 'message not found' } };
      if (msg.to_agent !== agentIdentity) return { status: 403, body: { error: 'can only acknowledge messages addressed to you' } };
      stmts.bridgeAck.run(messageId, agentIdentity);
      return {
        status: 200,
        body: {
          message_id: messageId,
          acknowledged_at: new Date().toISOString(),
          ...nextStepHint('Message acknowledged.'),
        },
      };
    },
  };
}
