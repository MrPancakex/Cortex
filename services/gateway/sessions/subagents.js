/**
 * Subagent runtime inference — lifted from
 * services/gateway/lib/subagents.js. Decides which runtime (`codex`,
 * `claude`, `generic`) a spawn request targets based on declared
 * platform, provider, model string, and subagent id.
 *
 * The supervisor (or its caller) uses the returned runtime to pick the
 * correct launcher shim. Defaults live here so a future `/v1/api/agents`
 * POST that only carries `subagentType` still resolves to a complete
 * runtime descriptor.
 *
 * Rule 1 note: the legacy module validated its default SKUs against
 * `security.ALLOWED_MODELS` at import time. That allow-list moves to
 * gate/ in Phase 7; until it lands in the rebuild tree, we surface the
 * defaults as plain constants so downstream consumers can still call
 * `defaultModelForRuntime()`. Once gate/ exists the same assertion
 * will re-land as a runtime check inside the gate evaluator.
 */

function lower(value) {
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function looksLikeCodexModel(model) {
  const normalized = lower(model);
  return normalized.startsWith('gpt-')
    || normalized.startsWith('o1')
    || normalized.startsWith('o3')
    || normalized.startsWith('o4');
}

function looksLikeClaudeModel(model) {
  return lower(model).startsWith('claude');
}

/**
 * Infer the runtime lane for a subagent spawn.
 *
 * @param {{ subagentType?: string, provider?: string, model?: string,
 *           subagentId?: string, platform?: string }} args
 * @returns {'codex' | 'claude' | 'generic'}
 */
export function inferSubagentRuntime(args = {}) {
  const normalizedType = lower(args.subagentType);
  const normalizedProvider = lower(args.provider);
  const normalizedId = lower(args.subagentId);
  const normalizedPlatform = lower(args.platform);

  if (
    normalizedType.includes('codex')
    || normalizedProvider === 'openai'
    || normalizedPlatform.includes('codex')
    || normalizedId.includes(':codex')
    || looksLikeCodexModel(args.model)
  ) {
    return 'codex';
  }

  if (
    normalizedType === 'general-purpose'
    || normalizedType.includes('claude')
    || normalizedProvider === 'anthropic'
    || normalizedPlatform.includes('claude')
    || normalizedId.includes(':claude')
    || looksLikeClaudeModel(args.model)
  ) {
    return 'claude';
  }

  return 'generic';
}

export function defaultProviderForRuntime(runtime) {
  if (runtime === 'codex') return 'openai';
  if (runtime === 'claude') return 'anthropic';
  return null;
}

// Canonical defaults per lane. Will be re-validated against the Phase 7
// gate allow-list once that ships; treat them as default values only.
const CODEX_DEFAULT_MODEL = 'gpt-5';
const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-6';

export function defaultModelForRuntime(runtime) {
  if (runtime === 'codex') return CODEX_DEFAULT_MODEL;
  if (runtime === 'claude') return CLAUDE_DEFAULT_MODEL;
  return null;
}
