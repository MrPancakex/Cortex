/**
 * Unified cost table. Pricing is per 1M tokens (USD) to stay consistent with
 * provider pricing pages. Consumers divide by 1_000_000 before multiplying
 * by token counts.
 *
 * Keys MUST match the exact model id reported by the provider; aliases live
 * in MODEL_ALIASES so we can normalise before lookup.
 */
export const MODEL_COST_TABLE = Object.freeze({
  // Anthropic
  'claude-opus-4-7': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  'claude-sonnet-4-7': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  'claude-haiku-4-7': { input: 0.8, output: 4, cache_write: 1, cache_read: 0.08 },
  // Anthropic — current (2026) ids actually emitted in usage logs; tier pricing
  // matches the -4-7 family (Opus/Sonnet/Haiku rates are stable across point releases).
  'claude-opus-4-8': { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  'claude-haiku-4-5': { input: 0.8, output: 4, cache_write: 1, cache_read: 0.08 },
  // Fable 5 — published per-token pricing UNCONFIRMED; ESTIMATE at sonnet tier,
  // revise when Anthropic publishes rates. (Cost is notional under flat-plan OAuth.)
  'claude-fable-5': { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },

  // OpenAI
  'gpt-5': { input: 5, output: 20, cache_write: 6.25, cache_read: 0.5 },
  'gpt-5-mini': { input: 0.3, output: 1.2, cache_write: 0.375, cache_read: 0.03 },
  o4: { input: 15, output: 60, cache_write: 18.75, cache_read: 1.5 },

  // Google
  'gemini-3-pro': { input: 3.5, output: 14, cache_write: 4.375, cache_read: 0.35 },
  'gemini-3-flash': { input: 0.15, output: 0.6, cache_write: 0.1875, cache_read: 0.015 },

  // Local / zero-cost
  local: { input: 0, output: 0, cache_write: 0, cache_read: 0 },
});

export const MODEL_ALIASES = Object.freeze({
  // bare aliases point at the current (2026) tier ids
  'claude-opus': 'claude-opus-4-8',
  'claude-sonnet': 'claude-sonnet-4-6',
  'claude-haiku': 'claude-haiku-4-5',
  // exact provider ids that carry a date suffix
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  gpt5: 'gpt-5',
  'gemini-pro': 'gemini-3-pro',
  'gemini-flash': 'gemini-3-flash',
});

export function resolveModel(id) {
  if (!id || typeof id !== 'string') return null;
  const normalized = id.toLowerCase();
  return MODEL_ALIASES[normalized] || normalized;
}

export function costFor(modelId) {
  const resolved = resolveModel(modelId);
  return resolved ? MODEL_COST_TABLE[resolved] || null : null;
}
