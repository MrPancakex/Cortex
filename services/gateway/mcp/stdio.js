#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { swallow } from '@cortex/sdk/errors';
import { createCortexMCPServer } from './transport.js';
import { bootstrapStdioGateway } from './stdio-bootstrap.js';
import { mountChannelEmit } from './channel/index.js';

// All the heavy lifting — session slot claim, PPID pointer, token file
// search, SIGINT/SIGTERM cleanup, gateway config assembly — is in
// stdio-bootstrap.js so this entrypoint stays ~25 lines.
const { gateway, cleanup } = await bootstrapStdioGateway();

const server = createCortexMCPServer(gateway);
await server.connect(new StdioServerTransport());

// Mount the channel emitter AFTER connect so the transport is live when
// the initial drain fires. session id = agentId (we're in the same process
// so no pointer-file scan needed). Token forwarded from bootstrap — avoids
// a second resolver call.
const { agentId, agentToken, gatewayUrl } = gateway.config;
const baseAgent = process.env.CORTEX_AGENT_ID || agentId;

// The standalone cortex-channel plugin (plugins/cortex-channel/main.js) is the
// canonical channel emitter and the one registered as turn-firing via the
// launcher's `--channels server:cortex-channel` flag. This in-process emitter on
// the (unregistered) `cortex` tools server raced it to drain+ack the inbox and
// emitted on a transport Claude Code does NOT treat as a channel — so the message
// was acked but no turn fired. Disabled by default so the standalone plugin is
// the sole emitter. Set CORTEX_MCP_INPROC_CHANNEL=1 to re-enable (topologies
// with no standalone plugin).
const inprocChannelEnabled = process.env.CORTEX_MCP_INPROC_CHANNEL === '1';
const channel = inprocChannelEnabled
  ? await mountChannelEmit({
      mcp: server,
      sessionId: agentId,
      baseAgent,
      token: agentToken,
      gatewayUrl,
      swallow: (metric, err) => swallow(metric, err),
    }).catch((err) => {
      swallow('mcp.channel_mount_failed', err);
      process.stderr.write(`[cortex-mcp] WARNING: channel mount failed: ${err?.message}\n`);
      return { stop() {} };
    })
  : { stop() {} };

function fullCleanup() {
  channel.stop();
  cleanup();
}

process.on('exit',    fullCleanup);
process.on('SIGINT',  () => { fullCleanup(); process.exit(130); });
process.on('SIGTERM', () => { fullCleanup(); process.exit(143); });
process.on('uncaughtException', (err) => {
  process.stderr.write(`[cortex-mcp] uncaught: ${err?.stack || err}\n`);
  fullCleanup();
  process.exit(1);
});
