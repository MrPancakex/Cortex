import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDashboardHandler, DEFAULT_DIST, mountDashboardRoutes } from '../backend/routes/dashboard.js';
import { buildTacticalSnapshot } from '../backend/routes/gateway-proxy.js';

let tmpRoot;
function makeAdapter() {
  const routes = [];
  return {
    routes,
    add: (method, p, handler) => routes.push({ method, path: p, handler }),
  };
}

function makeRes() {
  const chunks = [];
  const res = {
    statusCode: 0,
    headers: {},
    headersSent: false,
    finished: false,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end() { this.finished = true; },
  };
  // The dashboard handler uses `pipe(res)`, which calls write+end on the
  // destination. Give it a minimal writable interface.
  res.write = (chunk) => { chunks.push(chunk); return true; };
  res.on = () => res;
  res.once = () => res;
  res.emit = () => true;
  res._chunks = chunks;
  return res;
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-dash-'));
  fs.writeFileSync(path.join(tmpRoot, 'index.html'), '<html>hi</html>');
  fs.writeFileSync(path.join(tmpRoot, 'app.js'), 'console.log("x")');
});

afterEach(() => {
  if (tmpRoot && fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('createDashboardHandler', () => {
  test('405s on non-GET/HEAD', async () => {
    const handler = createDashboardHandler({ distRoot: tmpRoot });
    const res = makeRes();
    handler({ req: { method: 'POST', path: '/' }, res });
    expect(res.statusCode).toBe(405);
  });

  test('refuses to serve /api/* paths', () => {
    const handler = createDashboardHandler({ distRoot: tmpRoot });
    const res = makeRes();
    handler({ req: { method: 'GET', path: '/api/health' }, res });
    expect(res.statusCode).toBe(404);
  });

  test('rejects traversal attempts', () => {
    const handler = createDashboardHandler({ distRoot: tmpRoot });
    const res = makeRes();
    handler({ req: { method: 'GET', path: '/../../../etc/passwd' }, res });
    expect(res.statusCode).toBe(400);
  });

  test('serves index.html at /', async () => {
    const handler = createDashboardHandler({ distRoot: tmpRoot });
    const res = makeRes();
    handler({ req: { method: 'GET', path: '/' }, res });
    // Read is async — poll briefly. Bun's test runner honors await.
    await new Promise((r) => setTimeout(r, 20));
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  test('serves a static file when it exists', async () => {
    const handler = createDashboardHandler({ distRoot: tmpRoot });
    const res = makeRes();
    handler({ req: { method: 'GET', path: '/app.js' }, res });
    await new Promise((r) => setTimeout(r, 20));
    expect(res.headers['content-type']).toMatch(/javascript/);
  });

  test('falls back to index.html for unknown SPA route', async () => {
    const handler = createDashboardHandler({ distRoot: tmpRoot });
    const res = makeRes();
    handler({ req: { method: 'GET', path: '/dashboard/tasks' }, res });
    await new Promise((r) => setTimeout(r, 20));
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  test('404s when dist is missing entirely', async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    const handler = createDashboardHandler({ distRoot: tmpRoot });
    const res = makeRes();
    handler({ req: { method: 'GET', path: '/unknown' }, res });
    await new Promise((r) => setTimeout(r, 20));
    expect(res.statusCode).toBe(404);
  });
});

describe('mountDashboardRoutes', () => {
  test('registers GET and HEAD wildcards', () => {
    const adapter = makeAdapter();
    mountDashboardRoutes(adapter, { distRoot: tmpRoot });
    const methods = adapter.routes.map((r) => r.method);
    expect(methods).toContain('GET');
    expect(methods).toContain('HEAD');
  });

  test('throws on missing adapter', () => {
    expect(() => mountDashboardRoutes(null)).toThrow();
  });

  test('DEFAULT_DIST points at platform/frontend/dist', () => {
    expect(DEFAULT_DIST).toMatch(/platform\/frontend\/dist$/);
  });
});

// ---------------------------------------------------------------------------
// ROOT 3 (D3c) — dashboard read-path freshness: CORTEX_FOLDER_AUTHORITY flag
// must NOT alter the task payload seen through the platform's tactical snapshot
// or gateway proxy read path (the real production dashboard query path).
//
// We use a stubbed gateway (matching the pattern in gateway-proxy.test.js) and
// call buildTacticalSnapshot with the flag off/on. The task payload in the
// snapshot must be byte-equal regardless of the flag value.
// ---------------------------------------------------------------------------

describe('dashboard read-path freshness (Phase-4 D3c)', () => {
  const TASK_FIXTURE = { id: 'task-1', title: 'Alpha Task', status: 'pending', project_id: 'proj-1' };
  const PROJECT_FIXTURE = { id: 'proj-1', name: 'Alpha Project' };

  function makeStubGateway(taskOverride) {
    const tasks = taskOverride ?? [TASK_FIXTURE];
    return {
      health: async () => ({ status: 'ok' }),
      listAgents: async () => ({ agents: [] }),
      stats: async () => ({ active: 0 }),
      listTasks: async () => ({ tasks }),
      listProjects: async () => ({ projects: [PROJECT_FIXTURE] }),
      getBridgeInbox: async () => ({ messages: [] }),
      logs: async () => ({ logs: [] }),
      listProjectPhases: async () => ({ phases: [{ number: 1 }] }),
    };
  }

  test('tactical snapshot task payload is byte-equal with CORTEX_FOLDER_AUTHORITY unset vs "1"', async () => {
    const saved = process.env.CORTEX_FOLDER_AUTHORITY;
    try {
      // Snapshot with flag absent
      delete process.env.CORTEX_FOLDER_AUTHORITY;
      const snapOff = await buildTacticalSnapshot(makeStubGateway());

      // Snapshot with flag on
      process.env.CORTEX_FOLDER_AUTHORITY = '1';
      const snapOn = await buildTacticalSnapshot(makeStubGateway());

      // The tasks widget must return the exact same data regardless of flag.
      // buildTacticalSnapshot passes through gateway.listTasks() directly —
      // the flag must not introduce any FS-read branch in the read path.
      expect(snapOn.tasks).toEqual(snapOff.tasks);
      expect(JSON.stringify(snapOn.tasks)).toBe(JSON.stringify(snapOff.tasks));
    } finally {
      if (saved === undefined) delete process.env.CORTEX_FOLDER_AUTHORITY;
      else process.env.CORTEX_FOLDER_AUTHORITY = saved;
    }
  });

  test('tactical snapshot project+task enrichment is byte-equal flag off vs on', async () => {
    const saved = process.env.CORTEX_FOLDER_AUTHORITY;
    try {
      delete process.env.CORTEX_FOLDER_AUTHORITY;
      const snapOff = await buildTacticalSnapshot(makeStubGateway());

      process.env.CORTEX_FOLDER_AUTHORITY = '1';
      const snapOn = await buildTacticalSnapshot(makeStubGateway());

      // The enriched project list (tasks + phases joined per-project) must be
      // identical: the flag must not affect which tasks are returned or how
      // they are mapped into the project enrichment.
      expect(snapOn.projects).toEqual(snapOff.projects);
      expect(JSON.stringify(snapOn.projects)).toBe(JSON.stringify(snapOff.projects));
    } finally {
      if (saved === undefined) delete process.env.CORTEX_FOLDER_AUTHORITY;
      else process.env.CORTEX_FOLDER_AUTHORITY = saved;
    }
  });

  test('tactical snapshot health widget is byte-equal flag off vs on', async () => {
    const saved = process.env.CORTEX_FOLDER_AUTHORITY;
    try {
      delete process.env.CORTEX_FOLDER_AUTHORITY;
      const snapOff = await buildTacticalSnapshot(makeStubGateway());

      process.env.CORTEX_FOLDER_AUTHORITY = '1';
      const snapOn = await buildTacticalSnapshot(makeStubGateway());

      // Health check must not be flag-dependent.
      expect(snapOn.health).toEqual(snapOff.health);
    } finally {
      if (saved === undefined) delete process.env.CORTEX_FOLDER_AUTHORITY;
      else process.env.CORTEX_FOLDER_AUTHORITY = saved;
    }
  });
});
