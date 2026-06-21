/**
 * Unit tests for lib/krita-client.js
 * All tests mock _spawnFn and _scriptFlagProbe — no real Krita process spawned.
 */

import { describe, test, expect } from 'bun:test';
import { runKritaScript, kritaHealth } from '../krita-client.js';

// -- Helpers ------------------------------------------------------------------

/** Build a mock spawnFn that resolves with given values. */
function mockSpawn({ stdout = '', stderr = '', code = 0, delayMs = 0 } = {}) {
  return (_bin, _args, _opts) => {
    const promise = new Promise((resolve) =>
      setTimeout(() => resolve({ stdout, stderr, code }), delayMs)
    );
    return { promise, kill: () => {} };
  };
}

/** A probe that reports --script IS supported. */
const probeSupported = async () => true;

/** A probe that reports --script is NOT supported. */
const probeUnsupported = async () => false;

// -- Tests --------------------------------------------------------------------

describe('runKritaScript', () => {
  test('happy path: returns completed + parsed output paths', async () => {
    const stdout = 'Krita starting...\nOUTPUT: /tmp/render.png\nOUTPUT: /tmp/thumb.jpg\nDone.\n';
    const captured = [];
    const result = await runKritaScript({
      scriptPath: '/tmp/test.py',
      runId: 'run-001',
      _spawnFn: mockSpawn({ stdout, code: 0 }),
      _scriptFlagProbe: probeSupported,
      _updateRunArtifactPath: (paths, runId) => captured.push({ paths, runId }),
    });

    expect(result.status).toBe('completed');
    expect(result.outputs).toEqual(['/tmp/render.png', '/tmp/thumb.jpg']);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(captured).toHaveLength(1);
    expect(captured[0].runId).toBe('run-001');
    expect(JSON.parse(captured[0].paths)).toEqual(['/tmp/render.png', '/tmp/thumb.jpg']);
  });

  test('error: non-zero exit returns failed status', async () => {
    const result = await runKritaScript({
      scriptPath: '/tmp/bad.py',
      _spawnFn: mockSpawn({ stdout: '', stderr: 'SyntaxError: bad script', code: 1 }),
      _scriptFlagProbe: probeSupported,
    });

    expect(result.status).toBe('failed');
    expect(result.outputs).toEqual([]);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test('timeout: returns timeout status and no outputs', async () => {
    const result = await runKritaScript({
      scriptPath: '/tmp/hang.py',
      timeoutMs: 50,
      _spawnFn: mockSpawn({ stdout: 'OUTPUT: /tmp/out.png', code: 0, delayMs: 200 }),
      _scriptFlagProbe: probeSupported,
    });

    expect(result.status).toBe('timeout');
    expect(result.outputs).toEqual([]);
  });

  test('no-output: completed with empty outputs array, no updateRunArtifactPath call', async () => {
    const captured = [];
    const result = await runKritaScript({
      scriptPath: '/tmp/no_out.py',
      runId: 'run-002',
      _spawnFn: mockSpawn({ stdout: 'Processing... done.\n', code: 0 }),
      _scriptFlagProbe: probeSupported,
      _updateRunArtifactPath: (p, r) => captured.push({ p, r }),
    });

    expect(result.status).toBe('completed');
    expect(result.outputs).toEqual([]);
    // Must NOT call updateRunArtifactPath when outputs is empty
    expect(captured).toHaveLength(0);
  });

  test('multi-output: all OUTPUT: lines captured and written as JSON array', async () => {
    const stdout = [
      'OUTPUT: /out/frame001.png',
      'OUTPUT: /out/frame002.png',
      'OUTPUT: /out/frame003.png',
    ].join('\n') + '\n';

    const captured = [];
    const result = await runKritaScript({
      scriptPath: '/tmp/batch.py',
      runId: 'run-003',
      _spawnFn: mockSpawn({ stdout, code: 0 }),
      _scriptFlagProbe: probeSupported,
      _updateRunArtifactPath: (paths, runId) => captured.push({ paths, runId }),
    });

    expect(result.status).toBe('completed');
    expect(result.outputs).toHaveLength(3);
    expect(result.outputs[0]).toBe('/out/frame001.png');
    expect(result.outputs[2]).toBe('/out/frame003.png');
    expect(captured[0].runId).toBe('run-003');
    expect(JSON.parse(captured[0].paths)).toHaveLength(3);
  });

  test('unsupported: --script not in krita --help, returns unsupported with message', async () => {
    const result = await runKritaScript({
      scriptPath: '/tmp/test.py',
      _spawnFn: mockSpawn({ stdout: '', code: 0 }),
      _scriptFlagProbe: probeUnsupported,
    });

    expect(result.status).toBe('unsupported');
    expect(result.outputs).toEqual([]);
    expect(result.message).toMatch(/file-bridge/i);
    expect(result.message).toMatch(/Scripter/i);
  });
});

describe('kritaHealth', () => {
  test('ok: true when kritaBin is executable', () => {
    // Use a known executable as the bin
    const result = kritaHealth({ kritaBin: '/usr/bin/env' });
    expect(result.ok).toBe(true);
    expect(result.version).toBeNull();
    expect(result.path).toBe('/usr/bin/env');
  });

  test('ok: false when kritaBin does not exist', () => {
    const result = kritaHealth({ kritaBin: '/nonexistent/krita' });
    expect(result.ok).toBe(false);
    expect(result.version).toBeNull();
    expect(result.path).toBe('/nonexistent/krita');
  });
});
