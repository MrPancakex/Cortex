export const CORTEX_TOOLS = [
  {
    name: 'task_create',
    description: 'Create a new task in pending status and sync the task folder on disk. Requires project_id and phase_number. Does not claim it.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        project_id: { type: 'string', description: 'UUID of the project this task belongs to' },
        phase_number: { type: 'integer', description: 'Phase number within the project (1-based)' },
        priority: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['title', 'description', 'project_id', 'phase_number'],
    },
  },
  {
    name: 'task_get',
    description: 'Fetch a single task with full detail.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'task_list',
    description: 'List tasks with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        agent: { type: 'string' },
        project_id: { type: 'string' },
        source: { type: 'string' },
        limit: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'get_next_task',
    description: 'Fetch the next pending task for this platform without claiming it.',
    inputSchema: { type: 'object', properties: { platform: { type: 'string' } }, required: [] },
  },
  {
    name: 'claim_task',
    description: 'Claim an existing pending task.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'report_progress',
    description: 'Report progress on a claimed or in-progress task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string', enum: ['planning', 'implementation', 'in_progress', 'testing', 'reviewing'] },
        summary: { type: 'string' },
        files_changed: { type: 'array', items: { type: 'string' } },
      },
      required: ['task_id', 'status', 'summary'],
    },
  },
  {
    name: 'submit_result',
    description: 'Submit completed work for a task.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        summary: { type: 'string' },
        files_changed: { type: 'array', items: { type: 'string' } },
      },
      required: ['task_id', 'summary'],
    },
  },
  {
    name: 'request_verification',
    description: 'Move a submitted task into review and assign a reviewer.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        reviewer: { type: 'string' },
      },
      required: ['task_id', 'reviewer'],
    },
  },
  {
    name: 'task_approve',
    description: 'Approve a task in review.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, comment: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'task_reject',
    description: 'Reject a task in review.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string' },
        guidance: { type: 'string' },
      },
      required: ['task_id', 'reason'],
    },
  },
  {
    name: 'task_update',
    description: 'Update task metadata without changing task state.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'task_cancel',
    description: 'Cancel a task permanently.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id', 'reason'] },
  },
  {
    name: 'task_release',
    description: 'Release a claimed or in-progress task back to pending.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'task_reassign',
    description: 'Reassign a task to another agent as pending.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, new_agent: { type: 'string' } }, required: ['task_id', 'new_agent'] },
  },
  {
    name: 'task_comment',
    description: 'Add a note to a task.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, comment: { type: 'string' } }, required: ['task_id', 'comment'] },
  },
  {
    name: 'task_reopen',
    description: 'Reopen an approved or rejected task as pending.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, reason: { type: 'string' } }, required: ['task_id', 'reason'] },
  },
  {
    name: 'health_check',
    description: 'Return system health.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'agent_status',
    description: 'Return one agent or all agents.',
    inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: [] },
  },
  {
    name: 'heartbeat',
    description: 'Record an agent heartbeat.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, status: { type: 'string' } }, required: [] },
  },
  {
    name: 'agent_register',
    description: 'Register a new agent and return its token. Requires admin token.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        platform: { type: 'string' },
        model: { type: 'string' },
        provider: { type: 'string' },
      },
      required: ['name', 'platform'],
    },
  },
  {
    name: 'route_request',
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
  },
  {
    name: 'gateway_stats',
    description: 'Return aggregate gateway statistics.',
    inputSchema: { type: 'object', properties: { period: { type: 'string' } }, required: [] },
  },
  {
    name: 'cost_summary',
    description: 'Return token usage and cost summary for the current agent.',
    inputSchema: { type: 'object', properties: { period: { type: 'string' }, task_id: { type: 'string' } }, required: [] },
  },
  {
    name: 'logs_query',
    description: 'Return recent gateway logs for the current agent.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, status: { type: 'string' }, since: { type: 'string' } }, required: [] },
  },
  {
    name: 'error_history',
    description: 'Return recent gateway errors for the current agent.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, since: { type: 'string' } }, required: [] },
  },
  {
    name: 'bridge_send',
    description: 'Send a typed message to another agent. Types: review_request, review_verdict, task_handoff, question, answer, status_update, context_share, error_report, task_complete_notify, human_directive, text.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target agent ID, "all" for broadcast, or role name' },
        type: { type: 'string', description: 'Message type (e.g. review_request, question, status_update)' },
        subject: { type: 'string' },
        body: { type: 'string' },
        task_id: { type: 'string' },
        context: { type: 'object', description: 'Structured context data for the message type' },
        blocking: { type: 'boolean', description: 'If true, receiver must address before continuing' },
        priority: { type: 'string', enum: ['normal', 'urgent', 'critical'] },
        // Type-specific fields passed through
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
      },
      required: ['to'],
    },
  },
  {
    name: 'bridge_inbox',
    description: 'Read bridge messages for the current agent.',
    inputSchema: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean' },
        mark_read: { type: 'boolean' },
        limit: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'bridge_poll',
    description: 'Check for unread messages. Use when idle or between tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'bridge_reply',
    description: 'Reply to a bridge message.',
    inputSchema: { type: 'object', properties: { message_id: { type: 'string' }, body: { type: 'string' } }, required: ['message_id', 'body'] },
  },
  {
    name: 'bridge_ack',
    description: 'Acknowledge receipt of a bridge message.',
    inputSchema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'] },
  },
  {
    name: 'context_save',
    description: 'Store a context snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        context_type: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        session_id: { type: 'string' },
        task_id: { type: 'string' },
      },
      required: ['context_type', 'content'],
    },
  },
  {
    name: 'context_retrieve',
    description: 'Retrieve stored context snapshots.',
    inputSchema: {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
        query: { type: 'string' },
        since: { type: 'string' },
        task_id: { type: 'string' },
        limit: { type: 'number' },
      },
      required: [],
    },
  },
  {
    name: 'context_list',
    description: 'List context snapshots without full content.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number' }, context_type: { type: 'string' } }, required: [] },
  },
  {
    name: 'project_create',
    description: 'Create a project. Optionally set a default reviewer for all tasks in this project.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, description: { type: 'string' }, default_reviewer: { type: 'string', description: 'Agent who reviews all tasks in this project by default' } }, required: ['name'] },
  },
  {
    name: 'project_list',
    description: 'List projects.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'project_get',
    description: 'Fetch a project with task detail.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  },
  {
    name: 'project_summary',
    description: 'Fetch a human-readable project summary.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  },
  {
    name: 'project_connect',
    description: 'Connect to a project. Writes project ID to the runtime active-project file so the gate allows writes.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  },
  {
    name: 'project_disconnect',
    description: 'Disconnect from the active project. Removes the runtime active-project file.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },

  // ═══ MCP Tools v2 ═══

  // Task
  {
    name: 'task_delete',
    description: 'Permanently delete a task and its workspace folder. Admin only.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'task_audit',
    description: 'View the full audit trail for a task — every state change, who did it, when.',
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'task_batch_status',
    description: 'Get status of multiple tasks in one call. Pass an array of task IDs.',
    inputSchema: { type: 'object', properties: { task_ids: { type: 'array', items: { type: 'string' } } }, required: ['task_ids'] },
  },

  // Project
  {
    name: 'project_update',
    description: 'Update project name, description, status, or default reviewer.',
    inputSchema: {
      type: 'object',
      properties: {
        project_id: { type: 'string' },
        default_reviewer: { type: 'string', description: 'Default reviewer agent for tasks in this project' },
        name: { type: 'string' },
        description: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['project_id'],
    },
  },
  {
    name: 'project_delete',
    description: 'Permanently delete a project, all its tasks, and workspace folder. Admin only.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  },
  {
    name: 'phase_add',
    description: 'Add a new phase to a project. Creates the phase folder and PHASE-README.md.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  },
  {
    name: 'phase_delete',
    description: 'Delete a phase and all its tasks from a project. Admin only.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' }, phase_number: { type: 'integer' } }, required: ['project_id', 'phase_number'] },
  },
  {
    name: 'phase_list',
    description: 'List all phases in a project with completion status.',
    inputSchema: { type: 'object', properties: { project_id: { type: 'string' } }, required: ['project_id'] },
  },

  // Observability
  {
    name: 'telemetry_report',
    description: 'Report token usage and cost to the gateway for tracking. Use after completing work.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', description: 'What was done (e.g. TASK_COMPLETE, SESSION)' },
        endpoint: { type: 'string', description: 'Task title or identifier' },
        model: { type: 'string' },
        tokens_in: { type: 'integer' },
        tokens_out: { type: 'integer' },
        cost_usd: { type: 'number' },
        latency_ms: { type: 'integer' },
      },
      required: ['method', 'tokens_in', 'tokens_out', 'cost_usd'],
    },
  },
  {
    name: 'sidecar_health',
    description: 'Probe all known sidecar services and return their health status.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'model_list',
    description: 'List available Ollama models.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'my_stats',
    description: 'Get your own token usage, cost, and request stats.',
    inputSchema: { type: 'object', properties: { period: { type: 'string' } }, required: [] },
  },
  {
    name: 'subagent_list',
    description: 'List your spawned subagents and their status/duration.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } }, required: [] },
  },
  {
    name: 'subagent_register',
    description: 'Register a spawned sub-agent so it appears in the dashboard. Call this when you spawn a sub-agent or background task.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the sub-agent is doing' },
        subagent_type: { type: 'string', description: 'Type: general-purpose, researcher, reviewer, etc.' },
        task_id: { type: 'string', description: 'Task ID the sub-agent is working on (optional)' },
      },
      required: ['description'],
    },
  },
  {
    name: 'subagent_complete',
    description: 'Mark a sub-agent as completed with duration and results. Call when a sub-agent finishes.',
    inputSchema: {
      type: 'object',
      properties: {
        event_id: { type: 'string', description: 'The event_id returned from subagent_register' },
        status: { type: 'string', description: 'completed or failed' },
        duration_ms: { type: 'integer', description: 'How long it ran in milliseconds' },
        tool_calls: { type: 'integer', description: 'Number of tool calls made' },
        result_summary: { type: 'string', description: 'Brief summary of what was accomplished' },
      },
      required: ['event_id'],
    },
  },

  // Bridge
  {
    name: 'bridge_broadcast',
    description: 'Send a message to all agents at once.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
        body: { type: 'string' },
        type: { type: 'string' },
        priority: { type: 'string', enum: ['normal', 'urgent', 'critical'] },
        task_id: { type: 'string' },
      },
      required: ['body'],
    },
  },
  {
    name: 'bridge_thread',
    description: 'Get the full reply chain for a message.',
    inputSchema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'] },
  },
  {
    name: 'bridge_mark_read',
    description: 'Mark specific messages as read without acknowledging.',
    inputSchema: { type: 'object', properties: { message_ids: { type: 'array', items: { type: 'string' } } }, required: ['message_ids'] },
  },

  // System
  {
    name: 'stale_agents',
    description: 'List agents that have not heartbeated within a threshold.',
    inputSchema: { type: 'object', properties: { seconds: { type: 'integer', description: 'Stale threshold in seconds (default 600)' } }, required: [] },
  },
  {
    name: 'agent_update',
    description: 'Update an agent model, provider, or status.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string' },
        model: { type: 'string' },
        provider: { type: 'string' },
        status: { type: 'string' },
      },
      required: ['agent_id'],
    },
  },
];
