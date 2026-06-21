/**
 * Summary writer — subscribes to `task.submitted` and writes a task-scoped
 * summary.md into the task folder on disk.
 *
 * Slice G implementation. Replaces the Slice D stub with a richer task-scoped
 * builder that reads task.json, the project-level ledger.jsonl (filtered by
 * task_id), and the task-level runs.jsonl to produce a boot-context-ready
 * summary under the 2KB cap.
 *
 * Locked decisions:
 *   G1: Task-scoped only — no agent-side memory mixed in.
 *   G2: Template-only — no LLM call. Sub-2KB cap by construction.
 *   G3: Boot context delivered via .cortex-prompt sidecar prepend (spawn.js).
 *   G4: Auto-resolve summaryPath = <taskDir>/summary.md when absent.
 *
 * Locked decision D2 (preserved): lives inline in the gateway's composer boot.
 * The subscriber is best-effort — any handler error is swallowed.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { subscribe } from '@cortex/sdk/events';
import { swallow } from '@cortex/sdk/errors';
import { writeSummary, readTaskJson } from '../tasks/ledger.js';
import { getTaskStatements } from '../tasks/statements.js';
import {
  getProjectDir,
  getPhaseDir,
  findTaskFolderByUuid,
} from '../tasks/folders.js';
import { inferPhaseNumber } from '../tasks/lifecycle.js';

// -- Folder resolution -------------------------------------------------------

/**
 * Resolve a task's on-disk directory from the DB row.
 *
 * Mirrors the resolution logic in lifecycle.js:syncTaskFileLifecycle but
 * extracted as a standalone injectable so tests can stub it without touching
 * the DB.
 *
 * Returns an absolute path string or null if the folder cannot be found
 * (task missing, project misconfigured, or the folder hasn't been created yet).
 *
 * @param {string} taskId
 * @returns {string|null}
 */
export function resolveTaskDir(taskId) {
  try {
    const stmts = getTaskStatements();
    const task = stmts.getTask.get(taskId);
    if (!task) return null;
    const project = task.project_id ? stmts.getProject.get(task.project_id) : null;
    const phaseNumber = inferPhaseNumber(task);
    const phaseDir = getPhaseDir(project, phaseNumber);
    if (!phaseDir) return null;
    return findTaskFolderByUuid(phaseDir, taskId) ?? null;
  } catch (err) {
    swallow('summary_writer.resolve_task_dir_failed', err);
    return null;
  }
}

// -- Ledger tail helpers (module-local) --------------------------------------

/**
 * Read the last N lines of projectDir/ledger.jsonl filtered to a taskId.
 * Returns an array of parsed event objects (newest last). Empty on any I/O failure.
 *
 * @param {string} projectDir
 * @param {string} taskId
 * @param {number} n
 * @returns {object[]}
 */
export function defaultReadLedgerTail(projectDir, taskId, n = 5) {
  try {
    const filePath = path.join(projectDir, 'ledger.jsonl');
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    const parsed = [];
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.task_id === taskId) parsed.push(obj);
      } catch (_) { /* skip malformed lines */ }
    }
    return parsed.slice(-n);
  } catch (_) {
    return [];
  }
}

/**
 * Read the last line of taskDir/runs.jsonl (the final run entry).
 * Returns a parsed object or null on any I/O/parse failure.
 *
 * @param {string} taskDir
 * @returns {object|null}
 */
export function defaultReadRunsTail(taskDir) {
  try {
    const filePath = path.join(taskDir, 'runs.jsonl');
    const raw = readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim());
    if (lines.length === 0) return null;
    return JSON.parse(lines[lines.length - 1]);
  } catch (_) {
    return null;
  }
}

// -- Pure markdown builder ---------------------------------------------------

/**
 * Build the task-scoped summary.md for a submitted task.
 *
 * Reads task.json, the last 5 filtered ledger events, and the final runs.jsonl
 * entry to produce a boot-context-ready markdown string under the 2KB cap.
 *
 * Injection points (_readTaskJson, _readLedgerTail, _readRunsTail) follow the
 * same pattern as the stub's _resolveTaskDir — passed as named params.
 *
 * @param {{
 *   payload: object,
 *   title: string,
 *   taskDir: string,
 *   projectDir: string,
 *   _readTaskJson?: Function,
 *   _readLedgerTail?: Function,
 *   _readRunsTail?: Function,
 * }} params
 * @returns {string}
 */
export async function buildSummaryMarkdown({
  payload,
  title,
  taskDir,
  projectDir,
  _readTaskJson = readTaskJson,
  _readLedgerTail = defaultReadLedgerTail,
  _readRunsTail = defaultReadRunsTail,
}) {
  const taskData = taskDir ? _readTaskJson(taskDir) : null;
  const taskId = taskData?.id || payload?.task_id || '';
  const resolvedTitle = taskData?.title || title || '(untitled)';
  const submittedAt = taskData?.submitted_at
    ? new Date(taskData.submitted_at).toISOString()
    : (payload?.submitted_at ? new Date(payload.submitted_at).toISOString() : new Date().toISOString());

  let ledgerEvents = (taskId && projectDir)
    ? _readLedgerTail(projectDir, taskId, 5)
    : [];

  const runsEntry = taskDir ? _readRunsTail(taskDir) : null;

  const lastActor = ledgerEvents.length > 0
    ? (ledgerEvents[ledgerEvents.length - 1].actor || '')
    : (taskData?.assigned_to || '');

  const buildMarkdown = (events) => {
    const lines = [
      `# ${resolvedTitle}`,
      '',
      `**task_id:** ${taskId}`,
      `**status:** submitted`,
      `**submitted_at:** ${submittedAt}`,
      `**actor:** ${lastActor}`,
    ];

    if (events.length > 0) {
      lines.push('', '## Recent activity (last N events)');
      for (const ev of events) {
        const snippet = ev.data?.title || ev.data?.summary || '';
        const part = snippet ? ` — ${snippet.slice(0, 80)}` : '';
        lines.push(`- ${ev.ts} ${ev.event_type} ${ev.actor || ''}${part}`);
      }
    }

    if (runsEntry) {
      const exitReason = String(runsEntry.exit_reason || '');
      lines.push(
        '', '## Final run',
        `- run_id: ${runsEntry.run_id || ''}`,
        `- model: ${runsEntry.model || ''} via ${runsEntry.provider || ''}`,
        `- tokens: ${runsEntry.tokens_in || 0}/${runsEntry.tokens_out || 0}`,
        `- cost_usd: ${runsEntry.cost_usd ?? 0}`,
        `- exit_reason: ${exitReason}`,
      );
    }

    lines.push('', '*Auto-generated by gateway summary-writer (Slice G, task-scoped extract).*', '');
    return lines.join('\n');
  };

  let markdown = buildMarkdown(ledgerEvents);

  // Truncation: drop oldest ledger events first until under 2000 bytes
  while (Buffer.byteLength(markdown, 'utf8') > 2000 && ledgerEvents.length > 0) {
    ledgerEvents = ledgerEvents.slice(1);
    markdown = buildMarkdown(ledgerEvents);
  }

  // Fallback: truncate exit_reason if still over 2000 bytes
  if (runsEntry && Buffer.byteLength(markdown, 'utf8') > 2000) {
    const truncatedEntry = {
      ...runsEntry,
      exit_reason: String(runsEntry.exit_reason || '').slice(0, 100),
    };
    // rebuild with truncated run
    const buildWithTruncated = (events) => {
      const lines = [
        `# ${resolvedTitle}`,
        '',
        `**task_id:** ${taskId}`,
        `**status:** submitted`,
        `**submitted_at:** ${submittedAt}`,
        `**actor:** ${lastActor}`,
      ];
      if (events.length > 0) {
        lines.push('', '## Recent activity (last N events)');
        for (const ev of events) {
          const snippet = ev.data?.title || ev.data?.summary || '';
          const part = snippet ? ` — ${snippet.slice(0, 80)}` : '';
          lines.push(`- ${ev.ts} ${ev.event_type} ${ev.actor || ''}${part}`);
        }
      }
      const exitReason = String(truncatedEntry.exit_reason || '');
      lines.push(
        '', '## Final run',
        `- run_id: ${truncatedEntry.run_id || ''}`,
        `- model: ${truncatedEntry.model || ''} via ${truncatedEntry.provider || ''}`,
        `- tokens: ${truncatedEntry.tokens_in || 0}/${truncatedEntry.tokens_out || 0}`,
        `- cost_usd: ${truncatedEntry.cost_usd ?? 0}`,
        `- exit_reason: ${exitReason}`,
      );
      lines.push('', '*Auto-generated by gateway summary-writer (Slice G, task-scoped extract).*', '');
      return lines.join('\n');
    };
    markdown = buildWithTruncated(ledgerEvents);
  }

  // Final guard: assert under 2048 bytes
  if (Buffer.byteLength(markdown, 'utf8') >= 2048) {
    // Hard trim to fit — strip from end before footer
    const footerLine = '\n*Auto-generated by gateway summary-writer (Slice G, task-scoped extract).*\n';
    const body = markdown.slice(0, markdown.lastIndexOf(footerLine));
    const maxBody = 2048 - Buffer.byteLength(footerLine, 'utf8') - 1;
    markdown = body.slice(0, maxBody) + footerLine;
  }

  return markdown;
}

// -- Core handler (pure + injectable) ----------------------------------------

/**
 * Resolve folder, build markdown, and write summary.md.
 * Exported for direct unit testing.
 *
 * @param {object} eventEnvelope  Full bus envelope ({ task_id, payload, ... })
 * @param {{
 *   _writeSummary?: Function,
 *   _resolveTaskDir?: Function,
 *   _readTaskJson?: Function,
 *   _readLedgerTail?: Function,
 *   _readRunsTail?: Function,
 * }} deps
 */
export async function buildAndWriteSummary(eventEnvelope, {
  _writeSummary = writeSummary,
  _resolveTaskDir = resolveTaskDir,
  _readTaskJson = readTaskJson,
  _readLedgerTail = defaultReadLedgerTail,
  _readRunsTail = defaultReadRunsTail,
} = {}) {
  const taskId = eventEnvelope?.task_id;
  if (!taskId) {
    swallow('summary_writer.missing_task_id', new Error('event envelope has no task_id'));
    return;
  }

  const payload = eventEnvelope?.payload || {};

  // Resolve title from DB (task.submitted event deliberately omits title).
  let title = '';
  try {
    const stmts = getTaskStatements();
    const task = stmts.getTask.get(taskId);
    title = task?.title || '';
  } catch (err) {
    swallow('summary_writer.title_fetch_failed', err);
  }

  const taskDir = _resolveTaskDir(taskId);
  if (!taskDir) {
    // Folder not yet on disk (best-effort; reconciler can backfill).
    swallow('summary_writer.task_dir_not_found', new Error(`no dir for task ${taskId}`));
    return;
  }

  // Resolve projectDir for ledger.jsonl reads.
  let projectDir = null;
  try {
    const stmts = getTaskStatements();
    const task = stmts.getTask.get(taskId);
    if (task?.project_id) {
      const project = stmts.getProject.get(task.project_id);
      projectDir = project ? getProjectDir(project) : null;
    }
  } catch (err) {
    swallow('summary_writer.project_dir_failed', err);
  }

  const markdown = await buildSummaryMarkdown({
    payload,
    title,
    taskDir,
    projectDir,
    _readTaskJson,
    _readLedgerTail,
    _readRunsTail,
  });
  _writeSummary(taskDir, markdown);
}

// -- Subscriber entry point --------------------------------------------------

/**
 * Wire the subscriber. Returns `{stop}` so composer.js can tear it down
 * on shutdown, matching the shape of startReaper / startSubagentReaper.
 *
 * @param {{
 *   _subscribe?: Function,
 *   _writeSummary?: Function,
 *   _resolveTaskDir?: Function,
 *   _readTaskJson?: Function,
 *   _readLedgerTail?: Function,
 *   _readRunsTail?: Function,
 * }} [deps]
 * @returns {{ stop: () => void }}
 */
export function startSummaryWriter({
  _subscribe = subscribe,
  _writeSummary = writeSummary,
  _resolveTaskDir = resolveTaskDir,
  _readTaskJson = readTaskJson,
  _readLedgerTail = defaultReadLedgerTail,
  _readRunsTail = defaultReadRunsTail,
} = {}) {
  const unsubscribe = _subscribe('task.submitted', async (event) => {
    try {
      await buildAndWriteSummary(event, {
        _writeSummary,
        _resolveTaskDir,
        _readTaskJson,
        _readLedgerTail,
        _readRunsTail,
      });
    } catch (err) {
      // Best-effort: never block the task.submitted originating path.
      swallow('summary_writer.handler_failed', err);
    }
  });

  return {
    stop() {
      try {
        unsubscribe();
      } catch (err) {
        swallow('summary_writer.stop_failed', err);
      }
    },
  };
}
