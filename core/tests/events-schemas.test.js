import { describe, test, expect } from 'bun:test';
import {
  EventEnvelopeSchema,
  EventPayloadMap,
  payloadSchemaFor,
  FindingSchema,
} from '../schemas/events/index.js';

describe('EventEnvelopeSchema', () => {
  test('accepts a well-formed envelope', () => {
    const ok = EventEnvelopeSchema.safeParse({
      id: '11111111-2222-4333-8444-555555555555',
      subject: 'task.claimed',
      ts: 1700000000000,
      source: 'cortex',
      payload: {},
      v: 1,
    });
    expect(ok.success).toBe(true);
  });

  test('rejects a subject that is not lowercase.dotted', () => {
    const bad = EventEnvelopeSchema.safeParse({
      id: '11111111-2222-4333-8444-555555555555',
      subject: 'Task.Claimed',
      ts: 1,
      source: 'cortex',
      payload: {},
      v: 1,
    });
    expect(bad.success).toBe(false);
  });

  test('rejects a v!=1 envelope so schema drift is explicit', () => {
    const bad = EventEnvelopeSchema.safeParse({
      id: '11111111-2222-4333-8444-555555555555',
      subject: 'task.claimed',
      ts: 1,
      source: 'cortex',
      payload: {},
      v: 2,
    });
    expect(bad.success).toBe(false);
  });
});

describe('EventPayloadMap taxonomy', () => {
  test('exposes every subject from the spec §3.8 taxonomy (+ Phase 5 additions)', () => {
    const expected = [
      // task.* (17 as of Phase 5 — spec §3.8 base 11 + Phase 5 additions:
      //   task.resumed, task.orphan_claimed, task.updated, task.released,
      //   task.reassigned, task.comment)
      'task.created', 'task.claimed', 'task.resumed', 'task.progressed', 'task.submitted',
      'task.review_requested', 'task.reviewed', 'task.approved',
      'task.rejected', 'task.orphaned', 'task.orphan_claimed',
      'task.reopened', 'task.canceled',
      'task.updated', 'task.released', 'task.reassigned', 'task.comment',
      // session.* (4)
      'session.opened', 'session.heartbeat', 'session.expired', 'session.closed',
      // agent.* (3)
      'agent.registered', 'agent.updated', 'agent.stale',
      // bridge.* (4)
      'bridge.sent', 'bridge.delivered', 'bridge.read', 'bridge.replied',
      // review.* (4)
      'review.requested', 'review.started', 'review.completed', 'review.verdict',
      // submission.* (3)
      'submission.received', 'submission.flagged_stub',
      'submission.flagged_missing_journal',
      // gate.* (5 — Phase 7 adds loaded/policy_written)
      'gate.allowed', 'gate.denied', 'gate.rate_limited',
      'gate.loaded', 'gate.policy_written',
      // router.* (3 — Phase 8)
      'router.decision', 'router.loaded', 'router.rule_written',
      // cost.* (3)
      'cost.charged', 'cost.budget_warning', 'cost.budget_exceeded',
      // auth.* (3 — grant lifecycle events added with RBAC audit fix)
      'auth.scope_granted', 'auth.scope_revoked', 'auth.scope_expired',
    ];
    for (const subject of expected) {
      expect(Object.prototype.hasOwnProperty.call(EventPayloadMap, subject)).toBe(true);
    }
    // NOTE: EventPayloadMap contains more subjects than this list because
    // run.*, provider.*, verification.*, system.* were added after the
    // original spec §3.8. This assertion checks all listed subjects exist;
    // the total count is >= expected.length.
    expect(Object.keys(EventPayloadMap).length).toBeGreaterThanOrEqual(expected.length);
  });

  test('payloadSchemaFor returns null for unknown subjects', () => {
    expect(payloadSchemaFor('task.nonexistent')).toBeNull();
    expect(payloadSchemaFor('not.a.real.subject')).toBeNull();
  });
});

describe('task.claimed payload', () => {
  const schema = payloadSchemaFor('task.claimed');
  test('accepts a valid claimed payload', () => {
    const ok = schema.safeParse({
      task_id: '11111111-2222-4333-8444-555555555555',
      assigned_agent: 'nova-4',
      claimed_at: Date.now(),
    });
    expect(ok.success).toBe(true);
  });
  test('rejects a non-uuid task_id', () => {
    const bad = schema.safeParse({
      task_id: 'not-a-uuid',
      assigned_agent: 'nova-4',
      claimed_at: 0,
    });
    expect(bad.success).toBe(false);
  });
});

describe('submission.flagged_stub with FindingSchema', () => {
  test('accepts a flagged_stub with one Finding', () => {
    const schema = payloadSchemaFor('submission.flagged_stub');
    const ok = schema.safeParse({
      task_id: '11111111-2222-4333-8444-555555555555',
      submitter: 'nova-4',
      findings: [{
        code: 'STUB_DETECTED',
        severity: 'error',
        message: 'function body is `throw new Error("not implemented")`',
        file: 'src/foo.js',
        line: 42,
      }],
      flagged_at: Date.now(),
    });
    expect(ok.success).toBe(true);
  });

  test('FindingSchema rejects a lowercase code', () => {
    const bad = FindingSchema.safeParse({
      code: 'lowercase',
      severity: 'info',
      message: 'hi',
    });
    expect(bad.success).toBe(false);
  });

  test('rejects flagged_stub with zero findings', () => {
    const schema = payloadSchemaFor('submission.flagged_stub');
    const bad = schema.safeParse({
      task_id: '11111111-2222-4333-8444-555555555555',
      submitter: 'nova-4',
      findings: [],
      flagged_at: 0,
    });
    expect(bad.success).toBe(false);
  });
});

describe('cost.charged payload', () => {
  const schema = payloadSchemaFor('cost.charged');
  test('accepts non-negative token counts and cost', () => {
    const ok = schema.safeParse({
      agent_id: 'nova-4',
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      input_tokens: 1000,
      output_tokens: 500,
      cost_usd: 0.025,
      charged_at: Date.now(),
    });
    expect(ok.success).toBe(true);
  });
  test('rejects negative cost_usd', () => {
    const bad = schema.safeParse({
      agent_id: 'nova-4',
      model: 'x',
      provider: 'y',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: -1,
      charged_at: 0,
    });
    expect(bad.success).toBe(false);
  });
  // Regression: ultrareview lens 3 flagged that `task_id` still enforced
  // strict z.string().uuid() — the exact bridge.sent bug Phase 4 fixed.
  // Legacy-prefixed ids (`task_legacy-xyz`) flowing from the proxy
  // handler were silently dropped by the zod check; the swallow at the
  // emit site (`proxy.cost_emit_failed`) hid it, DB persisted, event
  // bus drifted. Relaxed to min(1).optional() to match bridge.js.
  test('non-UUID task_id is accepted (legacy-prefixed ids from proxy must not be dropped)', () => {
    const ok = schema.safeParse({
      agent_id: 'nova-4',
      task_id: 'task_legacy-xyz',
      model: 'claude-opus-4-7',
      provider: 'anthropic',
      input_tokens: 10,
      output_tokens: 5,
      cost_usd: 0.001,
      charged_at: Date.now(),
    });
    expect(ok.success).toBe(true);
  });
  test('empty task_id is rejected (min(1) guard)', () => {
    const bad = schema.safeParse({
      agent_id: 'nova-4',
      task_id: '',
      model: 'x',
      provider: 'y',
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      charged_at: 0,
    });
    expect(bad.success).toBe(false);
  });
});

describe('gate.rate_limited payload', () => {
  const schema = payloadSchemaFor('gate.rate_limited');
  test('accepts a well-formed rate-limit event', () => {
    const ok = schema.safeParse({
      agent_id: 'nova-4',
      route: '/v1/tasks',
      limit: 60,
      window_ms: 60_000,
      limited_at: Date.now(),
    });
    expect(ok.success).toBe(true);
  });
  test('rejects zero limit or window', () => {
    const bad = schema.safeParse({
      agent_id: 'nova-4',
      route: '/v1/tasks',
      limit: 0,
      window_ms: 0,
      limited_at: 0,
    });
    expect(bad.success).toBe(false);
  });
});
