import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { TOOL_REGISTRY } from './tools/_registry.js';
import { dispatchTool } from './dispatch.js';

// §12.4 reduction: hints.js, resources.js, prompts.js deliberately dropped.
// Per-tool next_step_hint is set inline in each handler instead.

const CORTEX_TOOLS = Object.values(TOOL_REGISTRY).map(entry => ({
  name: entry.definition.name,
  description: entry.definition.description,
  inputSchema: entry.definition.inputSchema,
}));

export function createCortexMCPServer(gateway) {
  const server = new Server(
    { name: 'cortex-gateway', version: '0.2.0' },
    {
      capabilities: {
        tools: {},
        experimental: { 'claude/channel': {} },
      },
      instructions: [
        'Messages from Cortex arrive as <channel source="cortex" type="..." from="..." task_id="..." message_id="..." ts="...">.',
        'These are bridge messages from the Cortex orchestrator or other agents.',
        'Act on them according to your Cortex protocol in CLAUDE.md.',
        'Use your existing bridge_reply, bridge_send, and task MCP tools to respond.',
        'Do not ignore channel messages — they represent assigned work or review feedback.',
      ].join('\n'),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: CORTEX_TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args = {} } = req.params;
    try {
      const result = await dispatchTool(name, args, gateway);
      const text = JSON.stringify(result, null, 2);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${err.message}` }] };
    }
  });

  return server;
}
