/**
 * Phase 1 smoke tests — mirror `shared/schemas/schemas.test.js` happy-path +
 * negative cases, and exercise the two NEW Phase 1 schemas
 * (PluginManifestSchema tested in plugin-manifest.test.js; ToolDefinitionSchema
 * here). Every assertion is a real safeParse against a real fixture.
 */
import { describe, test, expect } from 'bun:test';
import {
  TaskStatusSchema,
  TaskPrioritySchema,
  TaskCreateSchema,
  RequestVerificationSchema,
  BridgeSendSchema,
  BridgeInboxSchema,
  AgentStatusSchema,
  AgentIdSchema,
  TaskIdSchema,
  AgentRegisterSchema,
  HeartbeatSchema,
  GetNextTaskSchema,
  ProgressStatusSchema,
  ProgressReportSchema,
  ToolDefinitionSchema,
} from '../index.js';

const VALID_UUID = '00000000-0000-4000-8000-000000000001';

describe('TaskStatusSchema', () => {
  test('accepts every legacy status value', () => {
    for (const s of [
      'pending',
      'claimed',
      'in_progress',
      'submitted',
      'review',
      'approved',
      'rejected',
      'cancelled',
      'failed',
    ]) {
      expect(TaskStatusSchema.safeParse(s).success).toBe(true);
    }
  });
  test('accepts orphaned (Phase 5 addition — session-reaper target state)', () => {
    expect(TaskStatusSchema.safeParse('orphaned').success).toBe(true);
  });
  test('rejects unknown status', () => {
    expect(TaskStatusSchema.safeParse('nope').success).toBe(false);
  });
});

describe('TaskPrioritySchema', () => {
  test('accepts low/medium/normal/high/critical', () => {
    for (const p of ['low', 'medium', 'normal', 'high', 'critical']) {
      expect(TaskPrioritySchema.safeParse(p).success).toBe(true);
    }
  });
});

describe('TaskCreateSchema', () => {
  test('requires project_id and title', () => {
    expect(TaskCreateSchema.safeParse({ title: 't' }).success).toBe(false);
    expect(
      TaskCreateSchema.safeParse({ project_id: 'proj-1', title: 't' }).success,
    ).toBe(true);
  });
  test('accepts short non-uuid project_id (fixture compat)', () => {
    expect(
      TaskCreateSchema.safeParse({ project_id: 'proj-1', title: 't' }).success,
    ).toBe(true);
  });
  test('rejects title > 200 chars', () => {
    expect(
      TaskCreateSchema.safeParse({
        project_id: VALID_UUID,
        title: 'a'.repeat(201),
      }).success,
    ).toBe(false);
  });
  test('description is optional', () => {
    expect(
      TaskCreateSchema.safeParse({ project_id: VALID_UUID, title: 't' }).success,
    ).toBe(true);
  });
  test('rejects tags > 16', () => {
    expect(
      TaskCreateSchema.safeParse({
        project_id: VALID_UUID,
        title: 't',
        tags: new Array(17).fill('tag'),
      }).success,
    ).toBe(false);
  });
});

describe('RequestVerificationSchema', () => {
  test('requires task_id and reviewer', () => {
    expect(RequestVerificationSchema.safeParse({ task_id: 't1' }).success).toBe(false);
    expect(
      RequestVerificationSchema.safeParse({ task_id: 't1', reviewer: 'nova' }).success,
    ).toBe(true);
  });
});

describe('BridgeSendSchema', () => {
  test('accepts message kind', () => {
    expect(
      BridgeSendSchema.safeParse({ to: 'nova', kind: 'message', content: 'hi' }).success,
    ).toBe(true);
  });
  test('rejects missing to', () => {
    expect(
      BridgeSendSchema.safeParse({ kind: 'message', content: 'hi' }).success,
    ).toBe(false);
  });
  test('rejects unknown kind (no broadcast/system/reply in Phase 1)', () => {
    expect(
      BridgeSendSchema.safeParse({ to: 'nova', kind: 'broadcast', content: 'x' }).success,
    ).toBe(false);
  });
  test('question requires question_id', () => {
    expect(
      BridgeSendSchema.safeParse({ to: 'nova', kind: 'question', content: '?' }).success,
    ).toBe(false);
    expect(
      BridgeSendSchema.safeParse({
        to: 'nova',
        kind: 'question',
        question_id: 'q1',
        content: '?',
      }).success,
    ).toBe(true);
  });
  test('ack does not require content', () => {
    expect(BridgeSendSchema.safeParse({ to: 'nova', kind: 'ack' }).success).toBe(true);
  });
  test('rejects empty content on message', () => {
    expect(
      BridgeSendSchema.safeParse({ to: 'nova', kind: 'message', content: '' }).success,
    ).toBe(false);
  });
});

describe('BridgeInboxSchema', () => {
  test('accepts empty object', () => {
    expect(BridgeInboxSchema.safeParse({}).success).toBe(true);
  });
  test('rejects limit > 500', () => {
    expect(BridgeInboxSchema.safeParse({ limit: 9999 }).success).toBe(false);
  });
});

describe('AgentStatusSchema', () => {
  test('accepts UPPERCASE triple', () => {
    for (const s of ['ACTIVE', 'IDLE', 'OFFLINE']) {
      expect(AgentStatusSchema.safeParse(s).success).toBe(true);
    }
  });
  test('rejects lowercase', () => {
    expect(AgentStatusSchema.safeParse('active').success).toBe(false);
  });
});

describe('AgentIdSchema', () => {
  test('accepts slug with optional -N suffix', () => {
    expect(AgentIdSchema.safeParse('nova').success).toBe(true);
    expect(AgentIdSchema.safeParse('nova-2').success).toBe(true);
    expect(AgentIdSchema.safeParse('a_b-c').success).toBe(true);
  });
  test('rejects uppercase', () => {
    expect(AgentIdSchema.safeParse('Nova').success).toBe(false);
  });
});

describe('TaskIdSchema', () => {
  test('requires uuid', () => {
    expect(TaskIdSchema.safeParse(VALID_UUID).success).toBe(true);
    expect(TaskIdSchema.safeParse('xxx').success).toBe(false);
  });
});

describe('AgentRegisterSchema', () => {
  test('requires agent_id', () => {
    expect(AgentRegisterSchema.safeParse({}).success).toBe(false);
    expect(AgentRegisterSchema.safeParse({ agent_id: 'nova' }).success).toBe(true);
  });
});

describe('HeartbeatSchema', () => {
  test('empty object ok', () => {
    expect(HeartbeatSchema.safeParse({}).success).toBe(true);
  });
  test('rejects bad status casing', () => {
    expect(HeartbeatSchema.safeParse({ status: 'busy' }).success).toBe(false);
  });
});

describe('GetNextTaskSchema', () => {
  test('empty object ok', () => {
    expect(GetNextTaskSchema.safeParse({}).success).toBe(true);
  });
  test('rejects non-uuid project_id', () => {
    expect(GetNextTaskSchema.safeParse({ project_id: 'nope' }).success).toBe(false);
  });
});

describe('ProgressStatusSchema', () => {
  test('accepts every legacy stage', () => {
    for (const s of ['planning', 'implementation', 'in_progress', 'testing', 'reviewing']) {
      expect(ProgressStatusSchema.safeParse(s).success).toBe(true);
    }
  });
});

describe('ProgressReportSchema', () => {
  test('accepts valid report', () => {
    expect(
      ProgressReportSchema.safeParse({
        task_id: VALID_UUID,
        status: 'testing',
        summary: 'ok',
      }).success,
    ).toBe(true);
  });
  test('rejects summary > 4000 chars', () => {
    expect(
      ProgressReportSchema.safeParse({
        task_id: VALID_UUID,
        status: 'planning',
        summary: 'a'.repeat(4001),
      }).success,
    ).toBe(false);
  });
});

describe('ToolDefinitionSchema', () => {
  test('accepts a minimal MCP tool definition', () => {
    const parsed = ToolDefinitionSchema.safeParse({
      name: 'task_create',
      summary: 'Create a task',
      input_schema: { type: 'object' },
      output_schema: { type: 'object' },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.protocolVersion).toBe('1');
      expect(parsed.data.permission).toBe('agent');
      expect(parsed.data.timeout_ms).toBe(30_000);
    }
  });
  test('rejects CamelCase tool names', () => {
    expect(
      ToolDefinitionSchema.safeParse({
        name: 'TaskCreate',
        summary: 'nope',
        input_schema: {},
        output_schema: {},
      }).success,
    ).toBe(false);
  });
  test('rejects unknown fields (strict)', () => {
    expect(
      ToolDefinitionSchema.safeParse({
        name: 'ok_tool',
        summary: 's',
        input_schema: {},
        output_schema: {},
        surprise: 'field',
      }).success,
    ).toBe(false);
  });
});
