/**
 * Task 120 R3 (R2 #2) — STAGED EVENT WRITES in appendLedgerAndEvents.
 *
 * Reviewer-acked design:
 *   (a) events.jsonl is appended FIRST (plain file, truncate-compensable;
 *       the undo-handle mechanism is kept);
 *   (b) the ledger.jsonl append is the LAST fallible FILE operation before
 *       the SQLite commit — no task-folder/event filesystem work of any kind
 *       happens after it (ledger.jsonl may be chattr +a append-only, so it
 *       must only be written once every other fallible fs step succeeded);
 *   (c) restore/compensation failures are LOUD: a hard
 *       'ledger_compensation_failed' error + a structured recovery line —
 *       the boot parity check (reconciler step 6, audit_log rows vs
 *       ledger.jsonl lines) is the recovery path;
 *   (d) the ONLY accepted residue class: ledger line appended + SQLite
 *       commit fails on an append-only ledger (documented in
 *       WRITERS-INVENTORY.md §2b).
 *
 * The ordering proof here is STRUCTURAL, two ways:
 *   1. instrumentation — spy fs.appendFileSync through a real transition and
 *      assert events.jsonl lands strictly before ledger.jsonl, with NOTHING
 *      appended after the ledger line;
 *   2. grep-style static assertion — inside appendLedgerAndEvents' source no
 *      appendTaskEvents call exists after the appendLedger call, and the
 *      callers (transitions.js / orphan.js) contain no appendTaskEvents call
 *      at all, so no code path CAN append events after the ledger append.
 */

import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { getDb, runMigrations, resetDbForTests } from '@cortex/sdk/db';
import {
  getTaskStatements,
  resetTaskStatementsForTests,
} from '@cortex/gateway/tasks';
import {
  createTask,
  claimTask,
  requestTaskDelete,
  approveTaskDelete,
} from '../transitions.js';
import { getPhaseDir, findTaskFolderByUuid } from '../folders.js';

let ROOT;
let PROJECTS_DIR;
let db;
let stmts;

beforeEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();
  const rand = randomUUID().slice(0, 8);
  ROOT = path.join(os.tmpdir(), `cortex-t120sw-${process.pid}-${rand}`);
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

const actor = (id) => ({ id });

function createRealTask({ projectId, title = 'T120 staged' }) {
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
  return findTaskFolderByUuid(getPhaseDir(project, 1), taskId);
}

function readEventsAt(dir) {
  const fp = path.join(dir, 'events.jsonl');
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

function readLedgerLines(rootPath) {
  const fp = path.join(rootPath, 'ledger.jsonl');
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
}

// ---------------------------------------------------------------------------
// (i) structural ordering — instrumentation through a REAL transition
// ---------------------------------------------------------------------------

test('r3.f2.order.spy a real transition appends events.jsonl strictly BEFORE ledger.jsonl, and NOTHING is appended after the ledger line', () => {
  const { id: projectId } = makeProject();
  const agentId = makeAgent();
  const taskId = createRealTask({ projectId });

  const appended = [];
  const origAppend = fs.appendFileSync;
  fs.appendFileSync = function (fp, ...rest) {
    appended.push(String(fp));
    return origAppend.call(fs, fp, ...rest);
  };
  let res;
  try {
    res = claimTask({ taskId, actor: actor(agentId) });
  } finally {
    fs.appendFileSync = origAppend;
  }
  expect(res.status).toBe(200);

  const eventsIdx = appended.findIndex((p) => p.endsWith('events.jsonl'));
  const ledgerIdx = appended.findIndex((p) => p.endsWith('ledger.jsonl'));
  expect(eventsIdx).toBeGreaterThanOrEqual(0);
  expect(ledgerIdx).toBeGreaterThanOrEqual(0);
  // events FIRST, ledger after it…
  expect(eventsIdx).toBeLessThan(ledgerIdx);
  // …and the ledger append is the LAST append of the transition — no
  // events/task-folder append of any kind follows it.
  expect(ledgerIdx).toBe(appended.length - 1);
});

// ---------------------------------------------------------------------------
// (i) structural ordering — grep-style static assertion: no code path exists
// that appends events after the ledger append
// ---------------------------------------------------------------------------

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

test('r3.f2.order.static appendLedgerAndEvents contains NO appendTaskEvents call after its appendLedger call, and no caller appends events itself', () => {
  const TASKS_DIR = path.resolve(import.meta.dir, '..');
  const ledgerSrc = stripComments(
    fs.readFileSync(path.join(TASKS_DIR, 'ledger.js'), 'utf8'),
  );
  const fnStart = ledgerSrc.indexOf('export function appendLedgerAndEvents');
  expect(fnStart).toBeGreaterThan(-1);
  const body = ledgerSrc.slice(fnStart);

  // The events append exists and precedes the (bare) ledger append.
  const eventsCall = body.search(/\bappendTaskEvents\s*\(/);
  expect(eventsCall).toBeGreaterThan(-1);
  let ledgerCall = -1;
  for (const m of body.matchAll(/\bappendLedger(\w*)\s*\(/g)) {
    if (m[1] === '') { ledgerCall = m.index; break; }
  }
  expect(ledgerCall).toBeGreaterThan(-1);
  expect(eventsCall).toBeLessThan(ledgerCall);
  // NO appendTaskEvents call exists after the ledger append — structurally,
  // no code path can write an event line once the ledger line landed.
  expect(body.slice(ledgerCall)).not.toMatch(/\bappendTaskEvents\s*\(/);

  // And the EVENT-writing callers never touch the raw events append at all
  // (the compensated helper is their only mechanism), so the ordering above
  // is the ordering of every transition.
  for (const file of ['transitions.js', 'orphan.js']) {
    const src = stripComments(
      fs.readFileSync(path.join(TASKS_DIR, file), 'utf8'),
    );
    expect(src).not.toMatch(/\bappendTaskEvents\s*\(/);
  }
});

// ---------------------------------------------------------------------------
// (ii) append-only simulation — compensation failure is LOUD, never silent
// ---------------------------------------------------------------------------

test('r3.f2.eperm append-only ledger (truncate → EPERM): a late delete failure surfaces ledger_compensation_failed LOUD with the recovery log line — events restored, folder restored, ledger line is the only (documented) residue', () => {
  const { id: projectId, rootPath } = makeProject();
  const taskId = createRealTask({ projectId });
  requestTaskDelete({ taskId, body: {}, actor: actor('admin'), isAdmin: true });

  const dir = taskDirFor(projectId, taskId);
  const eventsBefore = readEventsAt(dir).length;
  const ledgerLinesBefore = readLedgerLines(rootPath).length;

  // chattr +a semantics: truncating ledger.jsonl is impossible (EPERM).
  const origTruncate = fs.truncateSync;
  fs.truncateSync = function (fp, len) {
    if (String(fp).endsWith('ledger.jsonl')) {
      const e = new Error(`EPERM: operation not permitted, truncate '${fp}'`);
      e.code = 'EPERM';
      throw e;
    }
    return origTruncate.call(fs, fp, len);
  };
  // Force the late failure: the staged appends succeed, then the guarded
  // hard delete throws → the held undo handle must compensate.
  const origRun = stmts.hardDeleteTask.run;
  stmts.hardDeleteTask.run = () => { throw new Error('forced_hard_delete_failure'); };
  const errLines = [];
  const origConsoleError = console.error;
  console.error = (...args) => { errLines.push(args.map(String).join(' ')); };
  let res;
  try {
    res = approveTaskDelete({ taskId, actor: actor('admin'), isAdmin: true });
  } finally {
    console.error = origConsoleError;
    stmts.hardDeleteTask.run = origRun;
    fs.truncateSync = origTruncate;
  }

  // LOUD hard error — never a silent pass.
  expect(res.status).toBe(500);
  expect(String(res.body.message)).toContain('ledger_compensation_failed');
  // The structured recovery/parity line was logged.
  const recovery = errLines.filter((l) => l.includes('ledger.compensation_failed'));
  expect(recovery.length).toBeGreaterThan(0);
  expect(recovery[0]).toContain('parity');

  // The task row is fully intact (retryable).
  const row = stmts.getTask.get(taskId);
  expect(row).not.toBeNull();
  expect(JSON.parse(row.metadata).delete_requested_at).toBeTruthy();
  // The folder was still restored to its live name (the loud compensation
  // failure must not strand the rename too).
  expect(fs.existsSync(dir)).toBe(true);
  expect(fs.existsSync(`${dir} (deleted)`)).toBe(false);
  // events.jsonl (plain file) WAS restored — zero event residue.
  expect(readEventsAt(dir).length).toBe(eventsBefore);
  expect(readEventsAt(dir).filter((e) => e.event_type === 'task_deleted')).toEqual([]);
  // The ONLY residue is the documented class: the appended ledger line that
  // the append-only attribute made impossible to truncate. The boot parity
  // check (ledger lines vs audit rows) detects exactly this.
  const ledgerLines = readLedgerLines(rootPath);
  expect(ledgerLines.length).toBe(ledgerLinesBefore + 1);
  expect(ledgerLines[ledgerLines.length - 1].event_type).toBe('task_deleted');
});
