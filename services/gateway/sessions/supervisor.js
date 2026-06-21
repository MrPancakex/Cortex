/**
 * Process Supervisor — crash detection, auto-restart with exponential
 * backoff, and crash-loop prevention for Cortex-owned sub-agent processes.
 * Lifted verbatim (with plane-local imports) from legacy
 * services/gateway/lib/process-supervisor.js.
 *
 * Usage:
 *   const sup = new ProcessSupervisor({ stmts });
 *   const handle = sup.spawn('nova', cmd, { cwd, env, maxRestarts: 16 });
 *   handle.stop();          // graceful SIGTERM → wait → SIGKILL
 *   sup.stopAll();          // shutdown everything
 *
 * `stmts` is the object returned by getSessionStatements(); specifically
 * the supervisor consumes `upsertAgentProcessState`. Pass null (the
 * default) to disable persistence — in-memory-only mode is fine for
 * tests that don't care about the durable state surface.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { ProcessState, DEFAULTS as CONST_DEFAULTS } from '@cortex/core/constants';
import { swallow } from '@cortex/sdk/errors';

const DEFAULTS = {
  ...CONST_DEFAULTS,
  // stopExitCodes must be a mutable local array — consumers sometimes
  // push extra codes per spawn, and ALLOWED values are always numeric.
  stopExitCodes: [...CONST_DEFAULTS.stopExitCodes],
};

/**
 * Observable persist-state helper. Returns true on success; on DB failure,
 * increments the supervisor_persist_failures counter and enqueues the
 * event onto ctx.persistQueue so a later tick (via drainPersistQueue)
 * can replay it.
 *
 * Exported for tests (supervisor.test.js).
 */
export function persistStateSafe(ctx, event) {
  if (!ctx.stmts) return true;
  try {
    ctx.stmts.upsertAgentProcessState.run(
      event.state,
      event.pid || null,
      event.unstableRestarts ?? 0,
      event.firstFailureAt || null,
      event.timestamp || Date.now(),
      event.agentId,
    );
    return true;
  } catch (err) {
    swallow('supervisor.persist_failures', err);
    if (!ctx.persistQueue) ctx.persistQueue = [];
    ctx.persistQueue.push(event);
    return false;
  }
}

/**
 * Drain any events that failed to persist on prior ticks. Successful
 * entries are removed; failures stay queued for the next heartbeat tick.
 */
export function drainPersistQueue(ctx) {
  if (!ctx.persistQueue || ctx.persistQueue.length === 0) return;
  const pending = ctx.persistQueue.slice();
  ctx.persistQueue.length = 0;
  for (const event of pending) {
    persistStateSafe(ctx, event);
  }
}

export { ProcessState };

export class SupervisedProcess {
  constructor(agentId, cmd, opts = {}) {
    this.agentId = agentId;
    this.cmd = cmd;
    this.opts = { ...DEFAULTS, ...opts };
    this.state = ProcessState.STOPPED;
    this.proc = null;
    this.pid = null;
    this.startedAt = null;
    this.unstableRestarts = 0;
    this.firstFailureAt = null;
    this.currentBackoffMs = this.opts.initialBackoffMs;
    this.restartTimer = null;
    this.killTimer = null;
    this.readyTimer = null;
    this._pendingRestart = false;
    this._onStateChange = opts.onStateChange || null;
    this._onStdout = opts.onStdout || null;
    this._onStderr = opts.onStderr || null;
    this._spawn = opts.spawn || nodeSpawn;
  }

  start() {
    if (this.state === ProcessState.ONLINE || this.state === ProcessState.LAUNCHING) return;
    this._clearTimers();
    this._transition(ProcessState.LAUNCHING);

    const [command, ...args] = this.cmd;
    try {
      this.proc = this._spawn(command, args, {
        cwd: this.opts.cwd || process.cwd(),
        env: this.opts.env || process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      this._transition(ProcessState.ERRORED, { error: `spawn failed: ${err.message}` });
      return;
    }

    this.pid = this.proc.pid;
    this.startedAt = Date.now();

    if (this.proc.stdout) {
      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', (chunk) => this._onStdout?.(chunk));
    }
    if (this.proc.stderr) {
      this.proc.stderr.setEncoding('utf8');
      this.proc.stderr.on('data', (chunk) => this._onStderr?.(chunk));
    }

    this.proc.once('error', (err) => {
      this._handleExit(-1, null, err.message);
    });

    this.proc.on('exit', (code, signal) => {
      this._handleExit(code ?? -1, signal, null);
    });

    if (this.opts.waitReady) {
      this.readyTimer = setTimeout(() => {
        if (this.state === ProcessState.LAUNCHING) {
          this._transition(ProcessState.UNHEALTHY, {
            error: `no ready signal within ${this.opts.readyTimeoutMs}ms`,
          });
        }
      }, this.opts.readyTimeoutMs);
    } else {
      this._transition(ProcessState.ONLINE);
    }
  }

  stop() {
    if (this.state === ProcessState.STOPPED || this.state === ProcessState.STOPPING) return;
    this._clearTimers();
    this._transition(ProcessState.STOPPING);

    if (!this.proc || this.proc.exitCode !== null) {
      this._transition(ProcessState.STOPPED);
      return;
    }

    this.proc.kill('SIGTERM');
    this.killTimer = setTimeout(() => {
      if (this.state === ProcessState.STOPPING && this.proc) {
        try {
          this.proc.kill('SIGKILL');
        } catch (err) {
          swallow('supervisor.sigkill_failed', err);
        }
      }
    }, this.opts.killTimeoutMs);
  }

  restart() {
    if (this.state === ProcessState.STOPPED || !this.proc) {
      this.start();
      return;
    }
    this._pendingRestart = true;
    this.stop();
  }

  /**
   * External ready signal — transitions LAUNCHING → ONLINE. Called when
   * the agent sends its first heartbeat or any other readiness proof.
   * No-op if already ONLINE or not in LAUNCHING/UNHEALTHY state.
   */
  markReady() {
    if (this.state !== ProcessState.LAUNCHING && this.state !== ProcessState.UNHEALTHY) {
      return false;
    }
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
    this._transition(ProcessState.ONLINE);
    return true;
  }

  get info() {
    return {
      agentId: this.agentId,
      state: this.state,
      pid: this.pid,
      startedAt: this.startedAt,
      unstableRestarts: this.unstableRestarts,
      firstFailureAt: this.firstFailureAt,
      currentBackoffMs: this.currentBackoffMs,
      uptime: this.startedAt && this.state === ProcessState.ONLINE
        ? Date.now() - this.startedAt
        : 0,
    };
  }

  _handleExit(code, signal, errorMsg) {
    this._clearTimers();
    const uptime = this.startedAt ? Date.now() - this.startedAt : 0;
    this.proc = null;

    if (this.state === ProcessState.STOPPING) {
      this._transition(ProcessState.STOPPED, { code, signal });
      if (this._pendingRestart) {
        this._pendingRestart = false;
        this.start();
      }
      return;
    }

    if (this.opts.stopExitCodes.includes(code)) {
      this.unstableRestarts = 0;
      this.currentBackoffMs = this.opts.initialBackoffMs;
      this._transition(ProcessState.STOPPED, { code, signal, reason: 'clean_exit' });
      return;
    }

    if (uptime < this.opts.minUptime) {
      this.unstableRestarts += 1;
      if (!this.firstFailureAt) this.firstFailureAt = Date.now();
    } else {
      this.unstableRestarts = 0;
      this.firstFailureAt = null;
      this.currentBackoffMs = this.opts.initialBackoffMs;
    }

    if (this.unstableRestarts >= this.opts.maxRestarts) {
      const errDesc = errorMsg
        || `unstable: ${this.unstableRestarts} restarts in ${Date.now() - this.firstFailureAt}ms`;
      this._transition(ProcessState.ERRORED, {
        code,
        signal,
        error: errDesc,
        unstableRestarts: this.unstableRestarts,
      });
      return;
    }

    this._transition(ProcessState.WAITING_RESTART, {
      code,
      signal,
      nextRestartIn: this.currentBackoffMs,
      unstableRestarts: this.unstableRestarts,
    });

    this.restartTimer = setTimeout(() => {
      this.start();
    }, this.currentBackoffMs);

    this.currentBackoffMs = Math.min(
      this.opts.maxBackoffMs,
      Math.floor(this.currentBackoffMs * this.opts.backoffFactor),
    );
  }

  _transition(newState, detail = {}) {
    const prev = this.state;
    this.state = newState;
    this._onStateChange?.({
      agentId: this.agentId,
      prev,
      state: newState,
      pid: this.pid,
      timestamp: Date.now(),
      ...detail,
    });
  }

  _clearTimers() {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null; }
    if (this.readyTimer) { clearTimeout(this.readyTimer); this.readyTimer = null; }
  }
}

/**
 * ProcessSupervisor — manages multiple SupervisedProcess instances and
 * persists process state via the supplied statements bag (or skips
 * persistence if stmts is null).
 */
export class ProcessSupervisor {
  constructor({ stmts = null, onStateChange = null, spawn = null } = {}) {
    this.stmts = stmts;
    this.processes = new Map();
    this._globalOnStateChange = onStateChange;
    this._spawn = spawn;
  }

  spawn(agentId, cmd, opts = {}) {
    if (this.processes.has(agentId)) {
      const existing = this.processes.get(agentId);
      if (existing.state === ProcessState.ONLINE || existing.state === ProcessState.LAUNCHING) {
        return existing;
      }
      this.processes.delete(agentId);
    }

    const supervised = new SupervisedProcess(agentId, cmd, {
      ...opts,
      spawn: opts.spawn || this._spawn || undefined,
      onStateChange: (event) => {
        this._persistState(event);
        this._globalOnStateChange?.(event);
        opts.onStateChange?.(event);
      },
    });

    this.processes.set(agentId, supervised);
    supervised.start();
    return supervised;
  }

  get(agentId) {
    return this.processes.get(agentId) || null;
  }

  markReady(agentId) {
    const proc = this.processes.get(agentId);
    if (!proc) return false;
    return proc.markReady();
  }

  stop(agentId) {
    const proc = this.processes.get(agentId);
    if (proc) proc.stop();
  }

  stopAll() {
    for (const proc of this.processes.values()) {
      proc.stop();
    }
  }

  list() {
    return Array.from(this.processes.values()).map((p) => p.info);
  }

  _persistState(event) {
    persistStateSafe(this, event);
  }

  drainPersistQueue() {
    drainPersistQueue(this);
  }
}
