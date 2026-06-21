import { z } from 'zod';
import { safeJsonParse } from '@cortex/sdk/http';

export const RouteRequestInputSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  messages: z.array(z.record(z.unknown())).min(1),
  max_tokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
});

export const definition = {
  name: 'route_request',
  protocolVersion: '1.0',
  description: 'Route a model request through the gateway proxy.',
  inputSchema: {
    type: 'object',
    properties: {
      provider: { type: 'string' },
      model: { type: 'string' },
      messages: { type: 'array', items: { type: 'object' } },
      max_tokens: { type: 'number' },
      temperature: { type: 'number' },
    },
    required: ['provider', 'model', 'messages'],
  },
  schema: RouteRequestInputSchema,
  capability: 'route.request',
};

export async function handler(args, gateway) {
  const parsedInput = definition.schema.safeParse(args);
  if (!parsedInput.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsedInput.error.issues };
  }
  args = parsedInput.data;
  const { provider, model, messages, max_tokens = 4096, temperature = 0.7 } = args;

  const routeMap = {
    anthropic: '/v1/messages',
    openai: '/v1/chat/completions',
    openrouter: '/openrouter/v1/chat/completions',
    ollama: '/v1/api/chat',
  };
  const targetPath = routeMap[provider];
  if (!targetPath) throw new Error(`unsupported provider: ${provider}`);

  const headers = { 'content-type': 'application/json' };
  if (gateway.config.agentToken) headers['x-cortex-token'] = gateway.config.agentToken;

  const body = provider === 'anthropic'
    ? { model, messages, max_tokens, temperature }
    : provider === 'ollama'
      ? { model, messages, options: { temperature }, stream: false }
      : { model, messages, max_tokens, temperature };

  const response = await fetch(`${gateway.config.gatewayUrl}${targetPath}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = safeJsonParse(text, text, 'route_request');
  if (!response.ok) {
    throw new Error(typeof parsed === 'object' ? JSON.stringify(parsed) : String(parsed));
  }
  return parsed;
}
