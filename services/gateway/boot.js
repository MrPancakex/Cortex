/**
 * Gateway boot helpers. Collects the "run this once at startup" wiring
 * that used to live in the legacy server.js. The rebuild's gateway is
 * shipped as a library — an explicit composer (future phase) calls
 * `bootGateway()` after migrations run so it's the single place that
 * knows every startup side effect.
 *
 * Responsibilities:
 *   - drain the on-disk recovery buffer via `recoverBufferedEvents()`
 *     so events queued during a prior DB outage land before any new
 *     traffic races them (ultrareview lens 6 C2).
 *   - install process-level unhandledRejection / uncaughtException
 *     handlers that bump a swallow counter and log — previously only
 *     the cortex-channel plugin did this, so async escapes from timers
 *     and subscribers in the gateway + platform disappeared silently
 *     (ultrareview lens 6 C3).
 *
 * All handlers are idempotent: calling `bootGateway()` twice does not
 * install duplicate process handlers or double-drain the buffer.
 */

import { swallow } from '@cortex/sdk/errors';
import { recoverBufferedEvents } from '@cortex/sdk/events';

let _processHandlersInstalled = false;
let _bootRecoveryStarted = false;
let _sighupReloadHandler = null;
let _sighupHandlerInstalled = false;

/**
 * Perform gateway-boot side effects. Safe to call more than once —
 * only the first call actually mutates process state.
 *
 * @param {{ installProcessHandlers?: boolean, drainRecovery?: boolean,
 *           onSighup?: () => unknown }} [opts]
 * @returns {Promise<{ recovery: { drained: number, failed: number } | null,
 *                     processHandlersInstalled: boolean }>}
 */
export async function bootGateway(opts = {}) {
  const { installProcessHandlers = true, drainRecovery = true, onSighup = null } = opts;
  let recovery = null;
  let handlers = false;

  if (installProcessHandlers) {
    handlers = installUnhandledHandlers();
    installSighupHandler(onSighup);
  }

  if (drainRecovery && !_bootRecoveryStarted) {
    _bootRecoveryStarted = true;
    try {
      recovery = await recoverBufferedEvents();
    } catch (err) {
      // recoverBufferedEvents swallows internally; this catches any
      // ungovernable throw (disk pull, permission denied after we
      // acquired the DB handle) so boot still completes.
      swallow('gateway.boot_recovery_failed', err);
      // Match recoverBufferedEvents' actual return shape ({drained, kept})
      // so consumers reading `recovery.kept` don't land on undefined.
      recovery = { drained: 0, kept: 0 };
    }
  }

  return { recovery, processHandlersInstalled: handlers };
}

function installUnhandledHandlers() {
  if (_processHandlersInstalled) return false;
  if (typeof process === 'undefined' || typeof process.on !== 'function') return false;

  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    swallow('process.unhandled_rejection', err);
  });
  process.on('uncaughtException', (err) => {
    swallow('process.uncaught_exception', err);
    // Deliberate: do NOT exit(1). The legacy server used to crash-loop
    // on unrelated plane failures. Counter growth on /health is the
    // signal; operators decide when to restart.
  });

  _processHandlersInstalled = true;
  return true;
}

function installSighupHandler(onSighup) {
  if (typeof onSighup === 'function') {
    _sighupReloadHandler = onSighup;
  }
  if (_sighupHandlerInstalled) return false;
  if (typeof process === 'undefined' || typeof process.on !== 'function') return false;

  process.on('SIGHUP', () => dispatchSighupReload());
  _sighupHandlerInstalled = true;
  return true;
}

function dispatchSighupReload() {
  if (typeof _sighupReloadHandler !== 'function') return null;
  try {
    const result = _sighupReloadHandler();
    if (result && typeof result.then === 'function') {
      result.catch((err) => swallow('gateway.sighup_reload_failed', err));
    }
    return result;
  } catch (err) {
    swallow('gateway.sighup_reload_failed', err);
    return null;
  }
}

export function dispatchSighupReloadForTests() {
  return dispatchSighupReload();
}

// Testing seams — bun:test beforeEach can wipe both flags so a new
// test run observes a clean slate without needing to spawn a subprocess.
export function resetBootForTests() {
  _bootRecoveryStarted = false;
  _sighupReloadHandler = null;
  // `_processHandlersInstalled` deliberately stays true across tests:
  // Node's `process.on` is the same object for the lifetime of the
  // runner, so reinstalling across test files would stack handlers
  // and leak across specs. The tests that care drive the install
  // directly via `installUnhandledHandlers()` return value.
}
