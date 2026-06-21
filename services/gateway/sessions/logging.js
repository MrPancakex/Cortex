/**
 * Per-agent log management — lifted from legacy
 * services/gateway/lib/log-manager.js. Built-in rotation, separate
 * stdout/stderr streams, and a small `listAgentLogs` helper.
 *
 * Lives in the sessions plane because agent logs are keyed by the
 * session id / base agent and the rotation cadence is driven by
 * supervisor lifecycle events (spawn → wire streams → on-exit separator).
 *
 * Rotation details:
 *   - Synchronous writes (appendFileSync) — the legacy supervisor
 *     writes small chunks per stdout line and the simplicity of
 *     sync rotation outweighs the throughput cost at expected volumes.
 *   - After ROTATION_ESCALATE_AFTER consecutive rotation failures the
 *     module writes a critical warning directly to process.stderr so
 *     operators see log-system degradation even if /health.degraded
 *     reporting is missed.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { swallow } from '@cortex/sdk/errors';

const ROTATION_ESCALATE_AFTER = 3;

const DEFAULTS = Object.freeze({
  maxSizeBytes:   10 * 1024 * 1024, // 10 MB per log file
  maxFiles:       5,                  // keep 5 rotated copies
  logDir:         null,               // must be provided or fall back to $CORTEX_HOME/logs
});

export class RotatingWriteStream {
  constructor(filePath, opts = {}) {
    this.filePath = filePath;
    this.maxSizeBytes = opts.maxSizeBytes || DEFAULTS.maxSizeBytes;
    this.maxFiles = opts.maxFiles || DEFAULTS.maxFiles;
    this.bytesWritten = 0;
    this._consecutiveFailures = 0;
    this._ensureDir();
    this._syncSize();
  }

  write(chunk) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    appendFileSync(this.filePath, buf);
    this.bytesWritten += buf.length;
    if (this.bytesWritten >= this.maxSizeBytes) {
      this._rotate();
    }
  }

  close() {
    // No-op for sync writes — exists for API compatibility.
  }

  _ensureDir() {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }

  _syncSize() {
    try {
      const stat = statSync(this.filePath);
      this.bytesWritten = stat.size;
    } catch (err) {
      // ENOENT is expected on first run; anything else is recorded.
      if (err?.code !== 'ENOENT') swallow('logging.stat_failed', err);
      this.bytesWritten = 0;
    }
  }

  _rotate() {
    let anyFailure = false;
    // Shift rotated files: .4 → delete, .3 → .4, .2 → .3, .1 → .2
    for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
      const src = `${this.filePath}.${i}`;
      const dst = `${this.filePath}.${i + 1}`;
      if (i === this.maxFiles - 1) {
        try {
          unlinkSync(src);
        } catch (err) {
          if (err?.code !== 'ENOENT') {
            anyFailure = true;
            swallow('logging.rotation_unlink_failed', err);
          }
        }
      } else {
        try {
          renameSync(src, dst);
        } catch (err) {
          if (err?.code !== 'ENOENT') {
            anyFailure = true;
            swallow('logging.rotation_rename_failed', err);
          }
        }
      }
    }
    // Current → .1, then create fresh empty file.
    try {
      renameSync(this.filePath, `${this.filePath}.1`);
    } catch (err) {
      anyFailure = true;
      swallow('logging.rotation_rename_failed', err);
    }
    try {
      writeFileSync(this.filePath, '');
    } catch (err) {
      anyFailure = true;
      swallow('logging.rotation_truncate_failed', err);
    }

    if (anyFailure) {
      swallow('logging.rotation_degraded', new Error(`rotation failed for ${this.filePath}`));
      this._consecutiveFailures += 1;
      if (this._consecutiveFailures >= ROTATION_ESCALATE_AFTER) {
        const msg = `[sessions.logging] CRITICAL: log rotation for ${this.filePath} failed ${this._consecutiveFailures} times in a row. Disk full? Permissions? Check /health.degraded.\n`;
        process.stderr.write(msg);
      }
    } else {
      this._consecutiveFailures = 0;
    }
    this.bytesWritten = 0;
  }
}

/**
 * Create a logger for an agent with separate stdout/stderr streams.
 *
 * @param {string} agentId
 * @param {{ logDir?: string, maxSizeBytes?: number, maxFiles?: number, mergeLogs?: boolean }} opts
 * @returns {{ stdout: RotatingWriteStream, stderr: RotatingWriteStream,
 *             close: () => void, writeExitSeparator: (code: number, signal: string | null) => void }}
 */
export function createAgentLogger(agentId, opts = {}) {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new Error('createAgentLogger: agentId must be a non-empty string');
  }
  const logDir = opts.logDir
    || process.env.CORTEX_LOG_DIR
    || (process.env.CORTEX_HOME ? path.join(process.env.CORTEX_HOME, 'logs', 'agents') : null);

  if (!logDir) {
    throw new Error('createAgentLogger: logDir required — set CORTEX_LOG_DIR or CORTEX_HOME');
  }
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });

  const envMaxSize = process.env.CORTEX_LOG_MAX_SIZE_MB
    ? Number(process.env.CORTEX_LOG_MAX_SIZE_MB) * 1024 * 1024
    : null;
  const maxSizeBytes = opts.maxSizeBytes || envMaxSize || DEFAULTS.maxSizeBytes;
  const envMaxFiles = process.env.CORTEX_LOG_MAX_FILES
    ? Number(process.env.CORTEX_LOG_MAX_FILES)
    : null;
  const maxFiles = opts.maxFiles || envMaxFiles || DEFAULTS.maxFiles;

  const outPath = path.join(logDir, `${agentId}-out.log`);
  const errPath = opts.mergeLogs ? outPath : path.join(logDir, `${agentId}-err.log`);

  const stdoutStream = new RotatingWriteStream(outPath, { maxSizeBytes, maxFiles });
  const stderrStream = opts.mergeLogs
    ? stdoutStream
    : new RotatingWriteStream(errPath, { maxSizeBytes, maxFiles });

  return {
    stdout: stdoutStream,
    stderr: stderrStream,
    close() {
      stdoutStream.close();
      if (!opts.mergeLogs) stderrStream.close();
    },
    writeExitSeparator(code, signal) {
      const ts = new Date().toISOString();
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      const separator = `\n--- process exited (${reason}) at ${ts} ---\n\n`;
      stderrStream.write(separator);
    },
  };
}

/**
 * List every agent log file in `logDir`. Returns newest-first by mtime.
 * Empty array when the dir doesn't exist or has no `.log` files.
 */
export function listAgentLogs(logDir) {
  if (typeof logDir !== 'string' || !existsSync(logDir)) return [];
  return readdirSync(logDir)
    .filter((f) => f.endsWith('.log'))
    .map((f) => {
      const match = f.match(/^(.+?)-(out|err)\.log(\.(\d+))?$/);
      if (!match) return null;
      const filePath = path.join(logDir, f);
      let stat;
      try {
        stat = statSync(filePath);
      } catch (err) {
        swallow('logging.list_stat_failed', err);
        return null;
      }
      return {
        agentId: match[1],
        stream: match[2],
        rotation: match[4] ? Number(match[4]) : 0,
        path: filePath,
        size: stat.size,
        modified: stat.mtime,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.modified - a.modified);
}
