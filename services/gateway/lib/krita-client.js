/**
 * Krita client — runs a Python script in Krita and records output paths.
 *
 * Krita 5.3.1 does NOT have a `--script` flag (verified via `krita --help`).
 * This client detects that at runtime and returns status:'unsupported' with
 * file-bridge documentation so callers can adapt.
 *
 * When --script IS supported (future Krita versions or injected via tests):
 *   1. Spawn `krita --script <scriptPath>` with a DISPLAY env var (GUI mode).
 *   2. Parse stdout for `OUTPUT: <path>` lines (one path per line).
 *   3. If runId + outputs, call updateRunArtifactPath(JSON.stringify(outputs), runId).
 *
 * File-bridge pattern (workaround when --script is unavailable):
 *   Drop a .py file in Krita's watched scripter directory. Krita Scripter picks
 *   it up on next open. Output paths must be written to a known file or stdout
 *   redirect. See Krita docs: Settings > Scripting > Script Manager.
 *
 * Returns: { status: 'completed'|'failed'|'timeout'|'unsupported', outputs: string[], duration_ms: number, message?: string }
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, accessSync, constants } from 'node:fs';
import { getTaskStatements } from '../tasks/statements.js';

// -- Spawn primitive (injectable for tests) -----------------------------------

/**
 * @param {string} bin
 * @param {string[]} args
 * @param {{ env?: object }} opts
 * @returns {{ promise: Promise<{stdout:string, stderr:string, code:number|null}>, kill: ()=>void }}
 */
function realSpawn(bin, args, opts = {}) {
  let proc;
  const promise = new Promise((resolve) => {
    proc = nodeSpawn(bin, args, { env: opts.env || process.env, stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.on('error', (err) => resolve({ stdout, stderr, code: null, error: err.message }));
  });
  return { promise, kill: () => { try { proc?.kill('SIGTERM'); } catch (_) {} } };
}

// -- Feature probe (injectable for tests) -------------------------------------

let _scriptFlagCache = null;

/**
 * Probe whether `krita --help` output contains `--script`.
 * Result is cached per process. Injected in tests.
 *
 * @param {string} kritaBin
 * @param {Function} spawnFn
 * @returns {Promise<boolean>}
 */
async function defaultScriptFlagProbe(kritaBin, spawnFn) {
  if (_scriptFlagCache !== null) return _scriptFlagCache;
  try {
    const display = process.env.DISPLAY || ':0';
    const { promise } = spawnFn(kritaBin, ['--help'], {
      env: { ...process.env, DISPLAY: display },
    });
    const { stdout, stderr } = await Promise.race([
      promise,
      new Promise((r) => setTimeout(() => r({ stdout: '', stderr: '' }), 5000)),
    ]);
    _scriptFlagCache = (stdout + stderr).includes('--script');
  } catch (_) {
    _scriptFlagCache = false;
  }
  return _scriptFlagCache;
}

// -- Output parser ------------------------------------------------------------

/**
 * Extract OUTPUT: <path> lines from stdout.
 *
 * @param {string} stdout
 * @returns {string[]}
 */
function parseOutputPaths(stdout) {
  const paths = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^OUTPUT:\s*(.+)$/);
    if (match) paths.push(match[1].trim());
  }
  return paths;
}

// -- Public API ---------------------------------------------------------------

/**
 * Run a Krita Python script and record output artifact paths.
 *
 * @param {{
 *   scriptPath: string,
 *   runId?: string,
 *   kritaBin?: string,
 *   timeoutMs?: number,
 *   _spawnFn?: Function,
 *   _updateRunArtifactPath?: Function|null,
 *   _scriptFlagProbe?: Function,
 * }} params
 * @returns {Promise<{ status: string, outputs: string[], duration_ms: number, message?: string }>}
 */
export async function runKritaScript({
  scriptPath,
  runId,
  kritaBin = process.env.CORTEX_KRITA_BIN || '/usr/local/bin/krita',
  timeoutMs = 300000,
  _spawnFn = realSpawn,
  _updateRunArtifactPath = null,
  _scriptFlagProbe = defaultScriptFlagProbe,
}) {
  const start = Date.now();

  try {
    // Feature gate: --script not available in Krita 5.3.1
    const supportsScript = await _scriptFlagProbe(kritaBin, _spawnFn);
    if (!supportsScript) {
      return {
        status: 'unsupported',
        outputs: [],
        duration_ms: Date.now() - start,
        message:
          'Krita --script flag is not available in this version. ' +
          'Use the file-bridge pattern: drop your .py script into the Krita ' +
          'Scripter watched directory (Settings > Scripting > Script Manager) ' +
          'and launch Krita normally. Write output paths as "OUTPUT: <path>" ' +
          'lines to stdout or a known sidecar file.',
      };
    }

    const display = process.env.DISPLAY || ':0';
    const { promise, kill } = _spawnFn(kritaBin, ['--script', scriptPath], {
      env: { ...process.env, DISPLAY: display },
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    let result;
    try {
      result = await promise;
    } finally {
      clearTimeout(timer);
    }

    const duration_ms = Date.now() - start;

    if (timedOut) {
      return { status: 'timeout', outputs: [], duration_ms };
    }

    const outputs = parseOutputPaths(result.stdout || '');
    const status = result.code === 0 ? 'completed' : 'failed';

    if (runId && outputs.length > 0) {
      try {
        const updateFn = _updateRunArtifactPath
          ?? getTaskStatements().updateRunArtifactPath?.run?.bind(
              getTaskStatements().updateRunArtifactPath
            );
        if (updateFn) updateFn(JSON.stringify(outputs), runId);
      } catch (_) {}
    }

    return { status, outputs, duration_ms };
  } catch (err) {
    return {
      status: 'failed',
      outputs: [],
      duration_ms: Date.now() - start,
      message: err?.message ?? String(err),
    };
  }
}

/**
 * Check whether Krita is reachable on disk.
 *
 * Note: `krita --version` aborts without a display; health is disk-only.
 *
 * @param {{ kritaBin?: string }} params
 * @returns {{ ok: boolean, version: string|null, path: string }}
 */
export function kritaHealth({ kritaBin = '/usr/local/bin/krita' } = {}) {
  try {
    accessSync(kritaBin, constants.X_OK);
    return { ok: true, version: null, path: kritaBin };
  } catch (_) {
    return { ok: false, version: null, path: kritaBin };
  }
}
