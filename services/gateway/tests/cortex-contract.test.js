import { beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDb, getStmts } from '../lib/db.js';
import cortexTasksRoutes from '../routes/cortex-tasks.js';
import { CORTEX_TOOLS } from '../mcp/tools.js';

function tool(name) {
  return CORTEX_TOOLS.find((entry) => entry.name === name);
}

function seedProject(stmts, id = 'proj-1') {
  stmts.createProject.run(id, 'Spec Project', 'spec-project', 'desc', 1, 'human');
}

describe('cortex task contract', () => {
  beforeEach(() => {
    initDb(':memory:');
    process.env.CORTEX_HUB_DIR = mkdtempSync(path.join(os.tmpdir(), 'cortex-hub-'));
  });

  it('task_create creates a pending unclaimed task and syncs a README', () => {
    const routes = cortexTasksRoutes();
    const stmts = getStmts();
    seedProject(stmts);
    const res = routes.create({
      title: 'Fix auth',
      description: 'Remove hardcoded admin',
      project_id: 'proj-1',
      phase_number: 1,
      priority: 'high',
      tags: ['audit'],
    }, { agentIdentity: 'atlas', isAdmin: false });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect(res.body.assigned_agent).toBeNull();
    expect(res.body.created_by).toBe('atlas');
    expect(res.body.priority).toBe('high');
    expect(res.body.tags).toEqual(['audit']);
    expect(res.body.file_sync?.readme_path).toBeTruthy();
    const taskReadme = readFileSync(res.body.file_sync.readme_path, 'utf8');
    expect(taskReadme).toContain('# Fix auth');
  });

  it('claim -> progress -> submit -> review -> approve follows the split review flow', () => {
    const routes = cortexTasksRoutes();
    const stmts = getStmts();
    seedProject(stmts);
    const created = routes.create({
      title: 'Fix auth',
      description: 'Remove hardcoded admin',
      project_id: 'proj-1',
      phase_number: 1,
    }, { agentIdentity: 'atlas', isAdmin: false });
    const taskId = created.body.id;

    const claimed = routes.claim(taskId, { agentIdentity: 'atlas', platform: 'atlas' });
    expect(claimed.status).toBe(200);
    expect(claimed.body.status).toBe('claimed');

    const planning = routes.progress(taskId, {
      status: 'planning',
      summary: 'Investigating current flow',
      files_changed: [],
    }, { agentIdentity: 'atlas' });
    expect(planning.status).toBe(200);
    expect(planning.body.status).toBe('in_progress');

    const implementation = routes.progress(taskId, {
      status: 'implementation',
      summary: 'Changed auth path',
      files_changed: ['lib/auth.js'],
    }, { agentIdentity: 'atlas' });
    expect(implementation.status).toBe(200);

    const testing = routes.progress(taskId, {
      status: 'testing',
      summary: 'Ran auth tests',
      files_changed: [],
    }, { agentIdentity: 'atlas' });
    expect(testing.status).toBe(200);

    const submitted = routes.submit(taskId, {
      summary: 'Completed fix',
      files_changed: ['lib/auth.js'],
    }, { agentIdentity: 'atlas' });
    expect(submitted.status).toBe(200);
    expect(submitted.body.status).toBe('submitted');

    const review = routes.requestReview(taskId, { reviewer: 'zeus' }, { agentIdentity: 'atlas' });
    expect(review.status).toBe(200);
    expect(review.body.status).toBe('review');
    expect(review.body.reviewer).toBe('zeus');

    const reviewing = routes.progress(taskId, {
      status: 'reviewing',
      summary: 'Audit complete',
      files_changed: [],
    }, { agentIdentity: 'zeus' });
    expect(reviewing.status).toBe(200);

    const approved = routes.approve(taskId, { comment: 'Looks good' }, { agentIdentity: 'zeus', isAdmin: false });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('approved');
    expect(approved.body.approved_by).toBe('zeus');
  });

  it('reject -> reopen -> progress returns task to in_progress with rejection history preserved', () => {
    const routes = cortexTasksRoutes();
    const stmts = getStmts();
    seedProject(stmts);
    const created = routes.create({
      title: 'Fix auth',
      description: 'Remove hardcoded admin',
      project_id: 'proj-1',
      phase_number: 1,
    }, { agentIdentity: 'atlas', isAdmin: false });
    const taskId = created.body.id;

    routes.claim(taskId, { agentIdentity: 'atlas', platform: 'atlas' });
    routes.progress(taskId, { status: 'planning', summary: 'Start', files_changed: [] }, { agentIdentity: 'atlas' });
    routes.progress(taskId, { status: 'implementation', summary: 'Edited', files_changed: ['lib/auth.js'] }, { agentIdentity: 'atlas' });
    routes.progress(taskId, { status: 'testing', summary: 'Tested', files_changed: [] }, { agentIdentity: 'atlas' });
    routes.submit(taskId, { summary: 'Done', files_changed: ['lib/auth.js'] }, { agentIdentity: 'atlas' });
    routes.requestReview(taskId, { reviewer: 'zeus' }, { agentIdentity: 'atlas' });

    const rejected = routes.reject(taskId, {
      reason: 'Needs fallback',
      guidance: 'Add try/catch',
    }, { agentIdentity: 'zeus', isAdmin: false });
    expect(rejected.status).toBe(200);
    expect(rejected.body.status).toBe('rejected');

    const followup = routes.progress(taskId, {
      status: 'implementation',
      summary: 'Addressed review feedback',
      files_changed: ['lib/auth.js'],
    }, { agentIdentity: 'atlas' });
    expect(followup.status).toBe(200);
    expect(followup.body.status).toBe('in_progress');

    const task = routes.getTask(taskId);
    expect(task.body.rejection_history).toHaveLength(1);
    expect(task.body.rejection_history[0].reason).toBe('Needs fallback');
  });

  it('submit is blocked until progress includes files_changed and reviewer is required', () => {
    const routes = cortexTasksRoutes();
    const stmts = getStmts();
    seedProject(stmts);
    const created = routes.create({
      title: 'Fix auth',
      description: 'Remove hardcoded admin',
      project_id: 'proj-1',
      phase_number: 1,
    }, { agentIdentity: 'atlas', isAdmin: false });
    const taskId = created.body.id;

    routes.claim(taskId, { agentIdentity: 'atlas', platform: 'atlas' });
    routes.progress(taskId, { status: 'planning', summary: 'Start', files_changed: [] }, { agentIdentity: 'atlas' });
    routes.progress(taskId, { status: 'testing', summary: 'Tests only', files_changed: [] }, { agentIdentity: 'atlas' });

    const submitted = routes.submit(taskId, { summary: 'Done' }, { agentIdentity: 'atlas' });
    expect(submitted.status).toBe(409);
    expect(submitted.body.error).toContain('files_changed');

    routes.progress(taskId, { status: 'implementation', summary: 'Changed auth', files_changed: ['lib/auth.js'] }, { agentIdentity: 'atlas' });
    const resubmitted = routes.submit(taskId, { summary: 'Done', files_changed: ['lib/auth.js'] }, { agentIdentity: 'atlas' });
    expect(resubmitted.status).toBe(200);

    const review = routes.requestReview(taskId, {}, { agentIdentity: 'atlas' });
    expect(review.status).toBe(400);
    expect(review.body.error).toContain('reviewer');
  });
});

describe('bridge contract', () => {
  beforeEach(() => {
    initDb(':memory:');
    process.env.CORTEX_HUB_DIR = mkdtempSync(path.join(os.tmpdir(), 'cortex-hub-'));
  });

  it('mark_read only consumes the returned inbox page', () => {
    const routes = cortexTasksRoutes();
    const stmts = getStmts();
    const ids = ['msg-1', 'msg-2', 'msg-3'];
    for (const id of ids) {
      stmts.bridgeSend.run(id, 'atlas', 'zeus', 'message', `body-${id}`, null, '[]', 'subject', 'normal', null, null, 'text', '{}', 0, null);
    }

    const inbox = routes.bridgeInbox('zeus', { unread_only: true, mark_read: true, limit: 2 });
    expect(inbox.status).toBe(200);
    expect(inbox.body.messages).toHaveLength(2);
    expect(inbox.body.total_unread).toBe(3);

    const returnedIds = new Set(inbox.body.messages.map((message) => message.message_id));
    const remainingUnread = stmts.bridgeInbox.all('zeus', 10).map((row) => row.id);
    expect(remainingUnread).toHaveLength(1);
    expect(returnedIds.has(remainingUnread[0])).toBe(false);
  });

  it('bridgeReply rejects replies from agents who were not the recipient', () => {
    const routes = cortexTasksRoutes();
    const stmts = getStmts();
    stmts.bridgeSend.run('msg-1', 'atlas', 'zeus', 'message', 'hello', null, '[]', 'subject', 'normal', null, null, 'text', '{}', 0, null);

    const forbidden = routes.bridgeReply('msg-1', { body: 'spoofed' }, { agentIdentity: 'gerald' });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body.error).toContain('addressed to you');
  });

  it('bridge inbox excludes expired messages', () => {
    const routes = cortexTasksRoutes();
    const stmts = getStmts();
    stmts.bridgeSend.run('expired', 'atlas', 'zeus', 'message', 'old', null, '[]', 'subject', 'normal', null, null, 'text', '{}', 0, 1);
    stmts.bridgeSend.run('active', 'atlas', 'zeus', 'message', 'new', null, '[]', 'subject', 'normal', null, null, 'text', '{}', 0, null);

    const inbox = routes.bridgeInbox('zeus', { unread_only: false, mark_read: false, limit: 10 });
    expect(inbox.status).toBe(200);
    expect(inbox.body.messages).toHaveLength(1);
    expect(inbox.body.messages[0].message_id).toBe('active');
  });

  it('bridge inbox exposes in_reply_to for threaded replies', () => {
    const routes = cortexTasksRoutes();
    const stmts = getStmts();
    stmts.bridgeSend.run('msg-1', 'atlas', 'zeus', 'message', 'hello', null, '[]', 'subject', 'normal', null, null, 'text', '{}', 0, null);

    const reply = routes.bridgeReply('msg-1', { body: 'got it' }, { agentIdentity: 'zeus' });
    expect(reply.status).toBe(200);

    const atlasInbox = routes.bridgeInbox('atlas', { unread_only: false, mark_read: false, limit: 10 });
    expect(atlasInbox.status).toBe(200);
    expect(atlasInbox.body.messages[0].message_id).toBe(reply.body.message_id);
    expect(atlasInbox.body.messages[0].in_reply_to).toBe('msg-1');
  });

  it('global unread counts exclude expired messages', () => {
    const routes = cortexTasksRoutes();
    const stmts = getStmts();
    stmts.bridgeSend.run('expired', 'atlas', 'zeus', 'message', 'old', null, '[]', 'subject', 'normal', null, null, 'text', '{}', 0, 1);
    stmts.bridgeSend.run('active', 'atlas', 'zeus', 'message', 'new', null, '[]', 'subject', 'normal', null, null, 'text', '{}', 0, null);

    const inbox = routes.bridgeInbox(null, { unread_only: true, mark_read: false, limit: 10 });
    expect(inbox.status).toBe(200);
    expect(inbox.body.messages).toHaveLength(1);
    expect(inbox.body.total_unread).toBe(1);
  });
});

describe('cortex MCP registry contract', () => {
  it('exposes the full implemented task lifecycle tool set with explicit claim semantics', () => {
    expect(tool('task_get')).toBeTruthy();
    expect(tool('task_approve')).toBeTruthy();
    expect(tool('task_reject')).toBeTruthy();
    expect(tool('task_update')).toBeTruthy();
    expect(tool('task_cancel')).toBeTruthy();
    expect(tool('task_comment')).toBeTruthy();
    expect(tool('task_reopen')).toBeTruthy();
    expect(tool('agent_register')).toBeTruthy();
    expect(tool('bridge_reply')).toBeTruthy();

    expect(tool('claim_task').inputSchema.required).toEqual(['task_id']);
    expect(tool('task_create').inputSchema.required).toEqual(['title', 'description', 'project_id', 'phase_number']);
    expect(tool('report_progress').inputSchema.required).toEqual(['task_id', 'status', 'summary']);
    expect(tool('submit_result').inputSchema.required).toEqual(['task_id', 'summary']);
    expect(tool('request_verification').inputSchema.required).toEqual(['task_id', 'reviewer']);
    expect(tool('task_reassign').inputSchema.required).toEqual(['task_id', 'new_agent']);
  });

  it('includes project, context, and observability tools from the registry', () => {
    const names = CORTEX_TOOLS.map((entry) => entry.name);
    expect(names).toContain('gateway_stats');
    expect(names).toContain('cost_summary');
    expect(names).toContain('logs_query');
    expect(names).toContain('error_history');
    expect(names).toContain('context_save');
    expect(names).toContain('context_retrieve');
    expect(names).toContain('context_list');
    expect(names).toContain('project_create');
    expect(names).toContain('project_list');
    expect(names).toContain('project_get');
    expect(names).toContain('project_summary');
  });

  it('defines route_request with the registry provider-based contract', () => {
    const routeRequest = tool('route_request');
    expect(routeRequest.inputSchema.required).toEqual(['provider', 'model', 'messages']);
    expect(routeRequest.inputSchema.properties.provider).toBeTruthy();
    expect(routeRequest.inputSchema.properties.max_tokens).toBeTruthy();
    expect(routeRequest.inputSchema.properties.temperature).toBeTruthy();
  });
});
