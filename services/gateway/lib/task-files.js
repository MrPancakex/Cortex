import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
const CORTEX_HOME = process.env.CORTEX_HOME || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const WORKSPACE_ROOT = process.env.CORTEX_PROJECTS_DIR || path.join(CORTEX_HOME, 'projects');

function resolveProjectsRoot() {
  if (process.env.CORTEX_HUB_DIR) return path.join(process.env.CORTEX_HUB_DIR, 'projects');
  if (process.env.CORTEX_DATA_DIR) return path.join(process.env.CORTEX_DATA_DIR, 'projects');
  return WORKSPACE_ROOT;
}

export function resolveWorkspaceRoot() {
  return resolveProjectsRoot();
}

export function slugify(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unnamed';
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

function isDir(dir) {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function safeRead(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function writeText(filePath, content) {
  ensureDir(path.dirname(filePath));
  writeFileSync(filePath, content, 'utf8');
}

function formatTimestamp(value) {
  if (!value) return new Date().toISOString();
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return new Date(numeric * 1000).toISOString();
  return new Date(value).toISOString();
}

function taskDirectoryName(index) {
  return `task-${String(index).padStart(2, '0')}`;
}

function humanTaskFolderName(n, title) {
  const safe = String(title || 'untitled')
    .replace(/[<>:"/\\|?*]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return `Task ${n} - ${safe}`;
}

function countTaskFoldersInPhase(phaseDir) {
  if (!isDir(phaseDir)) return 0;
  let count = 0;
  for (const entry of readdirSync(phaseDir)) {
    const entryPath = path.join(phaseDir, entry);
    if (!isDir(entryPath)) continue;
    if (entry.startsWith('Task ')) count++;
    // Also count legacy UUID-named folders
    else if (entry.match(/^[0-9a-f]{8}-/)) count++;
  }
  return count;
}

export function findTaskFolderByUuid(phaseDir, taskId) {
  if (!isDir(phaseDir)) return null;
  // Check legacy UUID folder names first
  const plainUuid = path.join(phaseDir, taskId);
  if (isDir(plainUuid)) return plainUuid;
  const finishedUuid = path.join(phaseDir, `${taskId} (finished)`);
  if (isDir(finishedUuid)) return finishedUuid;
  // Scan human-readable folders by checking README frontmatter for task_id
  for (const entry of readdirSync(phaseDir)) {
    const dirPath = path.join(phaseDir, entry);
    if (!isDir(dirPath)) continue;
    const readmePath = path.join(dirPath, 'README.md');
    if (!existsSync(readmePath)) continue;
    const meta = parseTaskFrontmatter(safeRead(readmePath));
    if (meta.task_id === taskId) return dirPath;
  }
  return null;
}

function getProjectDir(project) {
  return path.join(resolveProjectsRoot(), slugify(project?.name || project?.id));
}

function getPhaseDir(project, phaseNumber) {
  return path.join(getProjectDir(project), 'tasks', `phase-${phaseNumber}`);
}

function parseTaskFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return {};
  const meta = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx == -1) continue;
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return meta;
}

function renderTaskReadme(task, sections = {}) {
  const progressLines = (sections.progress || []).flatMap((entry) => {
    const lines = [`### ${entry.timestamp} — ${entry.status}`, entry.summary || ''];
    if (entry.files_changed?.length) {
      lines.push('', 'Files changed:');
      for (const file of entry.files_changed) lines.push(`- ${file}`);
    }
    lines.push('');
    return lines;
  });

  const review = sections.review || {};
  return [
    '---',
    `task_id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `assigned: ${task.assigned_agent || 'unassigned'}`,
    '---',
    '',
    `# ${task.title}`,
    '',
    `## Status: ${task.status}`,
    `## Assigned: ${task.assigned_agent || 'unassigned'}`,
    `## Source: ${task.source || 'agent'}`,
    `## Created: ${formatTimestamp(task.created_at)}`,
    `## Phase: ${task.phase_number || 1}`,
    `## Project: ${sections.project_name || task.project_id || 'unknown'}`,
    '',
    '## Description',
    task.description || '',
    '',
    '## Progress',
    ...(progressLines.length ? progressLines : ['No progress recorded yet.', '']),
    '## Submission',
    sections.submission || task.result_summary || 'No submission yet.',
    '',
    '## Review',
    `Reviewer: ${review.reviewer || task.reviewer_agent || 'unassigned'}`,
    `Verdict: ${review.verdict || task.status || 'pending'}`,
    `Feedback: ${review.feedback || 'None'}`,
    '',
  ].join('\n');
}

function renderPhaseReadme(project, phaseNumber, tasks) {
  const approvedCount = tasks.filter((t) => t.status === 'approved').length;
  const hasStarted = tasks.some((t) => t.status !== 'pending');
  const allApproved = tasks.length > 0 && approvedCount === tasks.length;
  const status = allApproved ? 'complete' : hasStarted ? 'in_progress' : 'not started';
  return [
    `# Phase ${phaseNumber}`,
    '',
    `## Status: ${status}`,
    `## Tasks: ${approvedCount}/${tasks.length} complete`,
    '',
    '## Summary',
    `Phase ${phaseNumber} tasks for ${project.name}.`,
    '',
    '## Tasks',
    ...(tasks.length
      ? tasks.map((task) => {
          const checked = task.status === 'approved' ? 'x' : ' ';
          const agent = task.assigned_agent && task.assigned_agent !== 'unassigned' ? `, ${task.assigned_agent}` : '';
          return `- [${checked}] ${task.title} (${task.status}${agent}) [${task.id}]`;
        })
      : ['(none yet)']),
    '',
    '## Notes',
    '',
    '',
  ].join('\n');
}

function findTaskReadme(project, taskId) {
  const root = resolveProjectsRoot();
  const projectDir = findDir(root, project.slug || slugify(project.name));
  if (!projectDir) return null;
  const tasksDir = path.join(projectDir, 'tasks');
  if (!isDir(tasksDir)) return null;
  for (const phaseName of readdirSync(tasksDir)) {
    const phaseDir = path.join(tasksDir, phaseName);
    if (!isDir(phaseDir)) continue;
    const taskDir = findTaskFolderByUuid(phaseDir, taskId);
    if (taskDir) {
      const readmePath = path.join(taskDir, 'README.md');
      return { readmePath, phaseDir };
    }
  }
  return null;
}

function listPhaseTasks(phaseDir) {
  const tasks = [];
  if (!isDir(phaseDir)) return tasks;
  for (const taskDirName of readdirSync(phaseDir)) {
    const dirPath = path.join(phaseDir, taskDirName);
    if (!isDir(dirPath)) continue;
    const readmePath = path.join(dirPath, 'README.md');
    if (!existsSync(readmePath)) continue;
    const meta = parseTaskFrontmatter(safeRead(readmePath));
    // UUID comes from README frontmatter; folder name is for humans
    const taskUuid = meta.task_id || taskDirName.replace(/ \(finished\)$/, '');
    tasks.push({
      id: taskUuid,
      title: meta.title || taskDirName,
      status: meta.status || 'pending',
      assigned_agent: meta.assigned || 'unassigned',
    });
  }
  return tasks;
}

function updatePhaseReadme(project, phaseDir, stmts) {
  const phaseName = path.basename(phaseDir).replace(/ \(finished\)$/, '');
  const phaseNumber = Number(phaseName.replace('phase-', '')) || 1;
  // Use DB as source of truth for task status, fall back to filesystem scan
  let tasks;
  if (stmts && project.id) {
    tasks = stmts.listTasksByPhase.all(project.id, phaseNumber).map((row) => ({
      id: row.id,
      title: row.title,
      status: row.status,
      assigned_agent: row.assigned_agent || 'unassigned',
    }));
  } else {
    tasks = listPhaseTasks(phaseDir);
  }
  writeText(path.join(phaseDir, 'PHASE-README.md'), renderPhaseReadme(project, phaseNumber, tasks));
}

export function writePhaseReadme(projectSlug, phaseNumber, description) {
  const root = resolveProjectsRoot();
  const phaseDir = path.join(root, projectSlug, 'tasks', `phase-${phaseNumber}`);
  ensureDir(phaseDir);
  const content = [
    `# Phase ${phaseNumber}`,
    '',
    `## Status: not started`,
    `## Tasks: 0/0 complete`,
    '',
    '## Summary',
    description || `Phase ${phaseNumber} tasks.`,
    '',
    '## Tasks',
    '(none yet)',
    '',
    '## Notes',
    '',
    '',
  ].join('\n');
  writeText(path.join(phaseDir, 'PHASE-README.md'), content);
  return phaseDir;
}

// --- Folder rename helpers for (finished) markers ---

function findDir(basePath, name) {
  const plain = path.join(basePath, name);
  if (isDir(plain)) return plain;
  const finished = path.join(basePath, `${name} (finished)`);
  if (isDir(finished)) return finished;
  return null;
}

function findTaskDir(projectSlug, phaseNumber, taskId) {
  const root = resolveProjectsRoot();
  const phaseName = `phase-${phaseNumber}`;
  const projectDir = findDir(root, projectSlug);
  if (!projectDir) return null;
  const tasksDir = path.join(projectDir, 'tasks');
  const phaseDir = findDir(tasksDir, phaseName);
  if (!phaseDir) return null;
  return findTaskFolderByUuid(phaseDir, taskId);
}

function safeRename(from, to) {
  try {
    if (existsSync(from) && !existsSync(to)) {
      renameSync(from, to);
      return true;
    }
  } catch (err) {
    console.error(`[task-files] rename failed ${from} -> ${to}: ${err.message}`);
  }
  return false;
}

export function renameOnApprove({ stmts, taskId }) {
  const task = stmts.getCortexTask.get(taskId);
  if (!task || !task.project_id) return null;
  const project = stmts.getProject.get(task.project_id);
  if (!project || !project.slug) return null;

  const root = resolveProjectsRoot();
  const projectSlug = project.slug;
  const phaseNumber = task.phase_number || 1;

  // 1. Rename task folder to (finished)
  const projectDir = findDir(root, projectSlug);
  if (!projectDir) return null;
  const tasksDir = path.join(projectDir, 'tasks');
  const phaseDir = findDir(tasksDir, `phase-${phaseNumber}`);
  if (!phaseDir) return null;

  const taskDir = findTaskFolderByUuid(phaseDir, taskId);
  if (taskDir && !taskDir.endsWith('(finished)')) {
    const taskFinished = taskDir + ' (finished)';
    safeRename(taskDir, taskFinished);
  }

  // 2. Check if all tasks in phase are approved
  const approvedCount = stmts.countApprovedInPhase.get(task.project_id, phaseNumber)?.count || 0;
  const totalCount = stmts.countTasksInPhase.get(task.project_id, phaseNumber)?.count || 0;
  if (totalCount > 0 && approvedCount === totalCount) {
    const plainPhaseDir = path.join(tasksDir, `phase-${phaseNumber}`);
    const finishedPhaseDir = path.join(tasksDir, `phase-${phaseNumber} (finished)`);
    safeRename(plainPhaseDir, finishedPhaseDir);

    // 3. Check if all phases are finished
    let allPhasesComplete = true;
    for (let i = 1; i <= (project.phase_count || 1); i++) {
      const pApproved = stmts.countApprovedInPhase.get(task.project_id, i)?.count || 0;
      const pTotal = stmts.countTasksInPhase.get(task.project_id, i)?.count || 0;
      if (pTotal === 0 || pApproved !== pTotal) {
        allPhasesComplete = false;
        break;
      }
    }
    if (allPhasesComplete) {
      const plainProjectDir = path.join(root, projectSlug);
      const finishedProjectDir = path.join(root, `${projectSlug} (finished)`);
      safeRename(plainProjectDir, finishedProjectDir);
      // Update project status in DB
      try { stmts.updateProjectStatus.run('finished', task.project_id); } catch (err) {
        console.error(`[task-files] updateProjectStatus failed: ${err.message}`);
      }
    }
  }

  return { task_id: taskId, phase: phaseNumber, project: projectSlug };
}

export function renameOnRejectOrReopen({ stmts, taskId }) {
  const task = stmts.getCortexTask.get(taskId);
  if (!task || !task.project_id) return null;
  const project = stmts.getProject.get(task.project_id);
  if (!project || !project.slug) return null;

  const root = resolveProjectsRoot();
  const projectSlug = project.slug;
  const phaseNumber = task.phase_number || 1;

  // Remove (finished) from project if present
  const finishedProjectDir = path.join(root, `${projectSlug} (finished)`);
  const plainProjectDir = path.join(root, projectSlug);
  safeRename(finishedProjectDir, plainProjectDir);

  // Remove (finished) from phase if present
  const projectDir = findDir(root, projectSlug);
  if (!projectDir) return null;
  const tasksDir = path.join(projectDir, 'tasks');
  const finishedPhaseDir = path.join(tasksDir, `phase-${phaseNumber} (finished)`);
  const plainPhaseDir = path.join(tasksDir, `phase-${phaseNumber}`);
  safeRename(finishedPhaseDir, plainPhaseDir);

  // Remove (finished) from task if present
  const phaseDir = findDir(tasksDir, `phase-${phaseNumber}`);
  if (!phaseDir) return null;
  const taskDir = findTaskFolderByUuid(phaseDir, taskId);
  if (taskDir && taskDir.endsWith('(finished)')) {
    const plainTaskDir = taskDir.replace(/ \(finished\)$/, '');
    safeRename(taskDir, plainTaskDir);
  }

  return { task_id: taskId, phase: phaseNumber, project: projectSlug };
}

export function syncTaskFileLifecycle({ stmts, taskId, phase = 1 } = {}) {
  const task = stmts.getCortexTask.get(taskId);
  if (!task || !task.project_id) return null;

  const project = stmts.getProject.get(task.project_id);
  if (!project) return null;

  const progressRows = stmts.progressByTaskAsc.all(taskId).map((row) => ({
    timestamp: formatTimestamp(row.timestamp),
    status: row.status,
    summary: row.summary,
    files_changed: JSON.parse(row.files_changed || '[]'),
  }));
  const rejections = stmts.getTaskRejections.all(taskId);
  const review = {
    reviewer: task.reviewer_agent || null,
    verdict: task.status === 'approved' ? 'approved' : task.status === 'rejected' ? 'rejected' : task.status,
    feedback: task.review_feedback || rejections.at(-1)?.reason || null,
  };

  const effectivePhase = task.phase_number || phase;

  let located = findTaskReadme(project, taskId);
  if (!located) {
    // Find the phase dir (could be plain or finished)
    const root = resolveProjectsRoot();
    const projectDir = findDir(root, project.slug || slugify(project.name));
    const tasksDir = projectDir ? path.join(projectDir, 'tasks') : path.join(getProjectDir(project), 'tasks');
    const phaseDir = findDir(tasksDir, `phase-${effectivePhase}`) || getPhaseDir(project, effectivePhase);
    ensureDir(phaseDir);
    // Human-readable folder: "Task {n} - {title}"
    const n = countTaskFoldersInPhase(phaseDir) + 1;
    const folderName = humanTaskFolderName(n, task.title);
    const taskDir = path.join(phaseDir, folderName);
    ensureDir(taskDir);
    located = { phaseDir, readmePath: path.join(taskDir, 'README.md') };
  }

  writeText(located.readmePath, renderTaskReadme(task, {
    progress: progressRows,
    submission: task.result_summary || null,
    review,
    project_name: project.name,
  }));
  updatePhaseReadme(project, located.phaseDir, stmts);

  return {
    project_dir: getProjectDir(project),
    phase_dir: located.phaseDir,
    readme_path: located.readmePath,
  };
}
