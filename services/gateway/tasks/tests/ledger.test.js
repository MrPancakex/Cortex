/**
 * Tests for ledger.js — pure filesystem helpers for the 7-file ledger schema.
 * Run with: cd $CORTEX_HOME && bun test services/gateway/tasks/tests/ledger.test.js
 */
import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
  readProjectJson,
  writeProjectJson,
  readPhaseJson,
  writePhaseJson,
  readTaskJson,
  writeTaskJson,
  readSummary,
  writeSummary,
  appendRun,
  readVerification,
  writeVerification,
  appendLedger,
} from '../ledger.js';

// -- tmp dir setup ----------------------------------------------------------

let tmpDir;

beforeEach(() => {
  const rand = Math.random().toString(36).slice(2, 8);
  tmpDir = `/tmp/ledger-test-${process.pid}-${rand}`;
  fs.mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// -- helpers ----------------------------------------------------------------

function projectDir() { return path.join(tmpDir, 'project'); }
function phaseDir()   { return path.join(tmpDir, 'phase'); }
function taskDir()    { return path.join(tmpDir, 'task'); }

// -- tests ------------------------------------------------------------------

test('1. project.json round-trip: write then read returns the same object', () => {
  const obj = { schema_version: 1, id: 'proj-uuid', slug: 'test-proj', name: 'Test' };
  writeProjectJson(projectDir(), obj);
  const result = readProjectJson(projectDir());
  expect(result).toEqual(obj);
});

test('2. phase.json round-trip', () => {
  const obj = { schema_version: 1, id: 'phase-uuid', number: 1, name: 'Foundation' };
  writePhaseJson(phaseDir(), obj);
  const result = readPhaseJson(phaseDir());
  expect(result).toEqual(obj);
});

test('3. task.json round-trip', () => {
  const obj = {
    schema_version: 1,
    id: 'task-uuid',
    title: 'Build ledger',
    status: 'in_progress',
    fs_version: 0,
  };
  writeTaskJson(taskDir(), obj);
  const result = readTaskJson(taskDir());
  expect(result).toEqual(obj);
});

test('4. verification.json round-trip', () => {
  const obj = {
    schema_version: 1,
    task_id: 'task-uuid',
    status: 'pending',
    reviewer: 'orion',
    checks: [],
    feedback: null,
  };
  writeVerification(taskDir(), obj);
  const result = readVerification(taskDir());
  expect(result).toEqual(obj);
});

test('5. summary.md round-trip with valid 1KB string', () => {
  const md = '# Task\n\n' + 'x'.repeat(1000);
  writeSummary(taskDir(), md);
  const result = readSummary(taskDir());
  expect(result).toBe(md);
});

test('6. summary.md write throws on 3KB string (error contains summary_too_large)', () => {
  // 3072 ASCII bytes > 2048 byte cap
  const bigMd = 'x'.repeat(3072);
  expect(() => writeSummary(taskDir(), bigMd)).toThrow('summary_too_large');
});

test('7. runs.jsonl: 3 appends produce exactly 3 non-empty lines', () => {
  const run = (n) => ({ run_id: `run-${n}`, task_id: 'task-uuid', ts: new Date().toISOString() });
  appendRun(taskDir(), run(1));
  appendRun(taskDir(), run(2));
  appendRun(taskDir(), run(3));
  const raw = fs.readFileSync(path.join(taskDir(), 'runs.jsonl'), 'utf8');
  expect(raw.split('\n').filter(Boolean).length).toBe(3);
});

test('8. ledger.jsonl: each appended line parses back to original object', () => {
  const events = [
    { ts: '2026-05-25T10:00:00.000Z', task_id: 'uuid-1', event_type: 'task_created' },
    { ts: '2026-05-25T10:01:00.000Z', task_id: 'uuid-1', event_type: 'task_claimed' },
  ];
  for (const ev of events) appendLedger(projectDir(), ev);
  const raw = fs.readFileSync(path.join(projectDir(), 'ledger.jsonl'), 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  expect(lines.length).toBe(2);
  for (let i = 0; i < lines.length; i++) {
    expect(JSON.parse(lines[i])).toEqual(events[i]);
  }
});

test('9. read of missing file returns null (does not throw)', () => {
  expect(readProjectJson(projectDir())).toBeNull();
  expect(readPhaseJson(phaseDir())).toBeNull();
  expect(readTaskJson(taskDir())).toBeNull();
  expect(readVerification(taskDir())).toBeNull();
  expect(readSummary(taskDir())).toBeNull();
});

test('10. read of malformed JSON returns null (does not throw)', () => {
  const dir = path.join(tmpDir, 'malformed');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'project.json'), '{ not valid json ');
  expect(readProjectJson(dir)).toBeNull();
});

test('11. write creates parent directories if missing', () => {
  const deep = path.join(tmpDir, 'a', 'b', 'c', 'project');
  const obj = { schema_version: 1, id: 'x' };
  writeProjectJson(deep, obj);
  expect(readProjectJson(deep)).toEqual(obj);
});

test('12. atomic write: no .tmp file remains after successful write', () => {
  const dir = path.join(tmpDir, 'atomic');
  const obj = { schema_version: 1 };
  writeTaskJson(dir, obj);
  const tmpFile = path.join(dir, 'task.json.tmp');
  expect(fs.existsSync(tmpFile)).toBe(false);
  // Final file should exist
  expect(fs.existsSync(path.join(dir, 'task.json'))).toBe(true);
});

test('13. append-only files are not clobbered: both lines present after two appends', () => {
  const run1 = { run_id: 'run-1', task_id: 'task-uuid', ts: '2026-05-25T10:00:00Z' };
  const run2 = { run_id: 'run-2', task_id: 'task-uuid', ts: '2026-05-25T10:01:00Z' };
  appendRun(taskDir(), run1);
  appendRun(taskDir(), run2);
  const raw = fs.readFileSync(path.join(taskDir(), 'runs.jsonl'), 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  expect(lines.length).toBe(2);
  expect(JSON.parse(lines[0])).toEqual(run1);
  expect(JSON.parse(lines[1])).toEqual(run2);
});
