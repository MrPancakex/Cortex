/**
 * Single chokepoint for "best-effort" error paths. Every catch block in
 * the codebase funnels through here so we can (a) keep a named counter
 * per swallow site, (b) log consistently, (c) expose counters at /health.
 *
 * swallow(metric, err)
 *   - metric: lowercase.dot.separated counter name ('db.run_migrations_failed')
 *   - err: the caught error (may be undefined; still increments the counter)
 *
 * Call sites that want to re-throw or gate on err.code do so inline:
 *   if (err.code !== 'ENOENT') swallow('fs.read_failed', err);
 *   swallow('db.run_migrations_failed', err); throw err;
 */
const THROW_IN_TESTS = process.env.CORTEX_THROW === '1';

const _counters = {};
const _lastErrors = {};

export function swallow(metric, err) {
  _counters[metric] = (_counters[metric] || 0) + 1;
  if (err && err.message) _lastErrors[metric] = err.message;
  const log = globalThis.__cortex_log;
  if (log) {
    try {
      log.warn(
        { metric, code: err?.code || err?.errno || null, message: err?.message, stack: err?.stack },
        'swallowed error',
      );
      // eslint-disable-next-line cortex-local/catch-has-metric -- recursive logger failure; bump counter directly to avoid re-entering swallow().
    } catch {
      _counters['logging.write_failed'] = (_counters['logging.write_failed'] || 0) + 1;
    }
  } else {
    try {
      process.stderr.write(`[${metric}] ${err?.message || ''}\n`);
      // eslint-disable-next-line cortex-local/catch-has-metric -- stderr write failure; bump counter directly to avoid re-entering swallow().
    } catch {
      _counters['logging.write_failed'] = (_counters['logging.write_failed'] || 0) + 1;
    }
  }
  if (THROW_IN_TESTS && err) throw err;
}

export function getCounters() {
  return { ..._counters, __lastErrors: { ..._lastErrors } };
}

export function resetCounters() {
  for (const k of Object.keys(_counters)) delete _counters[k];
  for (const k of Object.keys(_lastErrors)) delete _lastErrors[k];
}
