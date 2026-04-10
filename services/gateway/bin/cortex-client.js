#!/usr/bin/env bun
/**
 * cortex client — agent token management CLI.
 *
 * Usage:
 *   sudo cortex client add <agent>       — generate token, write to registry + agent env files
 *   sudo cortex client list              — show registered agents (no tokens)
 *   sudo cortex client rotate <agent>    — new token, update hash, reload service
 *   sudo cortex client remove <agent>    — delete entry, reload service
 *   cortex client verify <agent>         — test token against registry (no sudo needed)
 *
 * Every write triggers: systemctl reload cortex-gateway
 */
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, chownSync, chmodSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

import { homedir } from 'node:os';

const HOME = homedir();
const REGISTRY_PATH = process.env.CORTEX_TOKEN_REGISTRY
  || join(HOME, '.cortex', 'data', 'token-registry.json');
const AGENTS_DIR = process.env.CORTEX_AGENTS_DIR
  || join(HOME, '.cortex', 'agents');

// ---------------------------------------------------------------------------
// Registry helpers
// ---------------------------------------------------------------------------

function loadRegistry() {
  try {
    return JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  } catch {
    return { agents: {} };
  }
}

function saveRegistry(registry) {
  const dir = join(REGISTRY_PATH, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n', { mode: 0o640 });

  // Ensure correct ownership: root:cortex
  try {
    const cortexGid = getGroupId('cortex');
    if (cortexGid !== null) {
      chownSync(REGISTRY_PATH, 0, cortexGid);
    }
  } catch { /* non-fatal */ }
}

function getGroupId(name) {
  try {
    const line = execSync(`getent group ${name}`, { encoding: 'utf8' }).trim();
    return parseInt(line.split(':')[2], 10);
  } catch {
    return null;
  }
}

function getUserId(name) {
  try {
    const line = execSync(`id -u ${name}`, { encoding: 'utf8' }).trim();
    return parseInt(line, 10);
  } catch {
    return null;
  }
}

function generateToken(agentName) {
  const raw = `cortex_${agentName}_${randomBytes(32).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

function reloadService() {
  try {
    execSync('systemctl reload cortex-gateway.service 2>/dev/null || systemctl restart cortex-gateway.service', {
      stdio: 'pipe',
    });
    console.log('  Service reloaded');
  } catch {
    console.log('  Warning: could not reload cortex-gateway service');
  }
}

// ---------------------------------------------------------------------------
// Write token to provisioning file (/etc/cortex/agents/<agent>.env)
// ---------------------------------------------------------------------------
function writeProvisioningFile(agent, rawToken) {
  mkdirSync(AGENTS_DIR, { recursive: true });
  const envPath = join(AGENTS_DIR, `${agent}.env`);
  const content = `CORTEX_AGENT_TOKEN=${rawToken}\n`;
  writeFileSync(envPath, content, { mode: 0o640 });

  const gid = getGroupId(agent);
  if (gid !== null) {
    chownSync(envPath, 0, gid);
  }
  console.log(`  Provisioning: ${envPath}`);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdAdd(agent) {
  if (!agent || !/^[a-zA-Z0-9_-]+$/.test(agent)) {
    console.error('Error: agent name must be alphanumeric (with - and _ allowed)');
    process.exit(1);
  }

  const registry = loadRegistry();
  if (registry.agents[agent]) {
    console.error(`Error: agent '${agent}' already registered. Use 'rotate' to change token.`);
    process.exit(1);
  }

  const { raw, hash } = generateToken(agent);

  registry.agents[agent] = {
    hash,
    platform: agent,
    created: new Date().toISOString(),
  };

  saveRegistry(registry);
  writeProvisioningFile(agent, raw);
  reloadService();

  console.log(`\n  Agent '${agent}' registered.`);
  console.log(`\n  Token (shown ONCE — save it):\n  ${raw}\n`);
}

function cmdAddAdmin(name) {
  const registry = loadRegistry();
  if (registry.agents[name]) {
    console.error(`Error: '${name}' already registered. Use 'rotate' to change token.`);
    process.exit(1);
  }

  const raw = `cortex_admin_${randomBytes(32).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');

  registry.agents[name] = {
    hash,
    platform: 'admin',
    role: 'admin',
    created: new Date().toISOString(),
  };

  saveRegistry(registry);
  reloadService();

  console.log(`\n  Admin '${name}' registered.`);
  console.log(`\n  Token (shown ONCE — save it):\n  ${raw}\n`);
}

function cmdList() {
  const registry = loadRegistry();
  const agents = Object.entries(registry.agents);

  if (agents.length === 0) {
    console.log('No agents registered.');
    return;
  }

  console.log(`\n  ${'Agent'.padEnd(15)} ${'Platform'.padEnd(10)} ${'Role'.padEnd(8)} Created`);
  console.log(`  ${'─'.repeat(15)} ${'─'.repeat(10)} ${'─'.repeat(8)} ${'─'.repeat(24)}`);
  for (const [name, config] of agents) {
    console.log(`  ${name.padEnd(15)} ${(config.platform || '-').padEnd(10)} ${(config.role || 'agent').padEnd(8)} ${config.created || '-'}`);
  }
  console.log('');
}

function cmdRotate(agent) {
  const registry = loadRegistry();
  if (!registry.agents[agent]) {
    console.error(`Error: agent '${agent}' not registered.`);
    process.exit(1);
  }

  const { raw, hash } = generateToken(agent);
  const existing = registry.agents[agent];

  registry.agents[agent] = {
    ...existing,
    hash,
    rotated: new Date().toISOString(),
  };

  saveRegistry(registry);

  writeProvisioningFile(agent, raw);

  reloadService();

  console.log(`\n  Agent '${agent}' token rotated.`);
  console.log(`\n  New token (shown ONCE — save it):\n  ${raw}\n`);
}

function cmdRemove(agent) {
  const registry = loadRegistry();
  if (!registry.agents[agent]) {
    console.error(`Error: agent '${agent}' not registered.`);
    process.exit(1);
  }

  delete registry.agents[agent];
  saveRegistry(registry);
  reloadService();

  console.log(`  Agent '${agent}' removed.`);
}

function cmdVerify(agent) {
  const registry = loadRegistry();
  if (!registry.agents[agent]) {
    console.error(`Error: agent '${agent}' not in registry.`);
    process.exit(1);
  }

  let token = null;

  // Try agents dir first
  try {
    const envContent = readFileSync(join(AGENTS_DIR, `${agent}.env`), 'utf8');
    const match = envContent.match(/CORTEX_AGENT_TOKEN=(.+)/);
    if (match) token = match[1].trim();
  } catch { /* fall through */ }

  if (!token) {
    console.error(`  Could not read token for '${agent}' from ${AGENTS_DIR}/${agent}.env.`);
    process.exit(1);
  }

  const hash = createHash('sha256').update(token).digest('hex');
  const expected = registry.agents[agent].hash;

  if (hash === expected) {
    console.log(`  ✓ Token for '${agent}' is valid (hash matches registry).`);
  } else {
    console.error(`  ✗ Token for '${agent}' does NOT match registry hash.`);
    console.error(`    Expected: ${expected.slice(0, 16)}...`);
    console.error(`    Got:      ${hash.slice(0, 16)}...`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

// Handle "cortex client <cmd>" invocation (skip "client" if present)
const cmdArgs = args[0] === 'client' ? args.slice(1) : args;
const command = cmdArgs[0];
const target = cmdArgs[1];

switch (command) {
  case 'add':
    if (!target) { console.error('Usage: cortex client add <agent>'); process.exit(1); }
    cmdAdd(target);
    break;
  case 'add-admin':
    if (!target) { console.error('Usage: cortex client add-admin <name>'); process.exit(1); }
    cmdAddAdmin(target);
    break;
  case 'list':
    cmdList();
    break;
  case 'rotate':
    if (!target) { console.error('Usage: cortex client rotate <agent>'); process.exit(1); }
    cmdRotate(target);
    break;
  case 'remove':
    if (!target) { console.error('Usage: cortex client remove <agent>'); process.exit(1); }
    cmdRemove(target);
    break;
  case 'verify':
    if (!target) { console.error('Usage: cortex client verify <agent>'); process.exit(1); }
    cmdVerify(target);
    break;
  default:
    console.log(`cortex client — agent token management

Commands:
  sudo cortex client add <agent>        Register agent (atlas|zeus|gerald)
  sudo cortex client add-admin <name>   Register admin user
  sudo cortex client list               List registered agents
  sudo cortex client rotate <agent>     Rotate agent token
  sudo cortex client remove <agent>     Remove agent
  cortex client verify <agent>          Verify token matches registry`);
    break;
}
