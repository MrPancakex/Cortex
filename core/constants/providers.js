/**
 * Provider routing table + Ollama host. Lifted verbatim from
 * `services/gateway/lib/proxy.js:33-45` so Phase 9 (proxy plane) can import
 * the canonical route list from `@cortex/core/constants` instead of
 * duplicating it inline.
 *
 * Each entry maps a URL prefix to an upstream provider + absolute target.
 * The gateway prepends `/agent/{name}/` to this prefix for auto-tagging.
 */
export const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

export const PROVIDER_ROUTES = Object.freeze([
  { prefix: '/v1/messages',          provider: 'anthropic',  target: 'https://api.anthropic.com/v1/messages' },
  { prefix: '/v1/responses',         provider: 'openai',     target: 'https://api.openai.com/v1/responses' },
  { prefix: '/v1/chat/completions',  provider: 'openai',     target: 'https://api.openai.com/v1/chat/completions' },
  { prefix: '/v1/completions',       provider: 'openai',     target: 'https://api.openai.com/v1/completions' },
  { prefix: '/v1/embeddings',        provider: 'openai',     target: 'https://api.openai.com/v1/embeddings' },
  { prefix: '/api/chat',             provider: 'ollama',     target: `${OLLAMA_HOST}/api/chat` },
  { prefix: '/api/generate',         provider: 'ollama',     target: `${OLLAMA_HOST}/api/generate` },
  { prefix: '/api/tags',             provider: 'ollama',     target: `${OLLAMA_HOST}/api/tags` },
  { prefix: '/openrouter/v1/',       provider: 'openrouter', target: 'https://openrouter.ai/api/v1/' },
]);

/**
 * Provider metadata — secondary surface used by credentials loading and
 * cost attribution. Not a Phase 1 contract requirement, but consumers
 * (sdk/auth/credentials.js, gateway/proxy/cost.js) may read it.
 */
export const PROVIDERS = Object.freeze({
  anthropic: {
    id: 'anthropic',
    display: 'Anthropic',
    env: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    base_url: 'https://api.anthropic.com',
    auth_header: 'x-api-key',
  },
  openai: {
    id: 'openai',
    display: 'OpenAI',
    env: ['OPENAI_API_KEY'],
    base_url: 'https://api.openai.com/v1',
    auth_header: 'authorization',
    auth_prefix: 'Bearer ',
  },
  openrouter: {
    id: 'openrouter',
    display: 'OpenRouter',
    env: ['OPENROUTER_API_KEY'],
    base_url: 'https://openrouter.ai/api/v1',
    auth_header: 'authorization',
    auth_prefix: 'Bearer ',
  },
  google: {
    id: 'google',
    display: 'Google',
    env: ['GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    base_url: 'https://generativelanguage.googleapis.com/v1beta',
    auth_header: 'x-goog-api-key',
  },
  ollama: {
    id: 'ollama',
    display: 'Ollama',
    env: [],
    base_url: OLLAMA_HOST,
    auth_header: null,
  },
  local: {
    id: 'local',
    display: 'Local',
    env: [],
    base_url: OLLAMA_HOST,
    auth_header: null,
  },
});

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

export function getProvider(id) {
  return PROVIDERS[id] || null;
}
