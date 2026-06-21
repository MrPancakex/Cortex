/**
 * Gateway runtime reload surface — PUBLIC (lean) variant.
 *
 * Identical to runtime-reload.js minus the router-plane rule-refresh edge
 * (the router rules-cache import) and its ruleHydration result field — the
 * router plane is cut from the public skeleton. The export pipeline (Plan E)
 * renames this file to runtime-reload.js.
 *
 * Used by SIGHUP to refresh file-backed auth state after operator
 * changes without assuming a full process restart is the only safe path.
 */

import { loadTokenRegistryFile } from '@cortex/sdk/auth';
import { swallow } from '@cortex/sdk/errors';
import { writeRegistrySnapshot } from './gate/auth-middleware.js';
import { reloadMatrix } from './auth/check.js';
import { reload as reloadScopeConfig } from './auth/scope-config.js';
import { refreshPolicies, policyCacheSize } from './gate/policies.js';

export function reloadGatewayRuntimeState(opts = {}) {
  const result = {
    registryHydration: { agents: 0, error: null },
    matrixReload: { ok: false, error: null },
    scopeConfigReload: { ok: false, error: null },
    policyHydration: { count: 0, version: null, error: null },
  };

  try {
    const registry = opts.authRegistry?.snapshot
      ?? loadTokenRegistryFile({ path: opts.authRegistry?.path });
    writeRegistrySnapshot(registry);
    result.registryHydration = {
      agents: Object.keys(registry.agents || {}).length,
      error: null,
    };
  } catch (err) {
    swallow('gateway.reload_registry_failed', err);
    result.registryHydration = { agents: 0, error: err.message };
  }

  try {
    reloadMatrix(opts.matrixPath);
    result.matrixReload = { ok: true, error: null };
  } catch (err) {
    swallow('gateway.reload_matrix_failed', err);
    result.matrixReload = { ok: false, error: err.message };
  }

  try {
    reloadScopeConfig();
    result.scopeConfigReload = { ok: true, error: null };
  } catch (err) {
    swallow('gateway.reload_scope_config_failed', err);
    result.scopeConfigReload = { ok: false, error: err.message };
  }

  try {
    const version = refreshPolicies();
    result.policyHydration = {
      count: policyCacheSize(),
      version,
      error: null,
    };
  } catch (err) {
    swallow('gateway.reload_policies_failed', err);
    result.policyHydration = { count: 0, version: null, error: err.message };
  }

  return result;
}
