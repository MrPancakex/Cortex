/**
 * Unit tests for lib/godot-client.js — Slice F.6.
 *
 * All spawn calls are mocked; no real Godot process is started in most tests.
 * Test 6 (godotHealth) is a real probe — Godot 4.6.3 is installed at
 * /usr/local/bin/godot and `godot --version` exits cleanly without a display.
 *
 * Tests:
 *  1. Happy path — exit 0, OUTPUT: lines → status:'completed', outputs populated, DB called
 *  2. Error exit — non-zero exit → status:'failed', outputs:[]
 *  3. Timeout — spawn never resolves in time → status:'timeout', exit_code:null
 *  4. No output — exit 0 but no OUTPUT: lines → outputs:[], updateRunArtifactPath not called
 *  5. Multi-output — three OUTPUT: lines → all captured, DB called with JSON array
 *  6. godotHealth — real probe: ok:true, version matches 4.6.3, path correct
 */

import { describe, test, expect } from 'bun:test';
import { runGodotScript, godotHealth } from '../godot-client.js';

// -- Mock spawn factory -------------------------------------------------------

/**
 * Build a mock _spawnFn.
 * @param {{ stdout?: string, stderr?: string, code?: number, delayMs?: number }} opts
 */
function mockSpawn({ stdout = '', stderr = '', code = 0, delayMs = 0 } = {}) {
  return (_bin, _args) => {
    const promise = new Promise((resolve) =>
      setTimeout(() => resolve({ stdout, stderr, code }), delayMs)
    );
    return { promise, kill: () => {} };
  };
}

// -- Tests --------------------------------------------------------------------

describe('runGodotScript', () => {
  test('1. happy path: exit 0 with OUTPUT lines → completed + artifact recorded', async () => {
    const stdout = 'Godot Engine initializing...\nOUTPUT: /tmp/game.pck\nOUTPUT: /tmp/game.x86_64\nDone.\n';
    const captured = [];

    const result = await runGodotScript({
      projectPath: '/tmp/fake-project',
      scriptPath: '/tmp/fake-project/export.gd',
      runId: 'run-f6-001',
      _spawnFn: mockSpawn({ stdout, code: 0 }),
      _updateRunArtifactPath: (paths, runId) => captured.push({ paths, runId }),
    });

    expect(result.status).toBe('completed');
    expect(result.exit_code).toBe(0);
    expect(result.outputs).toEqual(['/tmp/game.pck', '/tmp/game.x86_64']);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
    expect(captured).toHaveLength(1);
    expect(captured[0].runId).toBe('run-f6-001');
    expect(JSON.parse(captured[0].paths)).toEqual(['/tmp/game.pck', '/tmp/game.x86_64']);
  });

  test('2. error exit: non-zero code → failed, outputs empty, no DB call', async () => {
    const captured = [];

    const result = await runGodotScript({
      projectPath: '/tmp/fake-project',
      scriptPath: '/tmp/fake-project/bad.gd',
      runId: 'run-f6-002',
      _spawnFn: mockSpawn({ stdout: '', stderr: 'Error: script failed', code: 1 }),
      _updateRunArtifactPath: (p, r) => captured.push({ p, r }),
    });

    expect(result.status).toBe('failed');
    expect(result.exit_code).toBe(1);
    expect(result.outputs).toEqual([]);
    expect(captured).toHaveLength(0);
  });

  test('3. timeout: spawn hangs past timeoutMs → timeout, exit_code null', async () => {
    const result = await runGodotScript({
      projectPath: '/tmp/fake-project',
      scriptPath: '/tmp/fake-project/hang.gd',
      timeoutMs: 50,
      _spawnFn: mockSpawn({ stdout: 'OUTPUT: /tmp/out.pck', code: 0, delayMs: 300 }),
    });

    expect(result.status).toBe('timeout');
    expect(result.exit_code).toBeNull();
    expect(result.outputs).toEqual([]);
    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  test('4. no-output: exit 0 but no OUTPUT lines → completed, empty outputs, no DB call', async () => {
    const captured = [];

    const result = await runGodotScript({
      projectPath: '/tmp/fake-project',
      scriptPath: '/tmp/fake-project/silent.gd',
      runId: 'run-f6-004',
      _spawnFn: mockSpawn({ stdout: 'Initializing...\nScript executed.\n', code: 0 }),
      _updateRunArtifactPath: (p, r) => captured.push({ p, r }),
    });

    expect(result.status).toBe('completed');
    expect(result.outputs).toEqual([]);
    // updateRunArtifactPath must NOT be called when outputs is empty
    expect(captured).toHaveLength(0);
  });

  test('5. multi-output: three OUTPUT lines → all captured, DB gets JSON array of 3', async () => {
    const stdout = [
      'Exporting...',
      'OUTPUT: /exports/scene.tscn',
      'OUTPUT: /exports/resources.pck',
      'OUTPUT: /exports/audio.ogg',
      'Export complete.',
    ].join('\n') + '\n';

    const captured = [];

    const result = await runGodotScript({
      projectPath: '/tmp/fake-project',
      scriptPath: '/tmp/fake-project/batch_export.gd',
      runId: 'run-f6-005',
      _spawnFn: mockSpawn({ stdout, code: 0 }),
      _updateRunArtifactPath: (paths, runId) => captured.push({ paths, runId }),
    });

    expect(result.status).toBe('completed');
    expect(result.outputs).toHaveLength(3);
    expect(result.outputs[0]).toBe('/exports/scene.tscn');
    expect(result.outputs[1]).toBe('/exports/resources.pck');
    expect(result.outputs[2]).toBe('/exports/audio.ogg');
    expect(captured).toHaveLength(1);
    expect(captured[0].runId).toBe('run-f6-005');
    expect(JSON.parse(captured[0].paths)).toHaveLength(3);
  });
});

describe('godotHealth', () => {
  test('6. real probe: Godot 4.6.3 is installed, ok:true, version matches', async () => {
    const result = await godotHealth({ godotBin: '/usr/local/bin/godot' });

    expect(result.ok).toBe(true);
    expect(result.path).toBe('/usr/local/bin/godot');
    // Godot 4.6.3 --version returns "4.6.3.stable.official.<hash>"
    expect(result.version).toMatch(/4\.6\.\d/);
  });

  test('godotHealth: ok:false when binary does not exist', async () => {
    const result = await godotHealth({ godotBin: '/nonexistent/godot' });

    expect(result.ok).toBe(false);
    expect(result.version).toBeNull();
    expect(result.path).toBe('/nonexistent/godot');
  });
});
