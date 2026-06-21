/**
 * fold-engine tests — Phase-2 fold/rebuild engine acceptance (spec §7).
 *
 *   §7.1 READ-ONLY proven (no DB writes, no folder writes)
 *   §7.2 GOLDEN — fixture built via REAL transitions folds to MATCH on every
 *        policy column class
 *   §7.3 MUTATION — (a) status flip, (b) wrong rejection_count, (c) deleted
 *        event line, (d) unknown event_type — exact drift / loud failure,
 *        never false-MATCH
 *   §7.4 the 3 corrupt shapes land in exempt (explicit allowlist, A4)
 *   §7.5 cancel/reopen assigned_to=null rule
 *   A2   equal-ts stable file order
 *   A5   lease policy (active lease = gate-blocking assertion; transient
 *        fields never drift)
 *   §6   CLI gate line (exact format) + exit codes
 *
 * Fresh tmpdir DB + tmpdir projects root per test (the 1b/t120 pattern).
 * NEVER touches the live DB.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { getDb, runMigrations, resetDbForTests } from '@cortex/sdk/db';
import {
  getTaskStatements,
  resetTaskStatementsForTests,
} from '@cortex/gateway/tasks';
import {
  createTask,
  claimTask,
  reportProgress,
  submitTask,
  requestVerification,
  approveTask,
  rejectTask,
  cancelTask,
  releaseTask,
  reassignTask,
  reopenTask,
} from '../transitions.js';
import { orphanTask, claimOrphan } from '../orphan.js';
import { getPhaseDir, findTaskFolderByUuid } from '../folders.js';
import {
  foldTask,
  foldAll,
  diffRow,
  normTs,
  FoldHardError,
  EVENT_VOCABULARY,
  DEFAULT_EXEMPT_CORRUPT,
} from '../fold-engine.js';

// ---------------------------------------------------------------------------
// Infrastructure (mirrors transitions.events-jsonl-fsversion.test.js)
// ---------------------------------------------------------------------------

let ROOT;
let PROJECTS_DIR;
let db;
let stmts;

beforeEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();

  const rand = randomUUID().slice(0, 8);
  ROOT = path.join(os.tmpdir(), `cortex-fold-${process.pid}-${rand}`);
  PROJECTS_DIR = path.join(ROOT, 'projects');
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });

  process.env.CORTEX_DB_PATH = path.join(ROOT, 'test.db');
  process.env.CORTEX_PROJECTS_DIR = PROJECTS_DIR;

  db = getDb({ path: process.env.CORTEX_DB_PATH });
  runMigrations();
  stmts = getTaskStatements();
});

afterEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();
  delete process.env.CORTEX_DB_PATH;
  delete process.env.CORTEX_PROJECTS_DIR;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

function makeProject() {
  const id = randomUUID();
  const slug = `proj-${id.slice(0, 8)}`;
  const rootPath = path.join(PROJECTS_DIR, slug);
  fs.mkdirSync(path.join(rootPath, 'tasks'), { recursive: true });
  db.prepare(
    `INSERT INTO projects (id, name, root_path, metadata) VALUES (?, ?, ?, '{}')`,
  ).run(id, slug, rootPath);
  const phaseId = randomUUID();
  stmts.createPhase.run(phaseId, id, 'Phase 1', 0);
  return { id, slug, rootPath, phaseId };
}

function makeAgent(id = `agent-${randomUUID().slice(0, 8)}`) {
  db.prepare(
    `INSERT INTO agents (id, name, kind, status) VALUES (?, ?, 'generic', 'online')`,
  ).run(id, id);
  return id;
}

function actor(id) { return { id }; }

function createRealTask({ projectId, title = 'Fold task' }) {
  const res = createTask({
    body: { project_id: projectId, title, phase_number: 1, priority: 'high' },
    actor: actor('system'),
    isAdmin: true,
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

function taskDirFor(projectId, taskId) {
  const project = stmts.getProject.get(projectId);
  const phaseDir = getPhaseDir(project, 1);
  return findTaskFolderByUuid(phaseDir, taskId);
}

function insertJournalQuad(taskId, agentId) {
  for (const type of ['planning', 'context', 'decision', 'test']) {
    stmts.insertTaskJournal.run(randomUUID(), taskId, type, `${type} s`, '[]', '{}', agentId);
  }
}

/** Shape a live DB row like the P1 oracle dump (parsed metadata/tags +
 *  cutover_included). */
function oracleRow(taskId, overrides = {}) {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  expect(row).toBeTruthy();
  return {
    ...row,
    metadata: JSON.parse(row.metadata || '{}'),
    tags: JSON.parse(row.tags || '[]'),
    cutover_included: true,
    ...overrides,
  };
}

/**
 * The dualWrite event ts is stamped a few ms BEFORE the SQL datetime('now')
 * runs; a lifecycle that straddles a second boundary could legitimately
 * differ by 1s at second precision. Align the clock to the early part of a
 * second before each lifecycle so the fixture is deterministic.
 */
async function alignClock(budgetMs = 600) {
  const within = Date.now() % 1000;
  if (within > budgetMs) await Bun.sleep(1000 - within + 20);
}

/** Drive a task to `review` via the real handlers. */
function driveToReview({ projectId, ownerId, reviewerId, title }) {
  const taskId = createRealTask({ projectId, title });
  expect(claimTask({ taskId, actor: actor(ownerId) }).status).toBe(200);
  expect(reportProgress({
    taskId, actor: actor(ownerId),
    body: { status: 'in_progress', summary: 'work', files_changed: ['src/a.js'] },
  }).status).toBe(200);
  insertJournalQuad(taskId, ownerId);
  expect(submitTask({
    taskId, actor: actor(ownerId), body: { summary: 'done', files_changed: ['src/a.js'] },
  }).status).toBe(200);
  expect(requestVerification({
    taskId, actor: actor(ownerId), body: { reviewer: reviewerId },
  }).status).toBe(200);
  expect(stmts.getTask.get(taskId).status).toBe('review');
  return taskId;
}

/**
 * GOLDEN fixture (§7.2): one project, six REAL lifecycles covering every
 * column class:
 *   T1 claim→progress→submit→review→approve   (happy path)
 *   T2 two reject rounds then reopen          (cumulative rejection_count,
 *                                              reopen nulling)
 *   T3 claim→cancel                           (cancel nulling)
 *   T4 claim→progress→orphan→orphan-claim    (orphan path, new owner)
 *   T5 claim→release                          (release nulling)
 *   T6 claim→reassign                         (reassign → new pending owner)
 */
async function buildGoldenFixture() {
  const project = makeProject();
  const owner = makeAgent('owner-a');
  const adopter = makeAgent('adopter-b');
  const reviewer = makeAgent('reviewer-z');

  await alignClock();
  const t1 = driveToReview({ projectId: project.id, ownerId: owner, reviewerId: reviewer, title: 'T1 happy' });
  expect(approveTask({ taskId: t1, actor: actor(reviewer) }).status).toBe(200);

  await alignClock();
  const t2 = driveToReview({ projectId: project.id, ownerId: owner, reviewerId: reviewer, title: 'T2 reject-reopen' });
  expect(rejectTask({ taskId: t2, actor: actor(reviewer), body: { reason: 'round 1' } }).status).toBe(200);
  await alignClock();
  expect(reportProgress({
    taskId: t2, actor: actor(owner),
    body: { status: 'in_progress', summary: 'rework', files_changed: ['src/a.js'] },
  }).status).toBe(200);
  expect(submitTask({
    taskId: t2, actor: actor(owner), body: { summary: 'rework done', files_changed: ['src/a.js'] },
  }).status).toBe(200);
  expect(requestVerification({
    taskId: t2, actor: actor(owner), body: { reviewer },
  }).status).toBe(200);
  expect(rejectTask({ taskId: t2, actor: actor(reviewer), body: { reason: 'round 2' } }).status).toBe(200);
  expect(reopenTask({ taskId: t2, actor: actor(owner), body: { reason: 'fresh start' } }).status).toBe(200);

  await alignClock();
  const t3 = createRealTask({ projectId: project.id, title: 'T3 cancel' });
  expect(claimTask({ taskId: t3, actor: actor(owner) }).status).toBe(200);
  expect(cancelTask({ taskId: t3, actor: actor(owner), body: { reason: 'obsolete' } }).status).toBe(200);

  await alignClock();
  const t4 = createRealTask({ projectId: project.id, title: 'T4 orphan-claim' });
  expect(claimTask({ taskId: t4, actor: actor(owner) }).status).toBe(200);
  expect(reportProgress({
    taskId: t4, actor: actor(owner),
    body: { status: 'in_progress', summary: 'work', files_changed: ['src/a.js'] },
  }).status).toBe(200);
  expect(orphanTask({ taskId: t4, reason: 'agent_stale' }).status).toBe(200);
  expect(claimOrphan({ taskId: t4, body: {}, actor: actor(adopter) }).status).toBe(200);

  await alignClock();
  const t5 = createRealTask({ projectId: project.id, title: 'T5 release' });
  expect(claimTask({ taskId: t5, actor: actor(owner) }).status).toBe(200);
  expect(releaseTask({ taskId: t5, actor: actor(owner), body: { reason: 'busy' } }).status).toBe(200);

  await alignClock();
  const t6 = createRealTask({ projectId: project.id, title: 'T6 reassign' });
  expect(claimTask({ taskId: t6, actor: actor(owner) }).status).toBe(200);
  expect(reassignTask({
    taskId: t6, actor: actor('admin'), isAdmin: true, body: { new_agent: adopter },
  }).status).toBe(200);

  const ids = [t1, t2, t3, t4, t5, t6];
  return { project, owner, adopter, reviewer, ids, baseline: ids.map((id) => oracleRow(id)) };
}

/** Handcraft a task folder on disk (no DB) — for corrupt/lease fixtures. */
function handcraftTask({ projectSlug, taskId, projectId, title, events }) {
  const taskDir = path.join(PROJECTS_DIR, projectSlug, 'tasks', 'phase-1', `Task X - ${title}`);
  fs.mkdirSync(taskDir, { recursive: true });
  const taskJson = {
    schema_version: 1,
    id: taskId,
    project_id: projectId,
    phase_id: null,
    phase_number: 1,
    folder_path: null,
    title,
    status: 'pending',
    priority: 'normal',
    assigned_to: null,
    created_by: 'orion-3',
    created_at: '2026-05-03 10:00:00',
    updated_at: '2026-05-03 10:00:00',
    claimed_at: null,
    submitted_at: null,
    approved_at: null,
    deadline: null,
    description: '',
    result: null,
    tags: [],
    section: null,
    rejection_count: 0,
    parent_task_id: null,
    reviewer_agent: null,
    provider: null,
    lease_token: null,
    lease_expires_at: null,
    fs_version: 0,
  };
  fs.writeFileSync(path.join(taskDir, 'task.json'), `${JSON.stringify(taskJson, null, 2)}\n`);
  fs.writeFileSync(
    path.join(taskDir, 'events.jsonl'),
    `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
  );
  return { taskDir, taskJson };
}

function genesisEvent(taskId, projectId, ts = '2026-05-03T10:00:00.000Z', createdBy = 'orion-3') {
  return {
    ts,
    task_id: taskId,
    project_id: projectId,
    actor: createdBy,
    event_type: 'task_created',
    from_status: null,
    to_status: 'pending',
    data: { title: 'x', created_by: createdBy },
  };
}

// -- tree hashing for the read-only proof -----------------------------------

function hashFile(fp) {
  return createHash('sha256').update(fs.readFileSync(fp)).digest('hex');
}

function snapshotTree(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const fp = path.join(dir, name);
      const st = fs.statSync(fp);
      if (st.isDirectory()) {
        out.push([path.relative(root, fp), 'dir', st.mtimeMs]);
        walk(fp);
      } else {
        out.push([path.relative(root, fp), hashFile(fp), st.mtimeMs]);
      }
    }
  };
  walk(root);
  return JSON.stringify(out);
}

// ---------------------------------------------------------------------------
// §7.1 READ-ONLY proof
// ---------------------------------------------------------------------------

test('fold.1 foldAll is READ-ONLY: DB file sha unchanged, tree content+mtime unchanged', async () => {
  const { baseline } = await buildGoldenFixture();

  const dbPath = process.env.CORTEX_DB_PATH;
  const dbShaBefore = hashFile(dbPath);
  const walBefore = fs.existsSync(`${dbPath}-wal`) ? hashFile(`${dbPath}-wal`) : null;
  const treeBefore = snapshotTree(PROJECTS_DIR);

  const report = foldAll(PROJECTS_DIR, baseline);
  expect(report.totals.tasks).toBe(baseline.length);

  expect(hashFile(dbPath)).toBe(dbShaBefore);
  const walAfter = fs.existsSync(`${dbPath}-wal`) ? hashFile(`${dbPath}-wal`) : null;
  expect(walAfter).toBe(walBefore);
  expect(snapshotTree(PROJECTS_DIR)).toBe(treeBefore);
});

// ---------------------------------------------------------------------------
// §7.2 GOLDEN — real lifecycles fold to MATCH on every policy column
// ---------------------------------------------------------------------------

test('fold.2 GOLDEN: six real lifecycles (approve / reject×2+reopen / cancel / orphan-claim / release / reassign) all MATCH', async () => {
  const { ids, baseline, adopter } = await buildGoldenFixture();

  // Sanity on the DB end states the fold must reproduce.
  const t2 = stmts.getTask.get(ids[1]);
  expect(t2.status).toBe('pending');
  expect(t2.assigned_to).toBeNull();
  expect(t2.rejection_count).toBe(2);
  const t4 = stmts.getTask.get(ids[3]);
  expect(t4.status).toBe('in_progress');
  expect(t4.assigned_to).toBe(adopter);

  const report = foldAll(PROJECTS_DIR, baseline);
  expect(report.hard_errors).toEqual([]);
  expect(report.drifts).toEqual([]);
  expect(report.totals).toEqual({
    tasks: 6, match: 6, drift: 0, exempt: 0, out_of_scope: 0, hard_errors: 0,
  });
  expect(report.gate_green).toBe(true);
  expect(report.gate_line).toBe(
    'GATE: tasks=6 match=6 drift=0 exempt=0 out_of_scope=0 hard_errors=0',
  );
  expect(report.matches.map((m) => m.id).sort()).toEqual([...ids].sort());
  expect(report.fs_only).toEqual([]);
});

// ---------------------------------------------------------------------------
// §7.3 MUTATION tests
// ---------------------------------------------------------------------------

test('fold.3 MUTATION (a): a status flip in the baseline is reported as EXACTLY that drift', async () => {
  const { ids, baseline } = await buildGoldenFixture();
  const mutated = baseline.map((r) => (r.id === ids[0] ? { ...r, status: 'cancelled' } : { ...r }));

  const report = foldAll(PROJECTS_DIR, mutated);
  expect(report.totals.hard_errors).toBe(0);
  expect(report.totals.drift).toBe(1);
  expect(report.totals.match).toBe(5);
  expect(report.drifts[0].id).toBe(ids[0]);
  expect(report.drifts[0].fields).toEqual([
    { field: 'status', fold_value: 'approved', baseline_value: 'cancelled' },
  ]);
  expect(report.gate_green).toBe(false);
});

test('fold.4 MUTATION (b): a wrong rejection_count drifts on exactly that field', async () => {
  const { ids, baseline } = await buildGoldenFixture();
  const mutated = baseline.map((r) => (r.id === ids[1] ? { ...r, rejection_count: 7 } : { ...r }));

  const report = foldAll(PROJECTS_DIR, mutated);
  expect(report.totals.drift).toBe(1);
  expect(report.drifts[0].id).toBe(ids[1]);
  expect(report.drifts[0].fields).toEqual([
    { field: 'rejection_count', fold_value: 2, baseline_value: 7 },
  ]);
});

test('fold.5 MUTATION (c): a deleted event line yields drift or hard_error — NEVER a false MATCH', async () => {
  const { ids, baseline, project } = await buildGoldenFixture();

  // (c1) drop the task_approved line from T1 — fold lands in review, drift.
  const t1Dir = taskDirFor(project.id, ids[0]);
  const evPath = path.join(t1Dir, 'events.jsonl');
  const original = fs.readFileSync(evPath, 'utf8');
  const withoutApprove = original
    .split('\n')
    .filter((l) => l.trim() && JSON.parse(l).event_type !== 'task_approved')
    .join('\n');
  fs.writeFileSync(evPath, `${withoutApprove}\n`);

  const report = foldAll(PROJECTS_DIR, baseline);
  expect(report.totals.match).toBe(5);
  expect(report.totals.drift + report.totals.hard_errors).toBeGreaterThanOrEqual(1);
  const d = report.drifts.find((x) => x.id === ids[0]);
  expect(d).toBeTruthy();
  const fields = d.fields.map((f) => f.field);
  expect(fields).toContain('status');
  expect(fields).toContain('approved_at');

  // (c2) drop the genesis line — created_at can no longer fold; drift, not MATCH.
  const withoutGenesis = original
    .split('\n')
    .filter((l) => l.trim() && JSON.parse(l).event_type !== 'task_created')
    .join('\n');
  fs.writeFileSync(evPath, `${withoutGenesis}\n`);
  const report2 = foldAll(PROJECTS_DIR, baseline);
  const d2 = report2.drifts.find((x) => x.id === ids[0]);
  expect(d2).toBeTruthy();
  expect(d2.fields.map((f) => f.field)).toContain('created_at');
});

test('fold.6 MUTATION (d): an unknown event_type is a HARD ERROR — gate-blocking and loud', async () => {
  const { ids, baseline, project } = await buildGoldenFixture();

  const t1Dir = taskDirFor(project.id, ids[0]);
  const evPath = path.join(t1Dir, 'events.jsonl');
  const alien = {
    ts: new Date().toISOString(),
    task_id: ids[0],
    project_id: project.id,
    actor: 'gremlin',
    event_type: 'task_warped',
    from_status: null,
    to_status: null,
    data: {},
  };
  fs.appendFileSync(evPath, `${JSON.stringify(alien)}\n`);

  const report = foldAll(PROJECTS_DIR, baseline);
  expect(report.totals.hard_errors).toBe(1);
  expect(report.hard_errors[0]).toMatchObject({
    id: ids[0],
    code: 'unknown_event_type',
  });
  expect(report.hard_errors[0].detail.event_type).toBe('task_warped');
  expect(report.gate_green).toBe(false);
  // The task is NOT counted as match or drift — it is hard-errored out.
  expect(report.matches.find((m) => m.id === ids[0])).toBeUndefined();
  expect(report.drifts.find((d) => d.id === ids[0])).toBeUndefined();

  // foldTask itself fails loud too.
  expect(() => foldTask([alien], { id: ids[0], created_by: 'x' })).toThrow(FoldHardError);
});

// ---------------------------------------------------------------------------
// §7.4 corrupt-shape fixtures → exempt via EXPLICIT allowlist (A4)
// ---------------------------------------------------------------------------

test('fold.7 the 3 corrupt shapes land in exempt-corrupt (explicit allowlist), not drift; without the allowlist they DO drift', () => {
  const project = makeProject();
  // Replicate the 3 impossible shapes from 1a-format-spec §7(b), keyed on the
  // REAL corrupt ids (the engine's documented defaults).
  const shapes = [
    { id: DEFAULT_EXEMPT_CORRUPT[0], over: { status: 'pending', assigned_to: 'orion', submitted_at: '2026-05-03 12:00:00', rejection_count: 2, claimed_at: null } },
    { id: DEFAULT_EXEMPT_CORRUPT[1], over: { status: 'pending', assigned_to: 'orion', claimed_at: null } },
    { id: DEFAULT_EXEMPT_CORRUPT[2], over: { status: 'pending', submitted_at: '2026-05-04 09:00:00', rejection_count: 1, claimed_at: null } },
  ];
  const baseline = shapes.map(({ id, over }) => {
    handcraftTask({
      projectSlug: project.slug,
      taskId: id,
      projectId: project.id,
      title: `corrupt ${id.slice(0, 8)}`,
      events: [genesisEvent(id, project.id)],
    });
    return {
      id,
      project_id: project.id,
      title: `corrupt ${id.slice(0, 8)}`,
      description: '',
      priority: 'normal',
      created_by: 'orion-3',
      created_at: '2026-05-03 10:00:00',
      updated_at: '2026-05-03 10:00:00',
      submitted_at: null,
      approved_at: null,
      deadline: null,
      result: null,
      tags: [],
      metadata: {},
      rejection_count: 0,
      parent_task_id: null,
      lease_token: null,
      lease_expires_at: null,
      fs_version: 0,
      folder_path: null,
      cutover_included: true,
      assigned_to: null,
      claimed_at: null,
      status: 'pending',
      ...over,
    };
  });

  // Default allowlist: all 3 exempt, diff suppressed, impossible fields listed.
  const report = foldAll(PROJECTS_DIR, baseline);
  expect(report.totals).toEqual({
    tasks: 3, match: 0, drift: 0, exempt: 3, out_of_scope: 0, hard_errors: 0,
  });
  for (const e of report.exempts) {
    expect(e.reason).toBe('exempt_corrupt');
    expect(e.impossible_fields).toBeDefined();
  }
  expect(report.exempts[0].impossible_fields).toMatchObject({
    status: 'pending', assigned_to: 'orion', rejection_count: 2,
  });

  // A4 proof: the allowlist (not pattern magic) is what exempts — with an
  // empty explicit list, the corrupt rows DRIFT.
  const reportNoList = foldAll(PROJECTS_DIR, baseline, { exemptCorrupt: [] });
  expect(reportNoList.totals.exempt).toBe(0);
  expect(reportNoList.totals.drift).toBe(3);
});

// ---------------------------------------------------------------------------
// §7.5 cancel/reopen assigned_to=null rule (pure fold) — the 1a gap
// ---------------------------------------------------------------------------

test('fold.8 task_cancelled and task_reopened null assigned_to (mandatory §4 rule); released → pending+null; rejection_count cumulative', () => {
  const tid = randomUUID();
  const pid = randomUUID();
  const tj = { id: tid, project_id: pid, created_by: 'sys', title: 't', tags: [] };
  const ev = (type, ts, data = {}, toStatus = null) => ({
    ts, task_id: tid, project_id: pid, actor: 'a', event_type: type,
    from_status: null, to_status: toStatus, data,
  });

  // cancel: claimed → cancelled with assigned_to nulled.
  const cancelFold = foldTask([
    ev('task_created', '2026-06-01T10:00:00.000Z', { created_by: 'sys' }),
    ev('task_claimed', '2026-06-01T10:01:00.000Z', { assigned_to: 'nova' }),
    ev('task_cancelled', '2026-06-01T10:02:00.000Z', { cancelled_by: 'nova' }),
  ], tj);
  expect(cancelFold.row.status).toBe('cancelled');
  expect(cancelFold.row.assigned_to).toBeNull();
  // cancel preserves claimed_at (the SQL does not touch it).
  expect(cancelFold.row.claimed_at).toBe('2026-06-01T10:01:00');

  // reject ×2 + reopen: cumulative count; reopen nulls owner + claimed_at +
  // reviewer.
  const reopenFold = foldTask([
    ev('task_created', '2026-06-01T10:00:00.000Z', { created_by: 'sys' }),
    ev('task_claimed', '2026-06-01T10:01:00.000Z', { assigned_to: 'nova' }),
    ev('task_submitted', '2026-06-01T10:02:00.000Z'),
    ev('task_review_requested', '2026-06-01T10:03:00.000Z', { reviewer: 'orion' }),
    ev('task_rejected', '2026-06-01T10:04:00.000Z'),
    ev('task_resumed', '2026-06-01T10:05:00.000Z'),
    ev('task_submitted', '2026-06-01T10:06:00.000Z'),
    ev('task_review_requested', '2026-06-01T10:07:00.000Z', { reviewer: 'orion' }),
    ev('task_rejected', '2026-06-01T10:08:00.000Z'),
    ev('task_reopened', '2026-06-01T10:09:00.000Z'),
  ], tj);
  expect(reopenFold.row.status).toBe('pending');
  expect(reopenFold.row.assigned_to).toBeNull();
  expect(reopenFold.row.claimed_at).toBeNull();
  expect(reopenFold.row.reviewer_agent).toBeNull();
  expect(reopenFold.row.rejection_count).toBe(2);
  // submitted_at is NOT cleared by reopen (the SQL does not touch it).
  expect(reopenFold.row.submitted_at).toBe('2026-06-01T10:06:00');

  // release: pending + assigned_to/claimed_at nulled.
  const releaseFold = foldTask([
    ev('task_created', '2026-06-01T10:00:00.000Z', { created_by: 'sys' }),
    ev('task_claimed', '2026-06-01T10:01:00.000Z', { assigned_to: 'nova' }),
    ev('task_released', '2026-06-01T10:02:00.000Z'),
  ], tj);
  expect(releaseFold.row.status).toBe('pending');
  expect(releaseFold.row.assigned_to).toBeNull();
  expect(releaseFold.row.claimed_at).toBeNull();
});

// ---------------------------------------------------------------------------
// A2 — equal-ts events keep STABLE FILE ORDER
// ---------------------------------------------------------------------------

test('fold.9 equal-ts events fold in stable file order (A2) — both orders', () => {
  const tid = randomUUID();
  const pid = randomUUID();
  const tj = { id: tid, project_id: pid, created_by: 'sys', title: 't', tags: [] };
  const TS = '2026-06-01T10:01:00.000Z';
  const claimBy = (who) => ({
    ts: TS, task_id: tid, project_id: pid, actor: who,
    event_type: 'task_claimed', from_status: 'pending', to_status: 'claimed',
    data: { assigned_to: who },
  });
  const genesis = {
    ts: '2026-06-01T10:00:00.000Z', task_id: tid, project_id: pid, actor: 'sys',
    event_type: 'task_created', from_status: null, to_status: 'pending',
    data: { created_by: 'sys' },
  };

  const ab = foldTask([genesis, claimBy('alpha'), claimBy('beta')], tj);
  expect(ab.row.assigned_to).toBe('beta'); // file order: beta last wins

  const ba = foldTask([genesis, claimBy('beta'), claimBy('alpha')], tj);
  expect(ba.row.assigned_to).toBe('alpha'); // reversed file order: alpha wins
});

// ---------------------------------------------------------------------------
// A5 — lease policy: transient skip + active-lease assertion
// ---------------------------------------------------------------------------

test('fold.10 an ACTIVE lease in the baseline is a gate-blocking assertion; lease fields NEVER drift; expired leases pass', () => {
  const project = makeProject();
  const tid = randomUUID();
  handcraftTask({
    projectSlug: project.slug,
    taskId: tid,
    projectId: project.id,
    title: 'lease probe',
    events: [genesisEvent(tid, project.id)],
  });
  const base = {
    id: tid, project_id: project.id, title: 'lease probe', description: '',
    priority: 'normal', created_by: 'orion-3', created_at: '2026-05-03 10:00:00',
    updated_at: '2026-05-03 10:00:00', status: 'pending', assigned_to: null,
    claimed_at: null, submitted_at: null, approved_at: null, deadline: null,
    result: null, tags: [], metadata: {}, rejection_count: 0,
    parent_task_id: null, fs_version: 3, folder_path: 'x', cutover_included: true,
    lease_token: 'tok-123', lease_expires_at: '2026-06-08T12:00:00.000Z',
  };

  // freeze-time BEFORE expiry → lease is active → gate-blocking assertion.
  const active = foldAll(PROJECTS_DIR, [base], { now: '2026-06-08T11:00:00Z' });
  expect(active.active_lease_assertions).toHaveLength(1);
  expect(active.active_lease_assertions[0]).toMatchObject({
    id: tid, lease_token: 'tok-123', lease_expires_at: '2026-06-08T12:00:00.000Z',
  });
  expect(active.active_lease_assertions[0].disposition).toContain('GATE-BLOCKING');
  expect(active.gate_green).toBe(false); // A5: active lease blocks the gate
  // …but the transient fields NEVER appear as drift (the row otherwise matches).
  expect(active.totals.drift).toBe(0);
  expect(active.totals.match).toBe(1);

  // freeze-time AFTER expiry → no assertion, gate green.
  const expired = foldAll(PROJECTS_DIR, [base], { now: '2026-06-09T00:00:00Z' });
  expect(expired.active_lease_assertions).toHaveLength(0);
  expect(expired.gate_green).toBe(true);
});

// ---------------------------------------------------------------------------
// §5.3/§5.4 — out-of-scope classification (never folded)
// ---------------------------------------------------------------------------

test('fold.11 cutover-excluded rows and DB-only orphans are out_of_scope, never folded', async () => {
  const { baseline } = await buildGoldenFixture();
  const excluded = { ...baseline[0], id: randomUUID(), cutover_included: false };
  const dbOnly = { ...baseline[1], id: randomUUID(), cutover_included: true };
  const rows = [...baseline, excluded, dbOnly];

  const report = foldAll(PROJECTS_DIR, rows);
  expect(report.totals.out_of_scope).toBe(2);
  expect(report.out_of_scope).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: excluded.id, reason: 'cutover_excluded' }),
    expect.objectContaining({ id: dbOnly.id, reason: 'db_only_orphan' }),
  ]));
  expect(report.totals.match).toBe(6);
  expect(report.totals.drift).toBe(0);
  expect(report.totals.tasks).toBe(8);
});

// ---------------------------------------------------------------------------
// allow-stale allowlist (A4)
// ---------------------------------------------------------------------------

test('fold.12 allow-stale ids move their drift into exempt (stale_allowlisted) — explicit ids only', async () => {
  const { ids, baseline } = await buildGoldenFixture();
  const mutated = baseline.map((r) => (r.id === ids[0] ? { ...r, status: 'review' } : { ...r }));

  const report = foldAll(PROJECTS_DIR, mutated, { allowStale: [ids[0]] });
  expect(report.totals.drift).toBe(0);
  expect(report.totals.exempt).toBe(1);
  expect(report.exempts[0]).toMatchObject({ id: ids[0], reason: 'stale_allowlisted' });
  expect(report.exempts[0].fields.map((f) => f.field)).toEqual(['status']);
  expect(report.gate_green).toBe(true);
});

// ---------------------------------------------------------------------------
// vocabulary completeness + normTs unit checks
// ---------------------------------------------------------------------------

test('fold.13 the vocabulary covers every event_type a golden fixture emits, and normTs bridges DB vs ISO-ms forms', async () => {
  const { ids, project } = await buildGoldenFixture();
  const seen = new Set();
  for (const id of ids) {
    const dir = taskDirFor(project.id, id);
    for (const line of fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean)) {
      seen.add(JSON.parse(line).event_type);
    }
  }
  for (const t of seen) expect(EVENT_VOCABULARY).toContain(t);
  // The fixture exercises 13 of the 20 types (no task_resumed — the rework
  // path resumes via reportProgress auto-advance, which emits
  // task_progressed; task_resumed is covered by the pure fold.8 test).
  expect([...seen].sort()).toEqual([
    'task_approved', 'task_cancelled', 'task_claimed', 'task_created',
    'task_orphan_claimed', 'task_orphaned', 'task_progressed',
    'task_reassigned', 'task_rejected', 'task_released', 'task_reopened',
    'task_review_requested', 'task_submitted',
  ].sort());

  expect(normTs('2026-04-20 11:20:34')).toBe('2026-04-20T11:20:34');
  expect(normTs('2026-04-20T11:20:34.231Z')).toBe('2026-04-20T11:20:34');
  expect(normTs('2026-04-20T11:20:34Z')).toBe('2026-04-20T11:20:34');
  expect(normTs(null)).toBeNull();
  expect(normTs('garbage')).toBe('garbage'); // drifts loudly, never collapses to null
});

// ---------------------------------------------------------------------------
// §6 CLI — exact gate line, report files, exit codes
// ---------------------------------------------------------------------------

test('fold.14 CLI writes <prefix>.json + <prefix>.md and ends stdout with the EXACT GATE line; exit 0 green / 1 on drift', async () => {
  const { ids, baseline } = await buildGoldenFixture();
  const basePath = path.join(ROOT, 'baseline.json');
  fs.writeFileSync(basePath, JSON.stringify(baseline));
  const prefix = path.join(ROOT, 'fold-report');
  const cli = path.resolve(import.meta.dir, '..', 'fold-engine-cli.mjs');

  const green = Bun.spawnSync([
    process.execPath, cli,
    '--baseline', basePath,
    '--projects-root', PROJECTS_DIR,
    '--report', prefix,
  ]);
  const out = green.stdout.toString().trim().split('\n');
  expect(out[out.length - 1]).toBe(
    'GATE: tasks=6 match=6 drift=0 exempt=0 out_of_scope=0 hard_errors=0',
  );
  expect(green.exitCode).toBe(0);
  expect(fs.existsSync(`${prefix}.json`)).toBe(true);
  expect(fs.existsSync(`${prefix}.md`)).toBe(true);
  const written = JSON.parse(fs.readFileSync(`${prefix}.json`, 'utf8'));
  expect(written.totals.match).toBe(6);
  expect(written.allowlists.exempt_corrupt).toEqual([...DEFAULT_EXEMPT_CORRUPT]);
  expect(fs.readFileSync(`${prefix}.md`, 'utf8')).toContain('GATE: tasks=6');

  // drifted baseline → exit 1, drift counted in the gate line.
  const mutated = baseline.map((r) => (r.id === ids[0] ? { ...r, status: 'failed' } : r));
  fs.writeFileSync(basePath, JSON.stringify(mutated));
  const red = Bun.spawnSync([
    process.execPath, cli,
    '--baseline', basePath,
    '--projects-root', PROJECTS_DIR,
    '--report', prefix,
  ]);
  const redOut = red.stdout.toString().trim().split('\n');
  expect(redOut[redOut.length - 1]).toBe(
    'GATE: tasks=6 match=5 drift=1 exempt=0 out_of_scope=0 hard_errors=0',
  );
  expect(red.exitCode).toBe(1);
});

// ---------------------------------------------------------------------------
// missing events.jsonl = hard error (never a silent skip / false MATCH)
// ---------------------------------------------------------------------------

test('fold.15 a cutover-included task with a folder but NO events.jsonl is a hard error', async () => {
  const { ids, baseline, project } = await buildGoldenFixture();
  fs.rmSync(path.join(taskDirFor(project.id, ids[2]), 'events.jsonl'));

  const report = foldAll(PROJECTS_DIR, baseline);
  expect(report.totals.hard_errors).toBe(1);
  expect(report.hard_errors[0]).toMatchObject({ id: ids[2], code: 'events_jsonl_unreadable' });
  expect(report.gate_green).toBe(false);
});
