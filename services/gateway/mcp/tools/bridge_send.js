import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { gatewayJson } from './_shared.js';

// Boundary-level schema — the authoritative typed-message validator lives
// gateway-side (validateTypedMessage). Here we only enforce the minimum
// required to avoid malformed requests hitting the HTTP layer.
export const BridgeSendInputSchema = z.object({
  to: z.string().min(1),
  kind: z.string().optional(),
  type: z.string().optional(),
  subject: z.string().optional(),
  content: z.string().optional(),
  body: z.string().optional(),
  task_id: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  blocking: z.boolean().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent', 'critical']).optional(),
  question_id: z.string().optional(),
  verdict: z.string().optional(),
  issues: z.array(z.record(z.unknown())).optional(),
  question: z.string().optional(),
  question_ref: z.string().optional(),
  choice: z.string().optional(),
  reasoning: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  topic: z.string().optional(),
  data: z.record(z.unknown()).optional(),
  error: z.record(z.unknown()).optional(),
  request: z.string().optional(),
  final_status: z.string().optional(),
  directive: z.string().optional(),
  revision: z.number().optional(),
  reference_task_id: z.string().optional(),
  target_session: z.string().optional(),
  sender_session: z.string().optional(),
}).passthrough();

export const definition = {
  name: 'bridge_send',
  protocolVersion: '1.0',
  description: 'Send a typed message to another agent. Types: review_request, review_verdict, task_handoff, question, answer, status_update, context_share, error_report, task_complete_notify, human_directive, text.',
  inputSchema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      kind: { type: 'string' },
      type: { type: 'string' },
      subject: { type: 'string' },
      content: { type: 'string' },
      body: { type: 'string' },
      task_id: { type: 'string' },
      context: { type: 'object' },
      blocking: { type: 'boolean' },
      priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent', 'critical'] },
      question_id: { type: 'string' },
      verdict: { type: 'string' },
      issues: { type: 'array', items: { type: 'object' } },
      question: { type: 'string' },
      question_ref: { type: 'string' },
      choice: { type: 'string' },
      reasoning: { type: 'string' },
      status: { type: 'string' },
      summary: { type: 'string' },
      topic: { type: 'string' },
      data: { type: 'object' },
      error: { type: 'object' },
      request: { type: 'string' },
      final_status: { type: 'string' },
      directive: { type: 'string' },
      revision: { type: 'number' },
      reference_task_id: { type: 'string' },
      target_session: { type: 'string' },
      sender_session: { type: 'string' },
    },
    required: ['to'],
  },
  schema: BridgeSendInputSchema,
  capability: 'bridge.send',
};

// Gateway-side BridgeSendSchema is a discriminatedUnion on `kind` with allowed
// values: message, question, answer, directive, ack, nudge. The MCP tool's
// documented surface uses `type` (richer taxonomy) + `body`. Translate at the
// boundary so the documented shape continues to work.
const TYPE_TO_KIND = {
  text: 'message',
  message: 'message',
  question: 'question',
  answer: 'answer',
  directive: 'directive',
  human_directive: 'directive',
  ack: 'ack',
  nudge: 'nudge',
};

const GATEWAY_KINDS = new Set(['message', 'question', 'answer', 'directive', 'ack', 'nudge']);

const MCP_PRIORITY_TO_GATEWAY = {
  urgent: 'high',
};

const MCP_CONTEXT_FIELDS = [
  'blocking',
  'verdict',
  'issues',
  'question',
  'question_ref',
  'choice',
  'reasoning',
  'status',
  'summary',
  'topic',
  'data',
  'error',
  'request',
  'final_status',
  'directive',
  'revision',
  'reference_task_id',
];

const CONTENT_FALLBACK_FIELDS = [
  'summary',
  'request',
  'directive',
  'question',
  'choice',
  'reasoning',
  'final_status',
  'status',
  'topic',
  'verdict',
];

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function deriveContent(args) {
  for (const field of CONTENT_FALLBACK_FIELDS) {
    if (nonEmptyString(args[field])) return args[field];
  }
  if (args.error && typeof args.error === 'object' && nonEmptyString(args.error.message)) {
    return args.error.message;
  }
  for (const field of ['data', 'error', 'issues', 'context']) {
    const value = args[field];
    if (value == null) continue;
    try {
      return JSON.stringify(value);
    } catch {
      // Ignore non-serializable fallbacks; gateway-side validation will still
      // reject if no usable content exists.
    }
  }
  return undefined;
}

function mergeTypedContext(out, source, originalType) {
  const context = out.context && typeof out.context === 'object' && !Array.isArray(out.context)
    ? { ...out.context }
    : {};
  if (originalType !== undefined && context.message_type === undefined) {
    context.message_type = originalType;
  }
  for (const field of MCP_CONTEXT_FIELDS) {
    if (source[field] !== undefined && context[field] === undefined) {
      context[field] = source[field];
    }
  }
  if (Object.keys(context).length > 0) out.context = context;
}

function translateLegacyShape(args) {
  const inputKind = args.kind;
  const hasGatewayKind = GATEWAY_KINDS.has(inputKind);
  const originalType = args.type ?? (!hasGatewayKind ? inputKind : undefined);
  const out = { ...args };
  if (out.question_id === undefined && out.question_ref !== undefined) {
    out.question_id = out.question_ref;
    delete out.question_ref;
  }
  if (originalType !== undefined) {
    const mapped = TYPE_TO_KIND[originalType];
    const kind = mapped === 'answer' && out.question_id === undefined ? 'message' : mapped ?? 'message';
    if (out.kind === undefined || !hasGatewayKind) out.kind = kind;
    // Preserve the original semantic type in subject when it doesn't map 1:1,
    // so receivers can still route on intent (review_request, task_handoff, …).
    if (out.subject === undefined && (mapped === undefined || mapped !== out.kind)) {
      out.subject = originalType;
    }
    delete out.type;
  }
  if (out.kind === undefined && (out.content !== undefined || out.body !== undefined)) {
    out.kind = 'message';
  }
  if (nonEmptyString(out.content)) {
    out.content = out.content;
  } else if (nonEmptyString(out.body)) {
    out.content = out.body;
  } else {
    const fallback = deriveContent(args);
    if (fallback !== undefined) out.content = fallback;
    else delete out.content;
  }
  delete out.body;
  if (out.priority !== undefined) {
    out.priority = MCP_PRIORITY_TO_GATEWAY[out.priority] ?? out.priority;
  }
  if (out.question_id === undefined && out.question_ref !== undefined) {
    out.question_id = out.question_ref;
  }
  if (out.kind === 'question' && !nonEmptyString(out.question_id)) {
    out.question_id = randomUUID();
  }
  mergeTypedContext(out, args, originalType);
  return out;
}

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = translateLegacyShape(parsed.data);
  if (args.sender_session == null && gateway?.config?.agentId) {
    args.sender_session = gateway.config.agentId;
  }
  return gatewayJson(gateway, '/v1/api/bridge/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(args),
  });
}
