/**
 * README rendering for task + phase folders. Pure functions — the
 * lifecycle module chooses when to call these + where to write the
 * resulting string.
 *
 * Render includes a YAML-style frontmatter block so folders.js can
 * reverse-lookup a directory by task_id even if the folder name is the
 * human-readable "Task 42 - ..." variant.
 */
import path from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { nowIso, toIso } from '@cortex/sdk/http';

function ensureDir(d) {
  mkdirSync(d, { recursive: true });
}

/**
 * Atomic-ish file write: creates parent dirs first, then writes. Any
 * failure bubbles to the caller — `lifecycle.js` wraps the call in a
 * swallow() so a read-only filesystem never blocks a state transition.
 */
export function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, content, 'utf8');
}

function formatTimestamp(value) {
  if (!value) return nowIso();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    // progress_reports.created_at is a datetime string; tasks timestamps
    // are either datetime strings or unix seconds. Numeric-coerce the
    // common case (unix seconds → ms) and fall back to Date parsing.
    return toIso(numeric * 1000) ?? String(value);
  }
  return toIso(value) ?? String(value);
}

/**
 * Resolve a task's `section` from whatever shape the caller passed. Accepts:
 *   - a top-level `task.section` (callers that already projected it out)
 *   - `task.metadata` as a parsed object   ({ section: '...' })
 *   - `task.metadata` as a JSON string      ('{"section":"..."}')
 * Returns the section string, or null if absent / unparseable. Never throws —
 * README writes are best-effort and must not block a state transition.
 */
function resolveSection(task) {
  if (!task) return null;
  if (typeof task.section === 'string' && task.section) return task.section;
  const raw = task.metadata;
  if (!raw) return null;
  let meta = raw;
  if (typeof raw === 'string') {
    try { meta = JSON.parse(raw); } catch (err) { void err; return null; }
  }
  if (meta && typeof meta === 'object' && typeof meta.section === 'string' && meta.section) {
    return meta.section;
  }
  return null;
}

/**
 * Render the Markdown body for a task folder's README. `sections` lets
 * the caller override individual panels (progress, journal, review);
 * anything absent falls back to a "no entries yet" placeholder so the
 * file is still parseable.
 */
export function renderTaskReadme(task, sections = {}) {
  const progressLines = (sections.progress || []).flatMap((entry) => {
    const lines = [
      `### ${formatTimestamp(entry.timestamp || entry.created_at)} — ${entry.status || entry.stage || 'progress'}`,
      entry.summary || entry.message || '',
    ];
    if (Array.isArray(entry.files_changed) && entry.files_changed.length > 0) {
      lines.push('', 'Files changed:');
      for (const f of entry.files_changed) lines.push(`- ${f}`);
    }
    lines.push('');
    return lines;
  });

  const journalLines = (sections.journal || []).flatMap((entry) => [
    `### ${formatTimestamp(entry.created_at)} — ${entry.entry_type}`,
    entry.summary || '',
    `Author: ${entry.author || 'unknown'}`,
    '',
  ]);

  const review = sections.review || {};
  const assignedLine = task.assigned_to || task.assigned_agent || 'unassigned';
  const createdLine = formatTimestamp(task.created_at);
  // section is carried in the metadata JSON blob, not a dedicated column.
  // renderTaskReadme receives the raw DB row, so task.metadata is a string;
  // parse defensively (never throw — this file's writes are best-effort) and
  // accept an already-parsed object or a direct task.section for callers that
  // pre-normalise. Emit the front-matter line only when a section is present
  // so the outage-fallback contract (front-matter carries section:) is honoured
  // without polluting sectionless tasks.
  const section = resolveSection(task);

  return [
    '---',
    `task_id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `assigned: ${assignedLine}`,
    ...(section ? [`section: ${section}`] : []),
    '---',
    '',
    `# ${task.title}`, '',
    `## Status: ${task.status}`,
    `## Assigned: ${assignedLine}`,
    `## Created: ${createdLine}`,
    `## Phase: ${task.phase_number || task.phase_id || 1}`,
    `## Project: ${sections.project_name || task.project_id || 'unknown'}`,
    '',
    '## Description', task.description || '',
    '',
    '## Journal',
    ...(journalLines.length ? journalLines : ['No journal entries yet.', '']),
    '## Progress',
    ...(progressLines.length ? progressLines : ['No progress recorded yet.', '']),
    '## Submission',
    sections.submission || task.result || 'No submission yet.',
    '',
    '## Review',
    `Reviewer: ${review.reviewer || 'unassigned'}`,
    `Verdict: ${review.verdict || task.status || 'pending'}`,
    `Feedback: ${review.feedback || 'None'}`,
    '',
  ].join('\n');
}

/**
 * Render a phase-level summary README. Lists every task with a checkbox
 * (approved = checked) and flags any orphaned rows so a reviewer can
 * prioritise adoption.
 */
export function renderPhaseReadme(project, phaseNumber, tasks) {
  const approvedCount = tasks.filter((t) => t.status === 'approved').length;
  const orphanedCount = tasks.filter((t) => t.status === 'orphaned').length;
  const hasStarted = tasks.some((t) => t.status !== 'pending');
  const allApproved = tasks.length > 0 && approvedCount === tasks.length;
  const statusLabel = allApproved
    ? 'complete'
    : hasStarted ? 'in_progress' : 'not started';

  const taskLines = tasks.length
    ? tasks.map((task) => {
        const checked = task.status === 'approved' ? 'x' : ' ';
        const badge = task.status === 'orphaned' ? ' [ORPHANED]' : '';
        const owner = task.assigned_to || task.assigned_agent;
        const agent = owner && owner !== 'unassigned' ? `, ${owner}` : '';
        return `- [${checked}] ${task.title || task.id}${badge}${agent}`;
      })
    : ['- (no tasks yet)'];

  return [
    `# Phase ${phaseNumber}`, '',
    `## Status: ${statusLabel}`,
    `## Tasks: ${approvedCount}/${tasks.length} complete`,
    orphanedCount > 0 ? `## Orphans: ${orphanedCount} awaiting adoption` : '',
    '', '## Summary',
    `Phase ${phaseNumber} tasks for ${project?.name || project?.id || 'unknown'}.`,
    '', '## Tasks',
    ...taskLines,
    '',
  ].filter((line, idx, arr) => {
    // Collapse consecutive empty lines for a tidier render; keep the
    // trailing blank line.
    if (line !== '') return true;
    return !(idx > 0 && arr[idx - 1] === '');
  }).join('\n');
}
