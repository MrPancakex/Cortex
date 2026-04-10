/**
 * Gateway SQLite DB — schema + query helpers.
 * Single module owns all prepared statements.
 */
import crypto from 'node:crypto';
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export const MAX_REJECTIONS = 5; // cap rejection cycles per task

let _db = null;
let _stmts = null;

export function initDb(dbPath) {
  mkdirSync(path.dirname(dbPath), { recursive: true });

  _db = new Database(dbPath, { create: true });

  _db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT,
      endpoint TEXT DEFAULT '',
      capabilities TEXT DEFAULT '[]',
      status TEXT DEFAULT 'registered',
      last_heartbeat INTEGER,
      registered_at INTEGER NOT NULL,
      meta TEXT DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      project_id TEXT,
      type TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      status TEXT DEFAULT 'pending',
      result TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      FOREIGN KEY(bot_id) REFERENCES bots(id)
    );

    CREATE TABLE IF NOT EXISTS usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT NOT NULL,
      project_id TEXT,
      type TEXT NOT NULL,
      units REAL NOT NULL,
      unit_label TEXT DEFAULT 'tokens',
      cost_usd REAL DEFAULT 0,
      recorded_at INTEGER NOT NULL,
      meta TEXT DEFAULT '{}',
      FOREIGN KEY(bot_id) REFERENCES bots(id)
    );

    CREATE TABLE IF NOT EXISTS service_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL,
      event TEXT NOT NULL,
      payload TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS gateway_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT NOT NULL,
      timestamp TEXT NOT NULL DEFAULT (datetime('now')),
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      agent_id TEXT,
      project_id TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      latency_ms INTEGER DEFAULT 0,
      status_code INTEGER,
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS otel_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_agent TEXT NOT NULL DEFAULT 'unknown',
      provider TEXT NOT NULL DEFAULT 'unknown',
      run_id TEXT,
      thread_id TEXT,
      model TEXT,
      auth_mode TEXT,
      tokens_in INTEGER,
      tokens_out INTEGER,
      cost_usd REAL DEFAULT 0,
      latency_ms INTEGER,
      status TEXT,
      tool_name TEXT,
      tool_success INTEGER,
      event_type TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      model TEXT DEFAULT '',
      provider TEXT DEFAULT 'ollama',
      status TEXT DEFAULT 'idle',
      last_active TEXT
    );

    CREATE TABLE IF NOT EXISTS model_calls (
      id TEXT PRIMARY KEY,
      source TEXT,
      provider TEXT,
      model TEXT,
      task_id TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      error TEXT,
      status TEXT DEFAULT 'pending',
      latency_ms INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      agent TEXT,
      project_id TEXT,
      priority TEXT DEFAULT 'medium',
      type TEXT DEFAULT 'task',
      status TEXT DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bridge_messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      task_id TEXT,
      files TEXT DEFAULT '[]',
      read INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Cortex Hard Gates: task state machine
    CREATE TABLE IF NOT EXISTS cortex_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','claimed','in_progress','submitted','review','approved','rejected','cancelled','failed')),
      source TEXT DEFAULT 'human' CHECK(source IN ('human','agent')),
      created_by TEXT,
      assigned_agent TEXT,
      assigned_platform TEXT,
      project_id TEXT,
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      tags TEXT DEFAULT '[]',
      claimed_at INTEGER,
      submitted_at INTEGER,
      approved_at INTEGER,
      rejected_at INTEGER,
      cancelled_at INTEGER,
      verified_at INTEGER,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch()),
      result_summary TEXT,
      reviewer_agent TEXT,
      review_feedback TEXT,
      cancel_reason TEXT,
      cancelled_by TEXT
    );

    CREATE TABLE IF NOT EXISTS progress_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT REFERENCES cortex_tasks(id),
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL,
      summary TEXT,
      files_changed TEXT,
      stub_detected INTEGER DEFAULT 0,
      stub_reason TEXT,
      timestamp INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS task_comments (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES cortex_tasks(id),
      author TEXT NOT NULL,
      comment TEXT NOT NULL,
      comment_type TEXT DEFAULT 'note',
      in_reply_to TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS task_rejections (
      id TEXT PRIMARY KEY,
      task_id TEXT REFERENCES cortex_tasks(id),
      rejected_by TEXT NOT NULL,
      reason TEXT NOT NULL,
      guidance TEXT,
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS cortex_projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'active',
      created_by TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS context_snapshots (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT,
      task_id TEXT,
      context_type TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT DEFAULT '[]',
      created_at INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      agent_id TEXT,
      event_type TEXT NOT NULL,
      payload TEXT,
      timestamp INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS subagent_events (
      id TEXT PRIMARY KEY,
      parent_agent TEXT NOT NULL,
      subagent_id TEXT NOT NULL,
      subagent_type TEXT DEFAULT 'general-purpose',
      description TEXT,
      task_id TEXT,
      status TEXT DEFAULT 'running' CHECK(status IN ('running','completed','failed')),
      started_at INTEGER DEFAULT (unixepoch()),
      completed_at INTEGER,
      duration_ms INTEGER DEFAULT 0,
      tool_calls INTEGER DEFAULT 0,
      result_summary TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_subagent_parent ON subagent_events(parent_agent);
    CREATE INDEX IF NOT EXISTS idx_subagent_task ON subagent_events(task_id);
    CREATE INDEX IF NOT EXISTS idx_subagent_status ON subagent_events(status);

    CREATE TABLE IF NOT EXISTS heartbeats (
      agent_id TEXT PRIMARY KEY,
      platform TEXT,
      last_seen INTEGER,
      current_task TEXT,
      status TEXT DEFAULT 'idle'
    );

    CREATE INDEX IF NOT EXISTS idx_cortex_tasks_status ON cortex_tasks(status);
    CREATE INDEX IF NOT EXISTS idx_cortex_tasks_platform ON cortex_tasks(assigned_platform, status);
    CREATE INDEX IF NOT EXISTS idx_progress_task ON progress_reports(task_id);
    CREATE INDEX IF NOT EXISTS idx_task_comments_task ON task_comments(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_task_rejections_task ON task_rejections(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_context_snapshots_task ON context_snapshots(task_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log(task_id);
    CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id);

    CREATE INDEX IF NOT EXISTS idx_tasks_bot ON tasks(bot_id, status);
    CREATE INDEX IF NOT EXISTS idx_usage_bot ON usage(bot_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_usage_project ON usage(project_id, recorded_at);
    CREATE INDEX IF NOT EXISTS idx_events_service ON service_events(service, created_at);
    CREATE INDEX IF NOT EXISTS idx_gateway_logs_timestamp ON gateway_logs(timestamp);
    CREATE INDEX IF NOT EXISTS idx_gateway_logs_agent ON gateway_logs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_gateway_logs_project ON gateway_logs(project_id);
    CREATE INDEX IF NOT EXISTS idx_otel_events_timestamp ON otel_events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_otel_events_source_agent ON otel_events(source_agent);
  `);

  // --- Migrations: add columns to existing tables if missing ---
  const migrations = [
    `ALTER TABLE cortex_tasks ADD COLUMN source TEXT DEFAULT 'human'`,
    `ALTER TABLE cortex_tasks ADD COLUMN created_by TEXT`,
    `ALTER TABLE cortex_tasks ADD COLUMN project_id TEXT`,
    `ALTER TABLE cortex_tasks ADD COLUMN priority TEXT DEFAULT 'medium'`,
    `ALTER TABLE cortex_tasks ADD COLUMN tags TEXT DEFAULT '[]'`,
    `ALTER TABLE cortex_tasks ADD COLUMN approved_at INTEGER`,
    `ALTER TABLE cortex_tasks ADD COLUMN rejected_at INTEGER`,
    `ALTER TABLE cortex_tasks ADD COLUMN cancelled_at INTEGER`,
    `ALTER TABLE cortex_tasks ADD COLUMN updated_at INTEGER DEFAULT (unixepoch())`,
    `ALTER TABLE cortex_tasks ADD COLUMN cancel_reason TEXT`,
    `ALTER TABLE cortex_tasks ADD COLUMN cancelled_by TEXT`,
    `ALTER TABLE progress_reports ADD COLUMN stub_detected INTEGER DEFAULT 0`,
    `ALTER TABLE progress_reports ADD COLUMN stub_reason TEXT`,
    `ALTER TABLE bridge_messages ADD COLUMN subject TEXT`,
    `ALTER TABLE bridge_messages ADD COLUMN priority TEXT DEFAULT 'normal'`,
    `ALTER TABLE bridge_messages ADD COLUMN reference_task_id TEXT`,
    `ALTER TABLE bridge_messages ADD COLUMN in_reply_to TEXT`,
    `ALTER TABLE bridge_messages ADD COLUMN sent_at INTEGER DEFAULT 0`,
    // Bridge Protocol v2 — typed messages, ack, delivery tracking
    `ALTER TABLE bridge_messages ADD COLUMN message_type TEXT DEFAULT 'text'`,
    `ALTER TABLE bridge_messages ADD COLUMN context TEXT DEFAULT '{}'`,
    `ALTER TABLE bridge_messages ADD COLUMN blocking INTEGER DEFAULT 0`,
    `ALTER TABLE bridge_messages ADD COLUMN delivered_at INTEGER`,
    `ALTER TABLE bridge_messages ADD COLUMN acknowledged_at INTEGER`,
    `ALTER TABLE bridge_messages ADD COLUMN expires_at INTEGER`,
    // Live task tracking — phase support
    `ALTER TABLE cortex_tasks ADD COLUMN phase_number INTEGER DEFAULT 1`,
    `ALTER TABLE cortex_projects ADD COLUMN slug TEXT`,
    `ALTER TABLE cortex_projects ADD COLUMN phase_count INTEGER NOT NULL DEFAULT 1`,
    `ALTER TABLE cortex_tasks ADD COLUMN rejection_count INTEGER DEFAULT 0`,
    // Delete request flow
    `ALTER TABLE cortex_tasks ADD COLUMN delete_requested_at INTEGER`,
    `ALTER TABLE cortex_tasks ADD COLUMN delete_requested_by TEXT`,
    // Default reviewer per project
    `ALTER TABLE cortex_projects ADD COLUMN default_reviewer TEXT`,
  ];
  for (const sql of migrations) {
    try { _db.exec(sql); } catch (e) {
      // "duplicate column name" means it already exists — safe to ignore
      if (!e.message.includes('duplicate column')) {
        console.error(`[db] migration warning: ${e.message}`);
      }
    }
  }

  // Backfill slugs for existing projects using JS slugify for consistency
  try {
    const _slugify = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'unnamed';
    const projects = _db.prepare(`SELECT id, name FROM cortex_projects WHERE slug IS NULL OR slug = ''`).all();
    const updateSlug = _db.prepare(`UPDATE cortex_projects SET slug = ? WHERE id = ?`);
    for (const p of projects) {
      updateSlug.run(_slugify(p.name), p.id);
    }
  } catch (e) {
    console.error(`[db] slug backfill warning: ${e.message}`);
  }

  // Unique index on slug
  try {
    _db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cortex_projects_slug ON cortex_projects(slug)`);
  } catch (e) {
    console.error(`[db] slug index warning: ${e.message}`);
  }

  _stmts = {
    // Bots
    registerBot: _db.prepare(`INSERT OR REPLACE INTO bots (id, name, version, endpoint, capabilities, status, registered_at, meta) VALUES (?, ?, ?, ?, ?, 'online', ?, ?)`),
    getBot: _db.prepare(`SELECT * FROM bots WHERE id = ?`),
    listBots: _db.prepare(`SELECT * FROM bots ORDER BY registered_at DESC`),
    heartbeat: _db.prepare(`UPDATE bots SET last_heartbeat = ?, status = 'online' WHERE id = ?`),
    markOffline: _db.prepare(`UPDATE bots SET status = 'offline' WHERE id = ? AND status = 'online'`),
    unregisterBot: _db.prepare(`DELETE FROM bots WHERE id = ?`),

    // Tasks
    createTask: _db.prepare(`INSERT INTO tasks (id, bot_id, project_id, type, payload, status, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`),
    getPendingTasks: _db.prepare(`SELECT * FROM tasks WHERE bot_id = ? AND status = 'pending' ORDER BY created_at`),
    getTask: _db.prepare(`SELECT * FROM tasks WHERE id = ?`),
    startTask: _db.prepare(`UPDATE tasks SET status = 'running', started_at = ? WHERE id = ?`),
    completeTask: _db.prepare(`UPDATE tasks SET status = ?, result = ?, completed_at = ? WHERE id = ?`),
    listTasksByProject: _db.prepare(`SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`),

    // Usage
    recordUsage: _db.prepare(`INSERT INTO usage (bot_id, project_id, type, units, unit_label, cost_usd, recorded_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    getUsageByBot: _db.prepare(`SELECT * FROM usage WHERE bot_id = ? ORDER BY recorded_at DESC LIMIT ?`),
    getUsageByProject: _db.prepare(`SELECT * FROM usage WHERE project_id = ? ORDER BY recorded_at DESC LIMIT ?`),
    getCostSummary: _db.prepare(`SELECT project_id, bot_id, SUM(cost_usd) as total_cost, SUM(units) as total_units, COUNT(*) as entries FROM usage GROUP BY project_id, bot_id`),

    // Service events
    logEvent: _db.prepare(`INSERT INTO service_events (service, event, payload, created_at) VALUES (?, ?, ?, ?)`),
    listEvents: _db.prepare(`SELECT * FROM service_events ORDER BY created_at DESC LIMIT ?`),
    listEventsByService: _db.prepare(`SELECT * FROM service_events WHERE service = ? ORDER BY created_at DESC LIMIT ?`),

    // Agents
    getAgent: _db.prepare(`SELECT * FROM agents WHERE id = ?`),
    listAgents: _db.prepare(`SELECT * FROM agents ORDER BY last_active DESC`),
    touchAgent: _db.prepare(`INSERT INTO agents (id, name, status, last_active) VALUES (?, ?, 'active', datetime('now')) ON CONFLICT(id) DO UPDATE SET status='active', last_active=datetime('now')`),

    // Model calls
    logModelCall: _db.prepare(`INSERT INTO model_calls (id, source, provider, model, task_id, tokens_in, tokens_out, cost, error, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    updateModelCall: _db.prepare(`UPDATE model_calls SET status=?, tokens_in=?, tokens_out=?, cost=?, latency_ms=?, error=? WHERE id=?`),
    modelCallsToday: _db.prepare(`SELECT source as id, COUNT(*) as requests, COALESCE(SUM(tokens_in),0) as tokens_in, COALESCE(SUM(tokens_out),0) as tokens_out, COALESCE(SUM(cost),0) as cost, SUM(CASE WHEN status='error' THEN 1 ELSE 0 END) as errors FROM model_calls WHERE source=? AND DATE(created_at)=DATE('now')`),

    // Agent tasks
    createAgentTask: _db.prepare(`INSERT INTO agent_tasks (id, title, description, agent, project_id, priority, type) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    listAgentTasks: _db.prepare(`SELECT * FROM agent_tasks ORDER BY created_at DESC LIMIT ?`),
    listAgentTasksByAgent: _db.prepare(`SELECT * FROM agent_tasks WHERE agent=? ORDER BY created_at DESC LIMIT ?`),
    listAgentTasksByStatus: _db.prepare(`SELECT * FROM agent_tasks WHERE status=? ORDER BY created_at DESC LIMIT ?`),
    listAgentTasksByAgentAndStatus: _db.prepare(`SELECT * FROM agent_tasks WHERE agent=? AND status=? ORDER BY created_at DESC LIMIT ?`),

    // Bridge messages
    bridgeSend: _db.prepare(`INSERT INTO bridge_messages (id, from_agent, to_agent, type, content, task_id, files, subject, priority, reference_task_id, in_reply_to, sent_at, message_type, context, blocking, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), ?, ?, ?, ?)`),
    bridgeInbox: _db.prepare(`SELECT * FROM bridge_messages WHERE to_agent=? AND read=0 AND (expires_at IS NULL OR expires_at > unixepoch()) ORDER BY COALESCE(sent_at, created_at) DESC LIMIT ?`),
    bridgeAll: _db.prepare(`SELECT * FROM bridge_messages WHERE to_agent=? AND (expires_at IS NULL OR expires_at > unixepoch()) ORDER BY COALESCE(sent_at, created_at) DESC LIMIT ?`),
    bridgeRecent: _db.prepare(`SELECT * FROM bridge_messages WHERE expires_at IS NULL OR expires_at > unixepoch() ORDER BY COALESCE(sent_at, created_at) DESC LIMIT ?`),
    bridgeMarkRead: _db.prepare(`UPDATE bridge_messages SET read=1 WHERE to_agent=? AND read=0`),
    bridgeMarkReadById: _db.prepare(`UPDATE bridge_messages SET read=1 WHERE id=? AND to_agent=? AND read=0`),
    bridgeGetById: _db.prepare(`SELECT * FROM bridge_messages WHERE id = ?`),
    bridgeUnreadCountAll: _db.prepare(`SELECT COUNT(*) as count FROM bridge_messages WHERE read = 0 AND (expires_at IS NULL OR expires_at > unixepoch())`),
    bridgeUnreadCountByAgent: _db.prepare(`SELECT COUNT(*) as count FROM bridge_messages WHERE to_agent = ? AND read = 0 AND (expires_at IS NULL OR expires_at > unixepoch())`),
    bridgeAck: _db.prepare(`UPDATE bridge_messages SET acknowledged_at=unixepoch() WHERE id=? AND to_agent=?`),
    bridgeMarkDelivered: _db.prepare(`UPDATE bridge_messages SET delivered_at=unixepoch() WHERE id=? AND delivered_at IS NULL`),

    // Gateway logs
    insertLog: _db.prepare(`INSERT INTO gateway_logs (request_id, method, path, provider, model, agent_id, project_id, tokens_in, tokens_out, cost_usd, latency_ms, status_code, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getRecentLogs: _db.prepare(`SELECT * FROM gateway_logs ORDER BY id DESC LIMIT ?`),
    getLogsByAgent: _db.prepare(`SELECT * FROM gateway_logs WHERE agent_id = ? ORDER BY id DESC LIMIT ?`),
    getLogsByProject: _db.prepare(`SELECT * FROM gateway_logs WHERE project_id = ? ORDER BY id DESC LIMIT ?`),
    getLogsByModel: _db.prepare(`SELECT * FROM gateway_logs WHERE model = ? ORDER BY id DESC LIMIT ?`),
    getLogStats: _db.prepare(`
      SELECT
        COUNT(*) as total_requests,
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(tokens_in), 0) as total_tokens_in,
        COALESCE(SUM(tokens_out), 0) as total_tokens_out,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms
      FROM gateway_logs
    `),
    getLogStatsByProvider: _db.prepare(`
      SELECT
        provider,
        COUNT(*) as requests,
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(tokens_in), 0) as tokens_in,
        COALESCE(SUM(tokens_out), 0) as tokens_out,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms
      FROM gateway_logs
      GROUP BY provider
      ORDER BY requests DESC
    `),
    getLogStatsByModel: _db.prepare(`
      SELECT
        model,
        provider,
        COUNT(*) as requests,
        COALESCE(SUM(cost_usd), 0) as total_cost,
        COALESCE(SUM(tokens_in), 0) as tokens_in,
        COALESCE(SUM(tokens_out), 0) as tokens_out,
        COALESCE(AVG(latency_ms), 0) as avg_latency_ms
      FROM gateway_logs
      GROUP BY model, provider
      ORDER BY total_cost DESC
    `),

    // Cortex tasks (hard gates state machine)
    getCortexTask: _db.prepare(`SELECT * FROM cortex_tasks WHERE id = ?`),
    listCortexTasks: _db.prepare(`SELECT * FROM cortex_tasks ORDER BY updated_at DESC, created_at DESC LIMIT ?`),
    listCortexTasksByStatus: _db.prepare(`SELECT * FROM cortex_tasks WHERE status = ? ORDER BY updated_at DESC, created_at DESC LIMIT ?`),
    listCortexTasksFiltered: _db.prepare(`
      SELECT * FROM cortex_tasks
      WHERE (@status IS NULL OR status = @status)
        AND (@agent IS NULL OR assigned_agent = @agent)
        AND (@project_id IS NULL OR project_id = @project_id)
        AND (@source IS NULL OR source = @source)
      ORDER BY updated_at DESC, created_at DESC
      LIMIT @limit
    `),
    getNextTask: _db.prepare(`
      SELECT * FROM cortex_tasks
      WHERE status = 'pending'
        AND (assigned_platform IS NULL OR assigned_platform = ? OR ? IS NULL)
      ORDER BY
        CASE priority
          WHEN 'critical' THEN 4
          WHEN 'high' THEN 3
          WHEN 'medium' THEN 2
          WHEN 'low' THEN 1
          ELSE 0
        END DESC,
        created_at ASC
      LIMIT 1
    `),
    createCortexTask: _db.prepare(`INSERT INTO cortex_tasks (id, title, description, source, created_by, assigned_agent, assigned_platform, project_id, phase_number, priority, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch())`),
    claimTask: _db.prepare(`UPDATE cortex_tasks SET status = 'claimed', assigned_agent = ?, assigned_platform = ?, claimed_at = unixepoch() WHERE id = ? AND status = 'pending'`),
    advanceTask: _db.prepare(`UPDATE cortex_tasks SET status = ?, updated_at = unixepoch() WHERE id = ? AND status = ?`),
    submitTask: _db.prepare(`UPDATE cortex_tasks SET status = 'submitted', result_summary = ?, submitted_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND status = 'in_progress'`),
    verifyTask: _db.prepare(`UPDATE cortex_tasks SET status = 'review', reviewer_agent = ?, updated_at = unixepoch() WHERE id = ? AND status = 'submitted'`),
    approveTask: _db.prepare(`UPDATE cortex_tasks SET status = 'approved', review_feedback = ?, approved_at = unixepoch(), verified_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND status = 'review'`),
    rejectTask: _db.prepare(`UPDATE cortex_tasks SET status = 'in_progress', review_feedback = ?, rejected_at = unixepoch(), updated_at = unixepoch() WHERE id = ? AND status = 'review'`),
    incrementRejectionCount: _db.prepare(`UPDATE cortex_tasks SET rejection_count = COALESCE(rejection_count, 0) + 1 WHERE id = ?`),
    requestDeleteTask: _db.prepare(`UPDATE cortex_tasks SET delete_requested_at = unixepoch(), delete_requested_by = ?, updated_at = unixepoch() WHERE id = ?`),
    clearDeleteRequest: _db.prepare(`UPDATE cortex_tasks SET delete_requested_at = NULL, delete_requested_by = NULL, updated_at = unixepoch() WHERE id = ?`),
    listDeleteRequests: _db.prepare(`SELECT * FROM cortex_tasks WHERE delete_requested_at IS NOT NULL ORDER BY delete_requested_at DESC`),
    failTask: _db.prepare(`UPDATE cortex_tasks SET status = 'failed', updated_at = unixepoch() WHERE id = ?`),
    reopenTask: _db.prepare(`UPDATE cortex_tasks SET status = 'pending', assigned_agent = NULL, assigned_platform = NULL, claimed_at = NULL, reviewer_agent = NULL, updated_at = unixepoch() WHERE id = ? AND status IN ('approved','rejected')`),
    cancelTask: _db.prepare(`UPDATE cortex_tasks SET status = 'cancelled', cancelled_at = unixepoch(), cancelled_by = ?, cancel_reason = ?, assigned_agent = NULL, assigned_platform = NULL, updated_at = unixepoch() WHERE id = ? AND status != 'cancelled'`),
    reassignTask: _db.prepare(`UPDATE cortex_tasks SET status = 'pending', assigned_agent = ?, assigned_platform = NULL, claimed_at = NULL, reviewer_agent = NULL, updated_at = unixepoch() WHERE id = ? AND status NOT IN ('approved','rejected','cancelled')`),
    releaseTask: _db.prepare(`UPDATE cortex_tasks SET status = 'pending', assigned_agent = NULL, assigned_platform = NULL, claimed_at = NULL, updated_at = unixepoch() WHERE id = ? AND status IN ('claimed', 'in_progress')`),
    updateCortexTask: _db.prepare(`UPDATE cortex_tasks SET title = COALESCE(?, title), description = COALESCE(?, description), priority = COALESCE(?, priority), tags = COALESCE(?, tags), updated_at = unixepoch() WHERE id = ?`),

    // Progress reports
    insertProgress: _db.prepare(`INSERT INTO progress_reports (task_id, agent_id, status, summary, files_changed, stub_detected, stub_reason) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    countStubsByTask: _db.prepare(`SELECT COUNT(*) as count FROM progress_reports WHERE task_id = ? AND stub_detected = 1`),
    countProgressWithFiles: _db.prepare(`SELECT COUNT(*) as count FROM progress_reports WHERE task_id = ? AND files_changed != '[]' AND files_changed IS NOT NULL AND files_changed != ''`),
    getProgressByTask: _db.prepare(`SELECT * FROM progress_reports WHERE task_id = ? ORDER BY timestamp DESC`),
    countProgressByTask: _db.prepare(`SELECT COUNT(*) as count FROM progress_reports WHERE task_id = ?`),
    progressByTaskAsc: _db.prepare(`SELECT * FROM progress_reports WHERE task_id = ? ORDER BY timestamp ASC`),

    // Audit log
    insertAudit: _db.prepare(`INSERT INTO audit_log (task_id, agent_id, event_type, payload) VALUES (?, ?, ?, ?)`),
    getAuditByTask: _db.prepare(`SELECT * FROM audit_log WHERE task_id = ? ORDER BY timestamp DESC`),
    getAuditRecent: _db.prepare(`SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?`),

    // Heartbeats
    upsertHeartbeat: _db.prepare(`INSERT INTO heartbeats (agent_id, platform, last_seen, current_task, status) VALUES (?, ?, unixepoch(), ?, 'active') ON CONFLICT(agent_id) DO UPDATE SET last_seen = unixepoch(), current_task = ?, status = 'active', platform = ?`),
    getHeartbeat: _db.prepare(`SELECT * FROM heartbeats WHERE agent_id = ?`),
    listHeartbeats: _db.prepare(`SELECT * FROM heartbeats ORDER BY last_seen DESC`),
    getStaleAgents: _db.prepare(`SELECT * FROM heartbeats WHERE last_seen < (unixepoch() - ?) AND status = 'active'`),
    markAgentIdle: _db.prepare(`UPDATE heartbeats SET status = 'idle', current_task = NULL WHERE agent_id = ?`),

    // Task comments and rejections
    insertTaskComment: _db.prepare(`INSERT INTO task_comments (id, task_id, author, comment, comment_type, in_reply_to, created_at) VALUES (?, ?, ?, ?, ?, ?, unixepoch())`),
    getTaskComments: _db.prepare(`SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC`),
    insertTaskRejection: _db.prepare(`INSERT INTO task_rejections (id, task_id, rejected_by, reason, guidance, created_at) VALUES (?, ?, ?, ?, ?, unixepoch())`),
    getTaskRejections: _db.prepare(`SELECT * FROM task_rejections WHERE task_id = ? ORDER BY created_at ASC`),

    // Projects
    createProject: _db.prepare(`INSERT INTO cortex_projects (id, name, slug, description, status, phase_count, created_by, default_reviewer, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, unixepoch(), unixepoch())`),
    listProjects: _db.prepare(`SELECT * FROM cortex_projects ORDER BY created_at DESC`),
    getProject: _db.prepare(`SELECT * FROM cortex_projects WHERE id = ?`),
    getProjectBySlug: _db.prepare(`SELECT * FROM cortex_projects WHERE slug = ?`),
    updateProjectPhaseCount: _db.prepare(`UPDATE cortex_projects SET phase_count = ?, updated_at = unixepoch() WHERE id = ?`),
    updateProjectStatus: _db.prepare(`UPDATE cortex_projects SET status = ?, updated_at = unixepoch() WHERE id = ?`),
    listTasksByCortexProject: _db.prepare(`SELECT * FROM cortex_tasks WHERE project_id = ? ORDER BY updated_at DESC, created_at DESC`),
    listTasksByPhase: _db.prepare(`SELECT * FROM cortex_tasks WHERE project_id = ? AND phase_number = ? ORDER BY created_at ASC`),
    listPhasesByProject: _db.prepare(`SELECT DISTINCT phase_number FROM cortex_tasks WHERE project_id = ? ORDER BY phase_number ASC`),
    countApprovedInPhase: _db.prepare(`SELECT COUNT(*) as count FROM cortex_tasks WHERE project_id = ? AND phase_number = ? AND status = 'approved'`),
    countTasksInPhase: _db.prepare(`SELECT COUNT(*) as count FROM cortex_tasks WHERE project_id = ? AND phase_number = ?`),
    projectTaskCounts: _db.prepare(`
      SELECT
        COUNT(*) as task_count,
        SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) as completed_count,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress_count,
        SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) as review_count
      FROM cortex_tasks
      WHERE project_id = ?
    `),
    projectCostSummary: _db.prepare(`
      SELECT COALESCE(SUM(cost_usd), 0) as total_cost_usd
      FROM gateway_logs
      WHERE project_id = ?
    `),

    // Context snapshots
    createContextSnapshot: _db.prepare(`INSERT INTO context_snapshots (id, agent_id, session_id, task_id, context_type, content, tags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`),
    listContextSnapshots: _db.prepare(`SELECT * FROM context_snapshots ORDER BY created_at DESC LIMIT ?`),
    listContextSnapshotsByType: _db.prepare(`SELECT * FROM context_snapshots WHERE context_type = ? ORDER BY created_at DESC LIMIT ?`),
    queryContextSnapshots: _db.prepare(`
      SELECT * FROM context_snapshots
      WHERE (? IS NULL OR task_id = ?)
        AND (? IS NULL OR created_at >= ?)
      ORDER BY created_at DESC
      LIMIT ?
    `),

    // Subagent events
    createSubagentEvent: _db.prepare(`INSERT INTO subagent_events (id, parent_agent, subagent_id, subagent_type, description, task_id, status) VALUES (?, ?, ?, ?, ?, ?, 'running')`),
    completeSubagentEvent: _db.prepare(`UPDATE subagent_events SET status = ?, completed_at = unixepoch(), duration_ms = ?, tool_calls = ?, result_summary = ? WHERE id = ?`),
    listSubagentsByParent: _db.prepare(`SELECT * FROM subagent_events WHERE parent_agent = ? ORDER BY started_at DESC LIMIT ?`),
    listSubagentsByTask: _db.prepare(`SELECT * FROM subagent_events WHERE task_id = ? ORDER BY started_at DESC`),
    listSubagentsRecent: _db.prepare(`SELECT * FROM subagent_events ORDER BY started_at DESC LIMIT ?`),
    getSubagentEvent: _db.prepare(`SELECT * FROM subagent_events WHERE id = ?`),

    // OTel events
    insertOtelEvent: _db.prepare(`
      INSERT INTO otel_events (
        source_agent, provider, run_id, thread_id, model, auth_mode,
        tokens_in, tokens_out, cost_usd, latency_ms, status, tool_name,
        tool_success, event_type, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    getRecentOtelEvents: _db.prepare(`SELECT * FROM otel_events ORDER BY id DESC LIMIT ?`),

    // Periodic cleanup
    staleSubagents: _db.prepare(`
      UPDATE subagent_events
      SET status = 'failed', completed_at = unixepoch()
      WHERE status = 'running'
      AND started_at < unixepoch() - 3600
    `),
    expiredBridgeMessages: _db.prepare(`
      DELETE FROM bridge_messages
      WHERE expires_at IS NOT NULL AND expires_at < unixepoch() - 86400
    `),

    // Daily log table pruning — retention configurable via LOG_RETENTION_DAYS
    // gateway_logs.created_at and otel_events.timestamp are TEXT (ISO datetime) — use unixepoch() conversion
    // audit_log.timestamp and progress_reports.timestamp are INTEGER (unix epoch) — compare directly
    pruneGatewayLogs: _db.prepare(`DELETE FROM gateway_logs WHERE unixepoch(created_at) < unixepoch() - (? * 86400)`),
    pruneOtelEvents: _db.prepare(`DELETE FROM otel_events WHERE unixepoch(timestamp) < unixepoch() - (? * 86400)`),
    pruneAuditLog: _db.prepare(`DELETE FROM audit_log WHERE unixepoch(timestamp) < unixepoch() - (? * 86400)`),
    pruneProgressReports: _db.prepare(`DELETE FROM progress_reports WHERE timestamp < unixepoch() - (? * 86400)`),
  };

  return { db: _db, stmts: _stmts };
}

export function getDb() { return _db; }
export function getStmts() { return _stmts; }

export function jsonParse(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

export function genId() {
  return crypto.randomUUID();
}
