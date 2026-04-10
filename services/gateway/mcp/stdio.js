import { readFileSync } from 'node:fs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createCortexMCPServer } from './server.js';

const GATEWAY_URL = process.env.CORTEX_API || 'http://127.0.0.1:4840';
const AGENT_ID = process.env.CORTEX_AGENT_ID || 'unknown';
const AGENT_PLATFORM = process.env.CORTEX_AGENT_PLATFORM || AGENT_ID;

// Derive paths from agent ID — env vars override if set
const CORTEX_TOKEN_DIR = process.env.CORTEX_TOKEN_DIR || '/etc/cortex/agents';
const CORTEX_RUN_DIR = process.env.CORTEX_RUN_DIR || '/run/cortex';
const TOKEN_FILE = process.env.CORTEX_AGENT_TOKEN_FILE || `${CORTEX_TOKEN_DIR}/${AGENT_ID}.env`;
const CURRENT_TASK_FILE = process.env.CORTEX_CURRENT_TASK_FILE || `${CORTEX_RUN_DIR}/${AGENT_ID}-current-task`;

// Load agent token — from env var directly, or read from token file
let AGENT_TOKEN = process.env.CORTEX_AGENT_TOKEN || null;
if (!AGENT_TOKEN) {
  try {
    const content = readFileSync(TOKEN_FILE, 'utf8');
    const match = content.match(/CORTEX_AGENT_TOKEN=(.+)/);
    if (match) AGENT_TOKEN = match[1].trim();
  } catch (err) {
    process.stderr.write(`[cortex-mcp] WARNING: could not read token file ${TOKEN_FILE}: ${err.message}\n`);
  }
}
if (!AGENT_TOKEN) {
  process.stderr.write('[cortex-mcp] WARNING: no agent token loaded — authenticated routes will fail\n');
}

const gateway = {
  config: {
    agentId: AGENT_ID,
    agentPlatform: AGENT_PLATFORM,
    agentToken: AGENT_TOKEN,
    gatewayUrl: GATEWAY_URL,
    currentTaskFile: CURRENT_TASK_FILE,
  },
};
const server = createCortexMCPServer(gateway);
const transport = new StdioServerTransport();

await server.connect(transport);
