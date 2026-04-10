/**
 * /api/model — LLM model listing and chat via Ollama
 */
const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

export default function modelRoutes() {
  return {
    async list() {
      try {
        const r = await fetch(OLLAMA_HOST + '/api/tags', { signal: AbortSignal.timeout(5000) });
        if (!r.ok) return { models: [] };
        const data = await r.json();
        return { models: (data.models || []).map(m => ({ name: m.name, size: m.size, modified: m.modified_at })) };
      } catch {
        return { models: [] };
      }
    },

    async detail(modelName) {
      try {
        const r = await fetch(OLLAMA_HOST + '/api/show', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: modelName }),
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) return { error: 'model not found' };
        return await r.json();
      } catch {
        return { error: 'ollama unavailable' };
      }
    },

    async chat(model, messages, options = {}) {
      try {
        const r = await fetch(OLLAMA_HOST + '/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model, messages, stream: false, ...options }),
          signal: AbortSignal.timeout(60000),
        });
        if (!r.ok) return { error: 'chat failed: ' + r.status };
        return await r.json();
      } catch (e) {
        return { error: 'ollama unavailable' };
      }
    },
  };
}
