/**
 * Tests for POST /v1/api/projects (createProject handler) in project-routes.js.
 *
 * Run with:
 *   cd $CORTEX_HOME && bun test services/gateway/tasks/tests/project-create.routes.test.js
 *
 * Focus: verifying that the default root_path resolves to resolveProjectsRoot()/<slug>
 * (NOT /tmp/cortex-projects/<slug>), that explicit root_path is passed through, and
 * that slug derivation works correctly.
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
import { resolveProjectsRoot } from '@cortex/core/constants';
import { mountProjectRoutes } from '../project-routes.js';

// ---------------------------------------------------------------------------
// Mock adapter — records handlers keyed by "METHOD PATH"
// ---------------------------------------------------------------------------

function makeMockAdapter() {
  const routes = new Map();
  return {
    add(method, routePath, handler) {
      routes.set(`${method} ${routePath}`, handler);
    },
    dispatch(method, routePath, ctx) {
      const handler = routes.get(`${method} ${routePath}`);
      if (!handler) return { status: 404, body: { error: 'no_route' } };
      return handler(ctx);
    },
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

let ROOT;
let PROJECTS_DIR;
let db;
let adapter;

beforeEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();

  const rand = randomUUID().slice(0, 8);
  ROOT = path.join(os.tmpdir(), `cortex-projcreate-${process.pid}-${rand}`);
  PROJECTS_DIR = path.join(ROOT, 'projects');
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });

  process.env.CORTEX_DB_PATH = path.join(ROOT, 'test.db');
  // CORTEX_PROJECTS_DIR drives resolveProjectsRoot() — no CORTEX_HUB_DIR override.
  process.env.CORTEX_PROJECTS_DIR = PROJECTS_DIR;
  // Ensure HUB_DIR does not interfere (precedence: HUB_DIR > DATA_DIR > PROJECTS_DIR).
  delete process.env.CORTEX_HUB_DIR;
  delete process.env.CORTEX_DATA_DIR;

  db = getDb({ path: process.env.CORTEX_DB_PATH });
  runMigrations();

  adapter = makeMockAdapter();
  mountProjectRoutes(adapter);
});

afterEach(() => {
  resetTaskStatementsForTests();
  resetDbForTests();
  delete process.env.CORTEX_DB_PATH;
  delete process.env.CORTEX_PROJECTS_DIR;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Case 1: Default root_path — must NOT be /tmp/cortex-projects/...
// ---------------------------------------------------------------------------

test('1. POST /v1/api/projects without root_path → root_path under resolveProjectsRoot()', () => {
  const result = adapter.dispatch('POST', '/v1/api/projects', {
    body: { name: 'Default Path Test' },
  });

  expect(result.status).toBe(201);
  const { root_path } = result.body;
  const expectedBase = resolveProjectsRoot();

  // Must be under the canonical projects root (not /tmp/cortex-projects/).
  expect(root_path.startsWith(expectedBase)).toBe(true);
  // Must NOT be under /tmp/cortex-projects (the old broken default).
  expect(root_path.startsWith('/tmp/cortex-projects')).toBe(false);
});

// ---------------------------------------------------------------------------
// Case 2: Explicit root_path — passed through verbatim
// ---------------------------------------------------------------------------

test('2. POST /v1/api/projects with explicit root_path → uses that path verbatim', () => {
  const explicitPath = '/some/absolute/path';
  const result = adapter.dispatch('POST', '/v1/api/projects', {
    body: { name: 'Explicit Path Test', root_path: explicitPath }, isAdmin: true,
  });

  expect(result.status).toBe(201);
  expect(result.body.root_path).toBe(explicitPath);
});

// A non-admin caller may NOT set a custom root_path — an attacker-set root_path
// feeds the reconciler's authoritative task-folder ingest (review-loop bypass).
test('2b. POST /v1/api/projects with explicit root_path as non-admin → 403', () => {
  const result = adapter.dispatch('POST', '/v1/api/projects', {
    body: { name: 'No Admin Path', root_path: '/some/absolute/path' }, isAdmin: false,
  });
  expect(result.status).toBe(403);
  // S5: forbidden() now uses the SSOT envelope {error:'forbidden', reason:<why>}
  // (was {error:'admin_only'}); the 403 status is unchanged.
  expect(result.body.error).toBe('forbidden');
  expect(result.body.reason).toBe('admin_only');
});

// ---------------------------------------------------------------------------
// Case 3: Slug derivation — default root_path ends with slugified name
// ---------------------------------------------------------------------------

test('3. POST /v1/api/projects with "My Cool Project" → default root_path ends with /my-cool-project', () => {
  const result = adapter.dispatch('POST', '/v1/api/projects', {
    body: { name: 'My Cool Project' },
  });

  expect(result.status).toBe(201);
  const { root_path } = result.body;
  expect(root_path.endsWith('/my-cool-project')).toBe(true);
});
