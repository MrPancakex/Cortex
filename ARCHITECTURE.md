# Cortex Architecture Reference

## Ports

| Port | Service | Notes |
|------|---------|-------|
| 4840 | Gateway (Bun) | All API, MCP, and WebSocket — the one true backend |
| 4830 | Dashboard backend (Express) | Proxy only — injects admin token, forwards to :4840 |

---

## File Locations

### Gateway — services/gateway/
| File | Purpose |
|------|---------|
| server.js | HTTP route registration, auth middleware, WebSocket setup |
| lib/auth.js | Token verification, agent identity, requiresAuth() |
| lib/db.js | SQLite schema, all prepared statements, MAX_REJECTIONS=5 |
| lib/proxy.js | Upstream LLM routing, broadcastLog() for WebSocket dashboard |
| lib/rate-limit.js | Per-agent request rate limiting |
| lib/task-files.js | Task folder sync to projects/ directory |
| lib/credentials.js | Credential storage |
| lib/otel.js | OpenTelemetry log ingestion |
| routes/cortex-tasks.js | Task lifecycle — claim, submit, review, approve, reject |
| routes/model.js | LLM model management and call proxy |
| routes/stats.js | Aggregate stats and cost tracking |
| routes/services.js | Service event logging |
| routes/tasks.js | Additional task endpoints |
| mcp/stdio.js | MCP stdio transport — what agents connect through |
| mcp/tools.js | 59 MCP tool definitions |
| mcp/tool-handlers.js | Tool implementations — direct SQLite, no HTTP loopback |
| mcp/server.js | MCP session lifecycle management |
| mcp/resources.js | MCP resource definitions |
| mcp/hints.js | System hints injected into agent context |
| mcp/prompts.js | Prompt templates |

### Dashboard — platform/
| File | Purpose |
|------|---------|
| platform/backend/server.js | Express proxy :4830 → :4840 |
| platform/backend/routes/gateway-proxy.js | Forwards /api/* to gateway |
| platform/backend/routes/dashboard.js | Dashboard-specific routes |
| platform/backend/routes/system.js | System info routes |
| platform/frontend/src/ | Vite/React UI — do not modify unless asked |

### Bots — bots/
| Directory | Agent | Runtime |
|-----------|-------|---------|
| bots/atlas/ | Executor | Claude Code (Opus 4.6) |
| bots/zeus/ | Reviewer | Codex or Claude Code |
| bots/gerald/ | Code quality auditor | Hermes |
| bots/faust/ | Repo quality reviewer | Hermes |

### Other
| Path | Purpose |
|------|---------|
| /home/Atlas/workspace/cortex/sdk/index.js | CortexClient SDK |
| data/token-registry.json | Agent token registry |
| projects/ | Human-readable task folders synced from DB |
| outputs/Agents/ | Agent session logs and history |

---

## MCP Tools (59)

### Task Management
`task_create` `task_get` `task_list` `get_next_task` `claim_task` `report_progress`
`submit_result` `request_verification` `task_approve` `task_reject` `task_update`
`task_cancel` `task_release` `task_reassign` `task_comment` `task_reopen`
`task_delete` `task_audit` `task_batch_status`

### Project & Phase Management
`project_create` `project_list` `project_get` `project_summary` `project_connect`
`project_disconnect` `project_update` `project_delete`
`phase_add` `phase_delete` `phase_list`

### Agent Management
`agent_status` `agent_register` `agent_update` `heartbeat` `stale_agents`

### Bridge Messaging
`bridge_send` `bridge_inbox` `bridge_poll` `bridge_reply` `bridge_ack`
`bridge_broadcast` `bridge_thread` `bridge_mark_read`

### Context
`context_save` `context_retrieve` `context_list`

### Sub-agent Tracking
`subagent_register` `subagent_complete` `subagent_list`

### Gateway / System
`health_check` `route_request` `gateway_stats` `cost_summary` `logs_query`
`error_history` `sidecar_health` `telemetry_report` `model_list` `my_stats`

---

## Database Schema

**Location:** `~/.cortex/data/gateway.db` (SQLite)

### bots
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| name | TEXT | |
| version | TEXT | |
| endpoint | TEXT | default '' |
| capabilities | TEXT | JSON array, default '[]' |
| status | TEXT | default 'registered' |
| last_heartbeat | INTEGER | |
| registered_at | INTEGER | |
| meta | TEXT | JSON, default '{}' |

### heartbeats
| Column | Type | Notes |
|--------|------|-------|
| agent_id | TEXT PK | |
| platform | TEXT | |
| last_seen | INTEGER | |
| current_task | TEXT | |
| status | TEXT | default 'idle' |

### agents
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| name | TEXT | |
| model | TEXT | default '' |
| provider | TEXT | default 'ollama' |
| status | TEXT | default 'idle' |
| last_active | TEXT | |

### cortex_tasks
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| title | TEXT | |
| description | TEXT | |
| status | TEXT | pending/claimed/in_progress/submitted/review/approved/rejected/cancelled/failed |
| source | TEXT | human/agent |
| created_by | TEXT | |
| assigned_agent | TEXT | |
| assigned_platform | TEXT | |
| project_id | TEXT | |
| priority | TEXT | low/medium/high/critical |
| tags | TEXT | JSON array |
| claimed_at | INTEGER | |
| submitted_at | INTEGER | |
| approved_at | INTEGER | |
| rejected_at | INTEGER | |
| cancelled_at | INTEGER | |
| verified_at | INTEGER | |
| created_at | INTEGER | unixepoch() |
| updated_at | INTEGER | unixepoch() |
| result_summary | TEXT | |
| reviewer_agent | TEXT | |
| review_feedback | TEXT | |
| cancel_reason | TEXT | |
| cancelled_by | TEXT | |

### progress_reports
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | |
| task_id | TEXT | FK cortex_tasks |
| agent_id | TEXT | |
| status | TEXT | |
| summary | TEXT | |
| files_changed | TEXT | |
| stub_detected | INTEGER | |
| stub_reason | TEXT | |
| timestamp | INTEGER | unixepoch() |

### task_comments
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| task_id | TEXT | FK cortex_tasks |
| author | TEXT | |
| comment | TEXT | |
| comment_type | TEXT | default 'note' |
| in_reply_to | TEXT | |
| created_at | INTEGER | unixepoch() |

### task_rejections
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| task_id | TEXT | FK cortex_tasks |
| rejected_by | TEXT | |
| reason | TEXT | |
| guidance | TEXT | |
| created_at | INTEGER | unixepoch() |

### bridge_messages
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| from_agent | TEXT | |
| to_agent | TEXT | |
| type | TEXT | |
| content | TEXT | |
| task_id | TEXT | |
| files | TEXT | JSON array |
| read | INTEGER | default 0 |
| created_at | TEXT | datetime('now') |

### cortex_projects
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| name | TEXT | |
| description | TEXT | |
| status | TEXT | default 'active' |
| created_by | TEXT | |
| created_at | INTEGER | unixepoch() |
| updated_at | INTEGER | unixepoch() |

### context_snapshots
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| agent_id | TEXT | |
| session_id | TEXT | |
| task_id | TEXT | |
| context_type | TEXT | |
| content | TEXT | |
| tags | TEXT | JSON array |
| created_at | INTEGER | unixepoch() |

### subagent_events
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| parent_agent | TEXT | |
| subagent_id | TEXT | |
| subagent_type | TEXT | default 'general-purpose' |
| description | TEXT | |
| task_id | TEXT | |
| status | TEXT | running/completed/failed |
| started_at | INTEGER | unixepoch() |
| completed_at | INTEGER | |
| duration_ms | INTEGER | |
| tool_calls | INTEGER | |
| result_summary | TEXT | |

### gateway_logs
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | |
| request_id | TEXT | |
| timestamp | TEXT | datetime('now') |
| method | TEXT | |
| path | TEXT | |
| provider | TEXT | |
| model | TEXT | |
| agent_id | TEXT | |
| project_id | TEXT | |
| tokens_in | INTEGER | |
| tokens_out | INTEGER | |
| cost_usd | REAL | |
| latency_ms | INTEGER | |
| status_code | INTEGER | |
| error | TEXT | |
| created_at | TEXT | datetime('now') |

### otel_events
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | |
| source_agent | TEXT | |
| provider | TEXT | |
| run_id | TEXT | |
| thread_id | TEXT | |
| model | TEXT | |
| auth_mode | TEXT | |
| tokens_in | INTEGER | |
| tokens_out | INTEGER | |
| cost_usd | REAL | |
| latency_ms | INTEGER | |
| status | TEXT | |
| tool_name | TEXT | |
| tool_success | INTEGER | |
| event_type | TEXT | |
| timestamp | TEXT | datetime('now') |

### audit_log
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | |
| task_id | TEXT | |
| agent_id | TEXT | |
| event_type | TEXT | |
| payload | TEXT | |
| timestamp | INTEGER | unixepoch() |

### tasks (legacy)
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| bot_id | TEXT | FK bots |
| project_id | TEXT | |
| type | TEXT | |
| payload | TEXT | JSON |
| status | TEXT | default 'pending' |
| result | TEXT | |
| created_at | INTEGER | |
| started_at | INTEGER | |
| completed_at | INTEGER | |

### model_calls
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| source | TEXT | |
| provider | TEXT | |
| model | TEXT | |
| task_id | TEXT | |
| tokens_in | INTEGER | |
| tokens_out | INTEGER | |
| cost | REAL | |
| error | TEXT | |
| status | TEXT | default 'pending' |
| latency_ms | INTEGER | |
| created_at | TEXT | datetime('now') |

### usage
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | |
| bot_id | TEXT | FK bots |
| project_id | TEXT | |
| type | TEXT | |
| units | REAL | |
| unit_label | TEXT | default 'tokens' |
| cost_usd | REAL | |
| recorded_at | INTEGER | |
| meta | TEXT | JSON |

### service_events
| Column | Type | Notes |
|--------|------|-------|
| id | INTEGER PK AUTOINCREMENT | |
| service | TEXT | |
| event | TEXT | |
| payload | TEXT | JSON |
| created_at | INTEGER | |

### agent_tasks (legacy)
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | |
| title | TEXT | |
| description | TEXT | |
| agent | TEXT | |
| project_id | TEXT | |
| priority | TEXT | default 'medium' |
| type | TEXT | default 'task' |
| status | TEXT | default 'pending' |
| created_at | TEXT | datetime('now') |
| updated_at | TEXT | datetime('now') |

---

## Data Flow

```
Agent MCP call
  → mcp/stdio.js            (stdin/stdout transport)
  → mcp/server.js           (session dispatch)
  → mcp/tool-handlers.js    (execution)
  → SQLite direct           (no HTTP loopback)
  → broadcastLog()          → WebSocket → dashboard

Agent HTTP call
  → server.js
  → requiresAuth()
  → route handler
  → SQLite

Dashboard request
  → platform/backend :4830
  → gateway-proxy.js
  → gateway :4840
  → route handler
  → SQLite
```

---

## Task State Machine

```
pending
  └─(claim_task)──→ claimed
                      └─(work)──→ in_progress
                                    └─(submit_result)──→ submitted
                                                           └─(request_verification)──→ review
                                                                                         ├─(task_approve)──→ approved  [terminal]
                                                                                         └─(task_reject) ──→ rejected
                                                                                                              └─(rework)──→ in_progress
                                                                                                                   [max 5 cycles, 6th returns HTTP 422]
Any state ──(task_cancel)──→ cancelled  [terminal]
```

**Key rules:**
- `MAX_REJECTIONS = 5` in db.js — 6th `request_verification` on a rejected task returns 422
- `rejection_count` returned in every `task_get` response
- Status value in DB is `'review'` (not `'under_review'`)

---

## Active System Constraints

| Constraint | Detail |
|------------|--------|
| No HTTP loopback | tool-handlers.js uses direct SQLite, not gatewayJson() |
| Gate cache | /tmp/cortex-gate-cache-{TASK_ID} — 60s TTL |
| Progress throttle | report-changes.sh fires every 10th edit or milestone keyword |
| Heartbeat backoff | SDK: 30s → 60s → 120s → 240s → 300s cap on failure |
| Log retention | gateway_logs, otel_events, audit_log, progress_reports pruned after 30d |
| Subagent GC | subagent_events with status=running older than 1h → failed, every 10 min |
