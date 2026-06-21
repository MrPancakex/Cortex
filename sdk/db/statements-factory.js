/**
 * Prepared-statement factory. Accepts a bun:sqlite Database handle and an
 * array of `{ name, sql }` specs, validates the inputs, and returns a
 * frozen `{ [name]: Statement }` map.
 *
 * Per-plane statements modules (Phase 4+) use this as their construction
 * primitive so each plane's statement bag has a single shape and lifts
 * duplicate-name and shape-validation concerns out of the plane files.
 */

/**
 * @typedef {{ name: string, sql: string }} StatementSpec
 */

/**
 * @param {{ prepare: (sql: string) => unknown }} db
 *   bun:sqlite Database instance (or any handle that exposes `.prepare`).
 * @param {ReadonlyArray<StatementSpec>} specs
 * @returns {Readonly<Record<string, unknown>>}
 *   frozen map from statement name to the prepared Statement
 */
const ALLOWED_SPEC_KEYS = new Set(['name', 'sql']);

// Names that would collide with Object.prototype accessors or builtin
// methods on the returned map. Accepting them would silently shadow real
// methods (constructor / toString / hasOwnProperty) or — in the case of
// `__proto__` — attempt to mutate the prototype chain instead of setting
// an own property. All three failure modes hide real bugs, so reject at
// construction time with a clear message.
const RESERVED_STATEMENT_NAMES = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toString',
  'hasOwnProperty',
]);

export function createStatements(db, specs) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('createStatements: db must expose a prepare() method');
  }
  if (!Array.isArray(specs)) {
    throw new Error('createStatements: specs must be an array of { name, sql }');
  }
  // Object.create(null) — no prototype means name='__proto__' sets an own
  // property instead of triggering the prototype-chain assignment path,
  // and Object.keys(stmts) can never surface a builtin method name by
  // accident.
  const out = Object.create(null);
  const seen = new Set();
  for (const spec of specs) {
    if (!spec
      || typeof spec.name !== 'string'
      || spec.name.length === 0
      || typeof spec.sql !== 'string'
      || spec.sql.trim().length === 0) {
      throw new Error(
        'createStatements: each spec must be { name: non-empty string, sql: non-empty string }',
      );
    }
    // Reject typos like `sqll:` — the plane files that drive this factory
    // control every spec literal, so any extra key is an error.
    for (const key of Object.keys(spec)) {
      if (!ALLOWED_SPEC_KEYS.has(key)) {
        throw new Error(
          `createStatements: spec "${spec.name}" has unknown key "${key}" (allowed: name, sql)`,
        );
      }
    }
    if (RESERVED_STATEMENT_NAMES.has(spec.name)) {
      throw new Error(
        `createStatements: statement name "${spec.name}" is reserved (would shadow builtin)`,
      );
    }
    if (seen.has(spec.name)) {
      throw new Error(`createStatements: duplicate statement name "${spec.name}"`);
    }
    seen.add(spec.name);
    out[spec.name] = db.prepare(spec.sql);
  }
  return Object.freeze(out);
}
