/**
 * sdk/analysis/detect-stub.js — JS port of the bash stub-detection patterns
 * that previously lived in `.claude/hooks/cortex-report.sh` (52 lines of
 * shell regex). Phase 7 spec §7.3 lifts the logic here so both the gate
 * plane's submission guard and the hook CLI can share one implementation.
 *
 * Returns a structured finding list (rule id, line number, excerpt,
 * severity) rather than a boolean so callers make nuanced decisions:
 *   - The gate blocks on any `fatal` finding.
 *   - The progress-report hook warns on anything non-empty.
 *
 * Pure function — no I/O, no globals beyond the frozen rule table. Safe
 * to call from a tight loop; the per-rule regex is walked with an
 * explicit zero-width guard so malformed sources cannot spin forever.
 */

// ASCII-only regex sources. Literal unicode in a character class trips
// some editor + CI combinations, so patterns stay in the basic set and
// the `i` flag handles case variance.
const RULES = Object.freeze([
  {
    id: 'todo-marker',
    severity: 'warn',
    // Word-boundaried TODO/FIXME/XXX/HACK markers. The optional colon /
    // parens suffix captures the common "TODO(me):" annotation style.
    source: '\\b(?:TODO|FIXME|XXX|HACK)\\b(?:\\([^)]*\\))?\\s*[:\\-]?',
    flags: 'i',
    describe: (m) => `placeholder marker: ${m[0]}`,
  },
  {
    id: 'not-implemented',
    severity: 'fatal',
    // Language-agnostic "not implemented" throws. Covers Python's
    // NotImplementedError, JS `throw new Error('not implemented')`, Go's
    // `panic("not implemented")`, Rust's `unimplemented!()` and `todo!()`.
    source:
      '(?:raise\\s+NotImplementedError|throw\\s+new\\s+Error\\s*\\(\\s*[\'\"](?:[^\'\"]*?)(?:TODO|not\\s+implemented|unimplemented)[^\'\"]*?[\'\"]|panic\\s*\\(\\s*[\'\"](?:[^\'\"]*?)not\\s+implemented[^\'\"]*?[\'\"]|unimplemented!\\s*\\(|todo!\\s*\\()',
    flags: 'i',
    describe: (m) => `explicit not-implemented throw: ${m[0]}`,
  },
  {
    id: 'python-pass-body',
    severity: 'fatal',
    // `def foo(...):` followed on the next non-blank line by a lone `pass`.
    source: 'def\\s+\\w+\\s*\\([^)]*\\)\\s*(?:->\\s*[^:]+)?:\\s*\\n\\s*pass\\s*(?:\\n|$)',
    flags: 'm',
    describe: () => 'python function with `pass` as entire body',
  },
  {
    id: 'return-only-sentinel',
    severity: 'warn',
    // `return null` / `return undefined` / `return None` as the sole body.
    source:
      '(?:function\\s+\\w+\\s*\\([^)]*\\)\\s*\\{\\s*return\\s+(?:null|undefined)\\s*;?\\s*\\}|def\\s+\\w+\\s*\\([^)]*\\)\\s*:\\s*\\n\\s*return\\s+None\\s*(?:\\n|$))',
    flags: 'm',
    describe: () => 'function body is a single sentinel return',
  },
  {
    id: 'empty-function',
    severity: 'warn',
    // `function foo() {}`, `def foo(): pass`, or `() => {}` arrow.
    source:
      '(?:function\\s+\\w+\\s*\\([^)]*\\)\\s*\\{\\s*\\}|def\\s+\\w+\\s*\\([^)]*\\)\\s*:\\s*pass\\s*(?:\\n|$)|\\([^)]*\\)\\s*=>\\s*\\{\\s*\\})',
    flags: '',
    describe: () => 'empty function body',
  },
  {
    id: 'sentinel-identifier',
    severity: 'warn',
    // Literal sentinels in identifiers: stub, placeholder, fake, dummy.
    source: '\\b(?:stub|placeholder|fake|dummy)_?(?:impl|implementation|value|response|data)?\\b',
    flags: 'i',
    describe: (m) => `sentinel identifier: ${m[0]}`,
  },
  {
    id: 'commented-implementation',
    severity: 'warn',
    // Three or more consecutive comment-only lines — classic "commented
    // out old impl, never wrote the new one" smell.
    source: '(?:^\\s*(?://|#).*\\n){3,}',
    flags: 'm',
    describe: () => 'three or more consecutive commented-out lines',
  },
  {
    id: 'mock-api',
    severity: 'warn',
    // Jest-style mocks / route interceptors. Guards against tests that
    // assert against a fake instead of the real surface.
    source: '(?:mockResolvedValue\\s*\\(|jest\\.fn\\s*\\(\\s*\\)|route\\.fulfill\\s*\\()',
    flags: '',
    describe: (m) => `mocked API call: ${m[0]}`,
  },
]);

/**
 * Scan `source` for stub patterns.
 *
 * @param {string} source  raw file contents
 * @param {{ path?: string, rules?: string[] }} [opts]
 *        path  - optional file path (attached to each finding; purely
 *                informational, not used for matching).
 *        rules - optional allow-list of rule ids; if present only the
 *                named rules run. Unknown ids are silently ignored so a
 *                typo never masks findings from other rules.
 * @returns {Array<{ rule: string, severity: 'warn'|'fatal', line: number,
 *                   excerpt: string, message: string, path?: string }>}
 */
export function detectStub(source, opts = {}) {
  if (typeof source !== 'string' || source.length === 0) return [];
  const { path, rules: only } = opts;
  const allow = Array.isArray(only) && only.length > 0 ? new Set(only) : null;
  const findings = [];

  for (const rule of RULES) {
    if (allow && !allow.has(rule.id)) continue;
    // Force global so .exec advances lastIndex across the source; merge
    // rule's flags with 'g' (dedupe) and 's' when we need dot-all.
    const flagSet = new Set(String(rule.flags || '').split(''));
    flagSet.add('g');
    if (rule.flags && rule.flags.includes('m')) flagSet.add('s');
    const pattern = new RegExp(rule.source, Array.from(flagSet).join(''));
    let m;
    while ((m = pattern.exec(source)) !== null) {
      const upto = source.slice(0, m.index);
      const line = upto.split('\n').length;
      const excerpt = extractExcerpt(source, m.index, m[0].length);
      findings.push({
        rule: rule.id,
        severity: rule.severity,
        line,
        excerpt,
        message: rule.describe(m),
        ...(path ? { path } : {}),
      });
      // Guard against zero-width matches looping forever.
      if (m.index === pattern.lastIndex) pattern.lastIndex++;
    }
  }

  return findings;
}

/**
 * Return the single line containing the match, trimmed to at most 160 chars
 * with an ellipsis if the line is longer. Long multi-line matches collapse
 * to the first line — the full span is recoverable via the `line` field if
 * a consumer needs to re-read the source.
 */
function extractExcerpt(source, index, length) {
  const start = source.lastIndexOf('\n', index - 1) + 1;
  const endIdx = source.indexOf('\n', index + length);
  const end = endIdx === -1 ? source.length : endIdx;
  let line = source.slice(start, end).trimEnd();
  if (line.length > 160) line = `${line.slice(0, 157)}...`;
  return line;
}

/**
 * Summary helper — true iff any finding is fatal severity. Gate callers
 * that only need a block/allow answer use this instead of walking the
 * findings list themselves.
 */
export function hasFatalStub(findings) {
  return Array.isArray(findings) && findings.some((f) => f.severity === 'fatal');
}

/**
 * Introspection — exposes the frozen rule table for documentation tooling
 * and for tests that assert the rule-id list is stable across releases.
 * Callers MUST NOT mutate the result.
 */
export function listStubRules() {
  return RULES.map(({ id, severity }) => ({ id, severity }));
}
