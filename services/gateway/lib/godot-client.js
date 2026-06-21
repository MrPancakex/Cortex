/**
 * Godot client — spawns `godot --headless --path <project> --script <script> --quit`
 * and records output artifact paths via slice F.1's updateRunArtifactPath.
 *
 * Godot 4.6.3 verified flags (from `godot --headless --help`):
 *   --headless  : headless mode (no display/audio)
 *   --path <dir>: path to project directory (must contain project.godot)
 *   --script <f>: run a GDScript file
 *   --quit      : quit after first iteration (defensive; script should call get_tree().quit())
 *
 * Output convention: GDScript prints `OUTPUT: <path>` lines to stdout.
 * All such lines are collected and stored as a JSON array via updateRunArtifactPath.
 *
 * NEVER throws — all errors surface as { status: 'failed', ... }.
 *
 * Slice F.6 — 2026-05-25.
 */

import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getTaskStatements } from '../tasks/statements.js';

const execFileAsync = promisify(nodeExecFile);

// -- Spawn primitive (injectable for tests) ------------------------------------

/**
 * Spawn a process and return { promise, kill }.
 * promise resolves to { stdout, stderr, code }.
 *
 * @param {string} bin
 * @param {string[]} args
 * @returns {{ promise: Promise<{stdout:string, stderr:string, code:number|null}>, kill: ()=>void }}
 */
function realSpawn(bin, args) {
  let proc;
  const promise = new Promise((resolve) => {
    proc = nodeSpawn(bin, args, { stdio: 'pipe' });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => { stdout += d.toString(); });
    proc.stderr?.on('data', (d) => { stderr += d.toString(); });
    proc.on('close', (code) => resolve({ stdout, stderr, code }));
    proc.on('error', (err) => resolve({ stdout, stderr, code: null, error: err.message }));
  });
  return { promise, kill: () => { try { proc?.kill('SIGTERM'); } catch (_) {} } };
}

// -- Output parser -------------------------------------------------------------

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

// -- Public API ----------------------------------------------------------------

/**
 * Run a Godot script headlessly and record output artifact paths.
 *
 * @param {{
 *   projectPath: string,
 *   scriptPath: string,
 *   runId?: string,
 *   godotBin?: string,
 *   timeoutMs?: number,
 *   _spawnFn?: Function,
 *   _updateRunArtifactPath?: Function|null,
 * }} params
 * @returns {Promise<{ status: 'completed'|'failed'|'timeout', outputs: string[], duration_ms: number, exit_code: number|null }>}
 */
export async function runGodotScript({
  projectPath,
  scriptPath,
  runId,
  godotBin = process.env.CORTEX_GODOT_BIN || '/usr/local/bin/godot',
  timeoutMs = 600000,
  _spawnFn = realSpawn,
  _updateRunArtifactPath = null,
} = {}) {
  const start = Date.now();

  try {
    const args = ['--headless', '--path', projectPath, '--script', scriptPath, '--quit'];
    const { promise, kill } = _spawnFn(godotBin, args);

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
      return { status: 'timeout', outputs: [], duration_ms, exit_code: null };
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

    return { status, outputs, duration_ms, exit_code: result.code ?? null };
  } catch (err) {
    return {
      status: 'failed',
      outputs: [],
      duration_ms: Date.now() - start,
      exit_code: null,
    };
  }
}

/**
 * Check whether Godot is reachable and return its version string.
 * Uses `godot --version` which works without a display server.
 *
 * @param {{ godotBin?: string }} params
 * @returns {Promise<{ ok: boolean, version: string|null, path: string }>}
 */
export async function godotHealth({ godotBin = '/usr/local/bin/godot' } = {}) {
  try {
    const { stdout } = await execFileAsync(godotBin, ['--version'], { timeout: 5000 });
    const version = stdout.trim() || null;
    return { ok: true, version, path: godotBin };
  } catch (_) {
    return { ok: false, version: null, path: godotBin };
  }
}
