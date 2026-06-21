/**
 * Prepared-statement log helpers. The gateway emits a log line per
 * privileged SQL statement so audits can replay them. We only log the bound
 * parameter arity, not values — secrets can end up in params.
 */
export function formatStatement(sql, params = []) {
  return {
    sql: sql.replace(/\s+/g, ' ').trim(),
    param_count: params.length,
  };
}

export function logStatement(logger, sql, params, { tag = 'db' } = {}) {
  logger.debug({ ...formatStatement(sql, params), tag }, 'sql');
}
