/**
 * Process lifecycle surface. Lifted verbatim from
 * `services/gateway/lib/process-supervisor.js:55-75` so Phase 6 sessions
 * plane can import `ProcessState` and `DEFAULTS` from a single canonical
 * location rather than reaching into the gateway's private lib.
 */

/**
 * Process lifecycle states. Pure data, no external dependency.
 */
export const ProcessState = Object.freeze({
  LAUNCHING:        'launching',
  ONLINE:           'online',
  STOPPING:         'stopping',
  STOPPED:          'stopped',
  WAITING_RESTART:  'waiting_restart',
  ERRORED:          'errored',
  UNHEALTHY:        'unhealthy',       // spawned but never sent ready signal
});

/**
 * Supervisor defaults. Override per-spawn via the SupervisedProcess opts.
 */
export const DEFAULTS = Object.freeze({
  maxRestarts:         16,      // unstable restarts before ERRORED
  minUptime:           1000,    // ms — exits before this count as unstable
  initialBackoffMs:    500,     // first backoff delay
  backoffFactor:       1.5,     // exponential multiplier
  maxBackoffMs:        15_000,  // cap
  killTimeoutMs:       8_000,   // SIGTERM → SIGKILL grace period
  stopExitCodes:       Object.freeze([0]),
  waitReady:           false,   // if true, stay LAUNCHING until markReady() called
  readyTimeoutMs:      30_000,  // max time to wait for ready before UNHEALTHY
});
