/**
 * ONE-DEFINITION CONTRACT — core/schemas/_primitives.js
 *
 * This test is the mechanical guard for finding S7 from SYSTEM-AUDIT-duplication-2026-06-14.md.
 *
 * It proves that strings which would pass the previously copy-pasted `z.string().min(1)`
 * are now REJECTED by the canonical AgentIdSchema regex. It also verifies that the
 * canonical TaskIdSchema (uuid) is enforced end-to-end through a representative sample
 * of event schemas that previously had their own local TaskIdSchema declarations.
 *
 * Failure here means a re-declaration of AgentIdSchema or TaskIdSchema has drifted
 * back to the lax form — i.e. the validation hole has re-opened.
 */
import { describe, test, expect } from 'bun:test';
import { AgentIdSchema, TaskIdSchema, LegacyTaskIdSchema } from '../schemas/_primitives.js';
import { payloadSchemaFor } from '../schemas/events/index.js';

// ─── Canonical primitives ──────────────────────────────────────────────────

describe('AgentIdSchema (canonical regex)', () => {
  test('accepts valid slugs', () => {
    for (const id of ['nova', 'nova-2', 'orion', 'my_bot-99', 'a', 'a0']) {
      expect(AgentIdSchema.safeParse(id).success).toBe(true);
    }
  });

  test('rejects uppercase — would pass z.string().min(1), MUST fail the real regex', () => {
    // These are the values that z.string().min(1) accepted before S7 was fixed.
    // The real regex requires lowercase-start and only [a-z0-9_-] body.
    expect(AgentIdSchema.safeParse('NOVA').success).toBe(false);
    expect(AgentIdSchema.safeParse('Nova').success).toBe(false);
    expect(AgentIdSchema.safeParse('MyBot').success).toBe(false);
  });

  test('rejects digit-start slugs — valid under min(1), invalid under real regex', () => {
    expect(AgentIdSchema.safeParse('1nova').success).toBe(false);
    expect(AgentIdSchema.safeParse('2orion').success).toBe(false);
  });

  test('rejects UUIDs — a bearer or task id is NOT a valid agent id', () => {
    // A UUID passes z.string().min(1) trivially but is not an agent slug.
    expect(AgentIdSchema.safeParse('00000000-0000-4000-8000-000000000001').success).toBe(false);
  });

  test('rejects empty string', () => {
    expect(AgentIdSchema.safeParse('').success).toBe(false);
  });

  test('rejects slug longer than 64 chars + optional suffix', () => {
    // 65-char base (exceeds {0,63} body after the first char)
    const tooLong = 'a' + 'b'.repeat(64);
    expect(AgentIdSchema.safeParse(tooLong).success).toBe(false);
  });
});

describe('TaskIdSchema (uuid)', () => {
  test('accepts a valid UUID v4', () => {
    expect(TaskIdSchema.safeParse('00000000-0000-4000-8000-000000000001').success).toBe(true);
  });

  test('rejects a legacy-prefixed task id — uuid only', () => {
    expect(TaskIdSchema.safeParse('task_legacy-xyz').success).toBe(false);
    expect(TaskIdSchema.safeParse('not-a-uuid').success).toBe(false);
  });
});

describe('LegacyTaskIdSchema (min(1) — cost plane only)', () => {
  test('accepts a UUID', () => {
    expect(LegacyTaskIdSchema.safeParse('00000000-0000-4000-8000-000000000001').success).toBe(true);
  });

  test('accepts a legacy-prefixed id', () => {
    expect(LegacyTaskIdSchema.safeParse('task_legacy-xyz').success).toBe(true);
  });

  test('rejects empty string', () => {
    expect(LegacyTaskIdSchema.safeParse('').success).toBe(false);
  });
});

// ─── End-to-end enforcement through event schemas ─────────────────────────
//
// These tests are the non-vacuous proof: they hit the event schemas that
// PREVIOUSLY re-declared AgentIdSchema as z.string().min(1) and show that
// an agent_id invalid under the real regex is now rejected end-to-end.
//
// Covered event families: agent.*, task.*, session.*, bridge.*, gate.*,
// run.*, review.*, submission.*, verification.*, cost.*, auth.*

const VALID_UUID = '00000000-0000-4000-8000-000000000001';
const VALID_AGENT = 'nova';
const INVALID_AGENT_UPPERCASE = 'NOVA';    // passes min(1), fails real regex
const INVALID_AGENT_DIGIT_START = '2orion';  // passes min(1), fails real regex

describe('agent.* event schemas — AgentIdSchema enforced end-to-end', () => {
  const schema = payloadSchemaFor('agent.registered');

  test('accepts a valid agent_id', () => {
    expect(schema.safeParse({ agent_id: VALID_AGENT, registered_at: 0 }).success).toBe(true);
  });

  test('rejects uppercase agent_id (previously accepted by min(1))', () => {
    expect(schema.safeParse({ agent_id: INVALID_AGENT_UPPERCASE, registered_at: 0 }).success).toBe(false);
  });

  test('rejects digit-start agent_id (previously accepted by min(1))', () => {
    expect(schema.safeParse({ agent_id: INVALID_AGENT_DIGIT_START, registered_at: 0 }).success).toBe(false);
  });
});

describe('task.* event schemas — both primitives enforced', () => {
  const schema = payloadSchemaFor('task.claimed');

  test('accepts valid payload', () => {
    expect(schema.safeParse({
      task_id: VALID_UUID,
      assigned_agent: VALID_AGENT,
      claimed_at: 0,
    }).success).toBe(true);
  });

  test('rejects uppercase agent_id in assigned_agent', () => {
    expect(schema.safeParse({
      task_id: VALID_UUID,
      assigned_agent: INVALID_AGENT_UPPERCASE,
      claimed_at: 0,
    }).success).toBe(false);
  });

  test('rejects non-uuid task_id', () => {
    expect(schema.safeParse({
      task_id: 'not-a-uuid',
      assigned_agent: VALID_AGENT,
      claimed_at: 0,
    }).success).toBe(false);
  });
});

describe('session.* event schemas — AgentIdSchema enforced', () => {
  const schema = payloadSchemaFor('session.opened');

  test('rejects uppercase base_agent (previously accepted by min(1))', () => {
    expect(schema.safeParse({
      session_id: 'sess-1',
      base_agent: INVALID_AGENT_UPPERCASE,
      slot: 1,
      pid: 1234,
      opened_at: 0,
    }).success).toBe(false);
  });

  test('accepts valid base_agent', () => {
    expect(schema.safeParse({
      session_id: 'sess-1',
      base_agent: VALID_AGENT,
      slot: 1,
      pid: 1234,
      opened_at: 0,
    }).success).toBe(true);
  });
});

describe('bridge.* event schemas — AgentIdSchema enforced on agent fields', () => {
  const schema = payloadSchemaFor('bridge.sent');

  test('rejects uppercase from_agent', () => {
    expect(schema.safeParse({
      message_id: VALID_UUID,
      from_agent: INVALID_AGENT_UPPERCASE,
      to_agent: VALID_AGENT,
      sent_at: 0,
    }).success).toBe(false);
  });

  test('rejects uppercase to_agent', () => {
    expect(schema.safeParse({
      message_id: VALID_UUID,
      from_agent: VALID_AGENT,
      to_agent: INVALID_AGENT_UPPERCASE,
      sent_at: 0,
    }).success).toBe(false);
  });

  test('accepts valid payload', () => {
    expect(schema.safeParse({
      message_id: VALID_UUID,
      from_agent: VALID_AGENT,
      to_agent: 'orion',
      sent_at: 0,
    }).success).toBe(true);
  });
});

describe('gate.* event schemas — AgentIdSchema enforced', () => {
  const schema = payloadSchemaFor('gate.allowed');

  test('rejects uppercase agent_id (previously accepted by min(1))', () => {
    expect(schema.safeParse({
      agent_id: INVALID_AGENT_UPPERCASE,
      route: '/v1/tasks',
      policy: 'default',
      allowed_at: 0,
    }).success).toBe(false);
  });

  test('accepts valid agent_id', () => {
    expect(schema.safeParse({
      agent_id: VALID_AGENT,
      route: '/v1/tasks',
      policy: 'default',
      allowed_at: 0,
    }).success).toBe(true);
  });
});

describe('run.* event schemas — both primitives enforced', () => {
  const schema = payloadSchemaFor('run.started');

  test('rejects uppercase parent_agent', () => {
    expect(schema.safeParse({
      run_id: 'run-1',
      task_id: VALID_UUID,
      project_id: 'proj-1',
      provider_id: 'anthropic',
      model: 'claude-sonnet-4-6',
      parent_agent: INVALID_AGENT_UPPERCASE,
      budget: { max_tokens: 100, max_wall_seconds: 60, max_tool_calls: 10 },
    }).success).toBe(false);
  });

  test('rejects non-uuid task_id', () => {
    expect(schema.safeParse({
      run_id: 'run-1',
      task_id: 'task_legacy-xyz',
      project_id: 'proj-1',
      provider_id: 'anthropic',
      model: 'claude-sonnet-4-6',
      parent_agent: VALID_AGENT,
      budget: { max_tokens: 100, max_wall_seconds: 60, max_tool_calls: 10 },
    }).success).toBe(false);
  });
});

describe('submission.* event schemas — both primitives enforced', () => {
  const schema = payloadSchemaFor('submission.received');

  test('rejects uppercase submitter', () => {
    expect(schema.safeParse({
      task_id: VALID_UUID,
      submitter: INVALID_AGENT_UPPERCASE,
      summary: 'done',
      files_changed_count: 1,
      received_at: 0,
    }).success).toBe(false);
  });
});

describe('verification.* event schemas — both primitives enforced', () => {
  const schema = payloadSchemaFor('verification.requested');

  test('rejects uppercase reviewer_agent', () => {
    expect(schema.safeParse({
      task_id: VALID_UUID,
      project_id: 'proj-1',
      reviewer_agent: INVALID_AGENT_UPPERCASE,
      summary: null,
    }).success).toBe(false);
  });
});

describe('review.* event schemas — both primitives enforced', () => {
  const schema = payloadSchemaFor('review.requested');

  test('rejects uppercase requester', () => {
    expect(schema.safeParse({
      review_id: VALID_UUID,
      task_id: VALID_UUID,
      requester: INVALID_AGENT_UPPERCASE,
      reviewer: VALID_AGENT,
      requested_at: 0,
    }).success).toBe(false);
  });
});

describe('auth.* event schemas — AgentIdSchema enforced', () => {
  const schema = payloadSchemaFor('auth.scope_granted');

  test('rejects uppercase agent', () => {
    expect(schema.safeParse({
      grant_id: VALID_UUID,
      agent: INVALID_AGENT_UPPERCASE,
      target_scope: 'tasks:write',
      granted_by: VALID_AGENT,
      granted_at: 0,
    }).success).toBe(false);
  });

  test('accepts valid agent', () => {
    expect(schema.safeParse({
      grant_id: VALID_UUID,
      agent: VALID_AGENT,
      target_scope: 'tasks:write',
      granted_by: 'orion',
      granted_at: 0,
    }).success).toBe(true);
  });
});

describe('cost.* event schemas — LegacyTaskIdSchema intentionally stays min(1)', () => {
  const schema = payloadSchemaFor('cost.charged');

  test('still accepts legacy-prefixed task_id (relaxation is intentional)', () => {
    expect(schema.safeParse({
      agent_id: VALID_AGENT,
      task_id: 'task_legacy-xyz',
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0.001,
      charged_at: 0,
    }).success).toBe(true);
  });

  test('BUT cost.charged agent_id is now enforced by the real regex', () => {
    // cost.js previously used z.string().min(1) for AgentIdSchema too — now fixed.
    expect(schema.safeParse({
      agent_id: INVALID_AGENT_UPPERCASE,
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0.001,
      charged_at: 0,
    }).success).toBe(false);
  });
});
