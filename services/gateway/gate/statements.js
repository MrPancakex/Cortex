/**
 * Prepared-statement map for the gate plane. Covers:
 *   - gate_policies (select/upsert/delete)
 *   - gate_permissions (find/grant/revoke/list)
 *   - gate_registry_snapshot (read/upsert — auth middleware path)
 *   - task.rejection_count read for max-rejections.js
 *
 * Lazy-constructed on first access with the auto-invalidate pattern
 * from bridge/statements.js: if a test rotates the underlying DB handle
 * via resetDbForTests() + a fresh getDb({path:...}), the cache detects
 * the handle swap and rebuilds rather than silently issuing statements
 * bound to a stale (possibly unlinked) file.
 */

import { getDb, createStatements } from '@cortex/sdk/db';

const SPECS = [
  // -- gate_policies -------------------------------------------------------
  {
    name: 'listEnabledPolicies',
    sql: `SELECT id, description, direction, action, subject_json, resource_json,
                 effect, rate_limit_json, reason_code, priority, enabled,
                 created_at, updated_at
            FROM gate_policies
           WHERE enabled = 1
           ORDER BY priority ASC, id ASC`,
  },
  {
    name: 'listAllPolicies',
    sql: `SELECT id, description, direction, action, subject_json, resource_json,
                 effect, rate_limit_json, reason_code, priority, enabled,
                 created_at, updated_at
            FROM gate_policies
           ORDER BY priority ASC, id ASC`,
  },
  {
    name: 'getPolicy',
    sql: `SELECT id, description, direction, action, subject_json, resource_json,
                 effect, rate_limit_json, reason_code, priority, enabled,
                 created_at, updated_at
            FROM gate_policies
           WHERE id = ?`,
  },
  {
    name: 'upsertPolicy',
    sql: `INSERT INTO gate_policies
            (id, description, direction, action, subject_json, resource_json,
             effect, rate_limit_json, reason_code, priority, enabled,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            description     = excluded.description,
            direction       = excluded.direction,
            action          = excluded.action,
            subject_json    = excluded.subject_json,
            resource_json   = excluded.resource_json,
            effect          = excluded.effect,
            rate_limit_json = excluded.rate_limit_json,
            reason_code     = excluded.reason_code,
            priority        = excluded.priority,
            enabled         = excluded.enabled,
            updated_at      = excluded.updated_at`,
  },
  {
    name: 'deletePolicy',
    sql: `DELETE FROM gate_policies WHERE id = ?`,
  },

  // -- gate_permissions ----------------------------------------------------
  //
  // resource_kind / resource_id are stored as the literal '*' sentinel
  // when the grant is unscoped (permissions.js normalises null -> '*'
  // at the boundary). SQLite's PRIMARY KEY treats NULL columns as
  // always-distinct, so the sentinel is required for the ON CONFLICT
  // upsert to fire on repeat grants of the same unscoped tuple. The
  // repeat parameter (?  ?) in each predicate is kept to match the
  // 6-arg API shape the caller expects — both bindings receive the
  // same value after normalisation.
  {
    name: 'findPermission',
    sql: `SELECT subject_id, permission, resource_kind, resource_id,
                 granted_at, expires_at
            FROM gate_permissions
           WHERE subject_id = ?
             AND permission = ?
             AND (resource_kind = ? OR resource_kind = ?)
             AND (resource_id = ? OR resource_id = ?)
           LIMIT 1`,
  },
  {
    name: 'grantPermission',
    sql: `INSERT INTO gate_permissions
            (subject_id, permission, resource_kind, resource_id, granted_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(subject_id, permission, resource_kind, resource_id) DO UPDATE SET
            expires_at = excluded.expires_at,
            granted_at = excluded.granted_at`,
  },
  {
    name: 'revokePermission',
    sql: `DELETE FROM gate_permissions
           WHERE subject_id = ?
             AND permission = ?
             AND (resource_kind = ? OR resource_kind = ?)
             AND (resource_id = ? OR resource_id = ?)`,
  },
  {
    name: 'listPermissionsForSubject',
    sql: `SELECT subject_id, permission, resource_kind, resource_id,
                 granted_at, expires_at
            FROM gate_permissions
           WHERE subject_id = ?
           ORDER BY permission ASC, resource_id ASC`,
  },

  // -- gate_registry_snapshot ---------------------------------------------
  {
    name: 'getRegistrySnapshot',
    sql: `SELECT json, updated_at FROM gate_registry_snapshot WHERE id = 1`,
  },
  {
    name: 'upsertRegistrySnapshot',
    sql: `INSERT INTO gate_registry_snapshot (id, json, updated_at)
          VALUES (1, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            json = excluded.json,
            updated_at = excluded.updated_at`,
  },

  // -- tasks (read-only) --------------------------------------------------
  //
  // max-rejections.js reads the per-task rejection_count column the tasks
  // plane writes via incrementRejectionCount. Using a dedicated statement
  // here keeps the gate plane's access pattern explicit (and greppable via
  // scripts/lint/no-inline-sql.sh when that lint lands).
  {
    name: 'getTaskRejectionCount',
    sql: `SELECT COALESCE(rejection_count, 0) AS count FROM tasks WHERE id = ?`,
  },
];

let _cached = null;
let _cachedDb = null;

export function getGateStatements() {
  const db = getDb();
  if (_cached && _cachedDb === db) return _cached;
  _cached = createStatements(db, SPECS);
  _cachedDb = db;
  return _cached;
}

export function resetGateStatementsForTests() {
  _cached = null;
  _cachedDb = null;
}
