import { describe, test, expect } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  resolveRuntimeDir,
  activeProjectPath,
  writeActiveProject,
  clearActiveProject,
} from '../sessions/runtime-config.js';

const RUNTIME = path.join(os.tmpdir(), `cortex-sessions-test-${process.pid}`);

function gateway(overrides = {}) {
  return { config: { agentId: 'nova-4', runtimeDir: RUNTIME, ...overrides } };
}

describe('runtime-config', () => {
  test('resolveRuntimeDir prefers runtimeDir, falls back to currentTaskFile dir, then /tmp', () => {
    expect(resolveRuntimeDir(gateway())).toBe(RUNTIME);
    expect(
      resolveRuntimeDir({
        config: { agentId: 'a', currentTaskFile: '/var/run/cortex/x-current-task' },
      }),
    ).toBe('/var/run/cortex');
    expect(resolveRuntimeDir({ config: { agentId: 'a' } })).toBe('/tmp');
  });

  test('activeProjectPath joins runtime dir with <agentId>-active-project', () => {
    expect(activeProjectPath(gateway())).toBe(path.join(RUNTIME, 'nova-4-active-project'));
  });

  test('writeActiveProject + clearActiveProject round-trip', async () => {
    const target = await writeActiveProject(gateway(), 'project-xyz');
    expect(fs.readFileSync(target, 'utf8')).toBe('project-xyz\n');
    await clearActiveProject(gateway());
    expect(fs.existsSync(target)).toBe(false);
  });

  test('mustGetAgentId throws when agentId missing', async () => {
    await expect(writeActiveProject({ config: {} }, 'x')).rejects.toThrow(
      /agent_id not configured/,
    );
  });
});
