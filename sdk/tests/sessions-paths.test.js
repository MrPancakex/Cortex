import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRunDir, leasePath } from '../sessions/paths.js';

// Test file lives at sdk/tests/sessions-paths.test.js. Rebuild root is
// two levels up. Keep this derivation parallel to paths.js's own
// resolution so a future breakage of one surfaces the same way in both.
const REBUILD_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  delete process.env.CORTEX_RUN_DIR;
  delete process.env.CORTEX_HOME;
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('defaultRunDir', () => {
  test('CORTEX_RUN_DIR takes precedence', () => {
    process.env.CORTEX_RUN_DIR = '/explicit/run/dir';
    expect(defaultRunDir()).toBe('/explicit/run/dir');
  });

  test('CORTEX_HOME is next precedence', () => {
    process.env.CORTEX_HOME = '/opt/cortex';
    expect(defaultRunDir()).toBe(path.join('/opt/cortex', 'data', 'run'));
  });

  test('repo-relative fallback resolves to an absolute path ending in data/run', () => {
    const result = defaultRunDir();
    expect(path.isAbsolute(result)).toBe(true);
    expect(result.endsWith(path.join('data', 'run'))).toBe(true);
  });

  test('repo-relative fallback anchors to the Cortex-Rebuild root', () => {
    const result = defaultRunDir();
    // Strip the trailing 'data/run' and compare against the rebuild root.
    // If paths.js's ".." count drifts, result will point to the wrong
    // anchor and this assertion fails.
    const anchor = path.dirname(path.dirname(result));
    expect(anchor).toBe(REBUILD_ROOT);
  });
});

describe('leasePath', () => {
  test('builds the canonical lease file path for a slot', () => {
    expect(leasePath('/run/dir', 'nova', 1)).toBe('/run/dir/nova-1.session.json');
    expect(leasePath('/run/dir', 'nova', 2)).toBe('/run/dir/nova-2.session.json');
  });
});
