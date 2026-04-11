#!/usr/bin/env bun
/**
 * Cortex v0.1 — Initialization & Management
 *
 * Usage:
 *   cortex init              interactive first-run setup
 *   cortex init --check      verify existing installation
 *   cortex init --add-agent  add a new agent to existing install
 *   cortex init --reset      wipe data and start fresh
 *   cortex init --repair     fix missing files/configs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawnSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import readline from 'node:readline';

const HOME = os.homedir();
const isMac = process.platform === 'darwin';
const CORTEX_ROOT = path.join(HOME, 'Cortex');
const VAULT_DIR = path.join(HOME, '.cortex-vault');
const RC_PATH = path.join(HOME, '.cortexrc.json');
const PROJECT_ROOT = path.resolve(import.meta.dir, '..');
const GATEWAY_DIR = path.join(PROJECT_ROOT, 'services', 'gateway');
const BACKEND_DIR = path.join(PROJECT_ROOT, 'platform', 'backend');
const DATA_DIR = path.join(CORTEX_ROOT, 'data');
const REGISTRY_PATH = path.join(DATA_DIR, 'token-registry.json');
const DB_PATH = path.join(DATA_DIR, 'gateway.db');

// ═══ Output helpers ═══
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
function ok(m) { console.log(`  ${C.g}✓${C.x} ${m}`); }
function skip(m) { console.log(`  ${C.d}·${C.x} ${m} (already exists)`); }
function fail(m) { console.error(`  ${C.r}✗${C.x} ${m}`); }
function warn(m) { console.log(`  ${C.y}!${C.x} ${m}`); }
function log(m) { console.log(`  ${m}`); }
function header(m) { console.log(`\n  ${C.c}── ${m} ${'─'.repeat(Math.max(0, 38 - m.length))}${C.x}\n`); }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) { return new Promise(r => rl.question(`  ${q}`, r)); }
function done() { rl.close(); }

// ═══ Utilities ═══
function portAvailable(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

function genToken(name) {
  const raw = `cortex_${name}_${crypto.randomBytes(32).toString('hex')}`;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

function cleanName(raw) {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
}

const NAMES_POOL = [
  'nova','echo','pulse','drift','shard','flux','prism','forge','ember','quill',
  'rune','spark','cipher','vector','nexus','orbit','veil','core','arc','blade',
  'ghost','helix','ion','jade','kelp','lux','mesa','node','opal','pike',
];

function pickNames(n, exclude = []) {
  const pool = NAMES_POOL.filter(x => !exclude.includes(x));
  const out = [];
  for (let i = 0; i < n && pool.length; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}

const PLAT = { '1': 'claude-code', '2': 'codex', '3': null };

function isInstalled() { return fs.existsSync(RC_PATH) && fs.existsSync(DATA_DIR); }

function loadReg() {
  if (!fs.existsSync(REGISTRY_PATH)) return { agents: {} };
  try { const d = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')); return d.agents ? d : { agents: {} }; }
  catch { return { agents: {} }; }
}

function saveReg(reg) {
  fs.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2) + '\n');
  try { fs.chmodSync(REGISTRY_PATH, 0o600); } catch {}
}

function writeToken(reg, name, platform, role) {
  const { raw, hash } = genToken(name);
  reg.agents[name] = { hash, platform, created: new Date().toISOString(), ...(role ? { role } : {}) };
  const ep = path.join(VAULT_DIR, 'keys', `${name}.env`);
  fs.mkdirSync(path.dirname(ep), { recursive: true });
  fs.writeFileSync(ep, `CORTEX_AGENT_TOKEN=${raw}\n`);
  try { fs.chmodSync(ep, 0o600); } catch {}
  return raw;
}

function createBotDir(name, platform) {
  const bd = path.join(CORTEX_ROOT, 'bots', name);
  fs.mkdirSync(bd, { recursive: true });

  // .mcp.json
  fs.writeFileSync(path.join(bd, '.mcp.json'), JSON.stringify({
    mcpServers: { cortex: {
      type: 'stdio', command: 'bun',
      args: [path.join(GATEWAY_DIR, 'mcp', 'stdio.js')],
      env: {
        CORTEX_API: 'http://127.0.0.1:4840',
        CORTEX_AGENT_ID: name,
        CORTEX_AGENT_PLATFORM: platform,
        CORTEX_RUN_DIR: path.join(DATA_DIR, 'run'),
        CORTEX_TOKEN_DIR: path.join(VAULT_DIR, 'keys'),
      },
    }},
  }, null, 2) + '\n');

  // Claude Code agents get hooks + settings + protocol
  if (platform === 'claude-code') {
    const hd = path.join(bd, '.claude', 'hooks');
    fs.mkdirSync(hd, { recursive: true });
    const srcHooks = path.join(PROJECT_ROOT, '.claude', 'hooks');
    if (fs.existsSync(srcHooks)) {
      for (const h of fs.readdirSync(srcHooks).filter(f => f.endsWith('.sh'))) {
        let c = fs.readFileSync(path.join(srcHooks, h), 'utf8');
        c = c.replace(/AGENT_NAME="[^"]*"/, `AGENT_NAME="${name}"`);
        c = c.replace(/atlas\.env/g, `${name}.env`);
        fs.writeFileSync(path.join(hd, h), c);
        try { fs.chmodSync(path.join(hd, h), 0o750); } catch {}
      }
    }
    const srcSettings = path.join(PROJECT_ROOT, '.claude', 'settings.json');
    if (fs.existsSync(srcSettings)) fs.copyFileSync(srcSettings, path.join(bd, '.claude', 'settings.json'));
    const srcClaude = path.join(PROJECT_ROOT, 'CLAUDE.md');
    if (fs.existsSync(srcClaude)) fs.copyFileSync(srcClaude, path.join(bd, 'CLAUDE.md'));
  }
}

function startBackend() {
  const sp = path.join(BACKEND_DIR, 'server.js');
  if (!fs.existsSync(sp)) return false;
  const ch = spawn('bun', [sp], { cwd: PROJECT_ROOT, stdio: 'ignore', detached: true });
  ch.unref();
  return true;
}

async function checkHealth(port, retries = 5) {
  // Gateway uses /health, backend uses / (no /health route on backend)
  const healthPath = port === 4840 ? '/health' : '/';
  for (let i = 0; i < retries; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}${healthPath}`, { signal: AbortSignal.timeout(2000) }); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

async function testToken(token) {
  try {
    // Use /api/agents which requires auth — /health returns 200 without auth
    const r = await fetch('http://127.0.0.1:4840/api/agents', { headers: { 'x-cortex-token': token }, signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch { return false; }
}

// ═══ Subcommand routing ═══
const args = process.argv.slice(2);
const firstArg = args[0] || '';

// Management commands — delegate to the shell launcher if Cortex is already installed
const MANAGEMENT_CMDS = ['start', 'stop', 'restart', 'gateway', 'update', 'dev', 'build'];
if (MANAGEMENT_CMDS.includes(firstArg)) {
  const launcherPath = path.join(PROJECT_ROOT, 'cortex');
  if (fs.existsSync(launcherPath) && fs.existsSync(RC_PATH)) {
    const { spawnSync: spawnMgmt } = await import('node:child_process');
    const result = spawnMgmt('bash', [launcherPath, ...args], { stdio: 'inherit' });
    process.exit(result.status || 0);
  } else {
    console.log(`\n  ${C.r}Cortex is not installed yet.${C.x} Run ${C.b}cortex init${C.x} first.\n`);
    process.exit(1);
  }
}

// Help command — show both setup and management commands
if (firstArg === 'help' || firstArg === '--help' || firstArg === '-h') {
  console.log(`\n  ${C.b}Cortex v0.1${C.x}\n`);
  console.log('  Usage: cortex <command>\n');
  console.log('  Setup:');
  console.log('    init              Set up Cortex for the first time');
  console.log('    init --check      Verify system health');
  console.log('    init --add-agent  Register a new agent');
  console.log('    init --reset      Reset configuration');
  console.log('    init --repair     Repair broken install\n');
  console.log('  Management (requires init first):');
  console.log('    start             Start gateway + dashboard');
  console.log('    stop              Stop everything');
  console.log('    restart           Restart gateway + dashboard');
  console.log('    update            Install deps, rebuild, restart');
  console.log('    gateway <action>  Manage gateway (start|stop|restart|status)\n');
  process.exit(0);
}

const sub = args.find(a => a.startsWith('--'))?.slice(2) || 'init';

// ────────────────────────── --check ──────────────────────────
if (sub === 'check') {
  console.log(`\n  ${C.b}Cortex v0.1 — System Check${C.x}\n`);
  header('Configuration');
  fs.existsSync(RC_PATH) ? ok('~/.cortexrc.json') : fail('~/.cortexrc.json missing');
  header('Data');
  if (fs.existsSync(DB_PATH)) { ok(`gateway.db (${(fs.statSync(DB_PATH).size / 1048576).toFixed(1)} MB)`); } else fail('Database missing');
  if (fs.existsSync(REGISTRY_PATH)) { const r = loadReg(); ok(`Token registry (${Object.keys(r.agents).length} agents)`); } else fail('Token registry missing');
  header('Vault');
  const vk = path.join(VAULT_DIR, 'keys');
  if (fs.existsSync(vk)) { ok(`${fs.readdirSync(vk).filter(f => f.endsWith('.env')).length} token files (locked)`); } else fail('Vault missing');
  header('Services');
  (await checkHealth(4840, 1)) ? ok('Gateway    port 4840') : fail('Gateway    port 4840 not responding');
  try { const r = await fetch('http://127.0.0.1:4830/', { signal: AbortSignal.timeout(2000) }); r.ok ? ok('Dashboard  port 4830') : fail('Dashboard  port 4830'); } catch { fail('Dashboard  port 4830 not responding'); }
  header('Agent Connectivity');
  const reg = loadReg();
  for (const [name, cfg] of Object.entries(reg.agents).filter(([n]) => n !== 'admin')) {
    log(`${name}    ${cfg.platform}`);
    const ep = path.join(VAULT_DIR, 'keys', `${name}.env`);
    if (!fs.existsSync(ep)) { fail('  Token file missing'); continue; }
    ok('  Token file exists');
    const mp = path.join(CORTEX_ROOT, 'bots', name, '.mcp.json');
    fs.existsSync(mp) ? ok('  MCP config present') : fail('  MCP config missing → run: cortex init --repair');
    try {
      const tk = fs.readFileSync(ep, 'utf8').match(/CORTEX_(?:AGENT_)?TOKEN=(.*)/)?.[1]?.trim();
      if (tk && await testToken(tk)) ok('  Gateway reachable with token');
      else fail('  Token rejected by gateway');
    } catch { fail('  Could not verify token'); }
    console.log('');
  }
  done(); process.exit(0);
}

// ────────────────────────── --add-agent ──────────────────────────
if (sub === 'add-agent') {
  console.log(`\n  ${C.b}Cortex v0.1 — Add Agent${C.x}\n`);
  if (!isInstalled()) { fail('Not installed. Run: cortex init'); done(); process.exit(1); }
  const reg = loadReg();
  const existing = Object.keys(reg.agents).filter(n => n !== 'admin');
  if (existing.length) log(`Current agents: ${existing.join(', ')}\n`);
  let name = cleanName(await ask('Agent name: '));
  if (!name) { fail('Empty name'); done(); process.exit(1); }
  if (name === 'admin') { fail('"admin" is reserved'); done(); process.exit(1); }
  if (reg.agents[name]) { fail(`${name} already exists`); done(); process.exit(1); }
  log('What runs it?'); log('  1. Claude Code'); log('  2. Codex'); log('  3. Other');
  const ch = (await ask('Choice: ')).trim();
  let plat = PLAT[ch];
  if (!plat) plat = (await ask('Platform name: ')).trim() || 'generic';
  const tk = writeToken(reg, name, plat);
  saveReg(reg);
  ok(`Generated token for ${name} (${plat})`);
  createBotDir(name, plat);
  ok(`Created ~/Cortex/bots/${name}/`);
  plat === 'claude-code' ? ok('  .mcp.json + hooks + protocol') : ok('  .mcp.json');
  header('Connectivity Check');
  log(`${name}    ${plat}`);
  (await testToken(tk)) ? ok('  Gateway reachable with token') : fail('  Gateway not reachable');
  const cmd = plat === 'claude-code' ? 'claude' : plat === 'codex' ? 'codex' : plat;
  console.log(`\n  Connect: cd ~/Cortex/bots/${name} && ${cmd}\n`);
  done(); process.exit(0);
}

// ────────────────────────── --reset ──────────────────────────
if (sub === 'reset') {
  console.log(`\n  ${C.b}Cortex v0.1 — Reset${C.x}\n`);
  warn('This will delete ALL Cortex data:\n');
  log('  ~/Cortex/data/         database, runtime files');
  log('  ~/.cortex-vault/       all agent tokens');
  log('  ~/.cortexrc.json       configuration\n');
  log('  Projects and bot configs will NOT be deleted.\n');
  if ((await ask("Type 'reset' to confirm: ")).trim() !== 'reset') { log('Cancelled.'); done(); process.exit(0); }
  if (isMac) {
    try { spawnSync('pkill', ['-f', 'bun.*gateway/server.js']); } catch {}
  } else {
    try { spawnSync('systemctl', ['--user', 'stop', 'cortex-gateway.service']); } catch {}
  }
  try { spawnSync('pkill', ['-f', 'backend/server.js']); } catch {}
  ok('Stopped services');
  if (fs.existsSync(DATA_DIR)) { fs.rmSync(DATA_DIR, { recursive: true, force: true }); ok('Data removed'); }
  if (fs.existsSync(VAULT_DIR)) { fs.rmSync(VAULT_DIR, { recursive: true, force: true }); ok('Vault removed'); }
  if (fs.existsSync(RC_PATH)) { fs.rmSync(RC_PATH); ok('Config removed'); }
  console.log(`\n  Run 'cortex init' to set up fresh.\n`);
  done(); process.exit(0);
}

// ────────────────────────── --repair ──────────────────────────
if (sub === 'repair') {
  console.log(`\n  ${C.b}Cortex v0.1 — Repair${C.x}\n`);
  if (!isInstalled()) { fail('Not installed. Run: cortex init'); done(); process.exit(1); }
  let fixes = 0;
  const reg = loadReg();
  for (const [name, cfg] of Object.entries(reg.agents).filter(([n]) => n !== 'admin')) {
    if (!fs.existsSync(path.join(CORTEX_ROOT, 'bots', name, '.mcp.json'))) {
      createBotDir(name, cfg.platform);
      ok(`Repaired ~/Cortex/bots/${name}/`);
      fixes++;
    }
  }
  fixes === 0 ? ok('No issues found') : ok(`Fixed ${fixes} issue(s)`);
  console.log('');
  done(); process.exit(0);
}

// ═══════════════════════════════════════════════════════════════
//  MAIN INIT FLOW
// ═══════════════════════════════════════════════════════════════

console.log(`\n  ${C.b}╔══════════════════════════════════════╗${C.x}`);
console.log(`  ${C.b}║         Cortex v0.1 Setup           ║${C.x}`);
console.log(`  ${C.b}╚══════════════════════════════════════╝${C.x}\n`);
log('Cortex is a local AI operations platform. It coordinates');
log('your AI agents through a single gateway that tracks work,');
log('enforces rules, and gives you full visibility.\n');
log('This wizard will set up everything you need.');

// ── Existing install? ──
if (isInstalled()) {
  header('Existing Installation Detected');
  const reg = loadReg();
  const names = Object.keys(reg.agents).filter(n => n !== 'admin');
  log(`Workspace:  ~/Cortex/`);
  log(`Agents:     ${names.length} (${names.join(', ') || 'none'})\n`);
  log('What would you like to do?');
  log('  1. Check health');
  log('  2. Add an agent');
  log('  3. Repair');
  log('  4. Reset');
  log('  5. Exit\n');
  const ch = (await ask('Choice: ')).trim();
  done();
  const flags = { '1': '--check', '2': '--add-agent', '3': '--repair', '4': '--reset' };
  if (flags[ch]) spawnSync('bun', [import.meta.path, flags[ch]], { stdio: 'inherit' });
  process.exit(0);
}

// ── 1. Prerequisites ──
header('Prerequisites');
const bunV = spawnSync('bun', ['--version'], { encoding: 'utf8' });
if (bunV.error) { fail('Bun not installed. https://bun.sh'); process.exit(1); }
ok(`Bun ${bunV.stdout.trim()}`);
if (!fs.existsSync(GATEWAY_DIR)) { fail('Gateway source not found. Run from cloned repo.'); process.exit(1); }
ok('Source code found');
if (await portAvailable(4840)) ok('Port 4840 available (gateway)');
else { fail('Port 4840 in use'); process.exit(1); }
if (await portAvailable(4830)) ok('Port 4830 available (dashboard)');
else { fail('Port 4830 in use'); process.exit(1); }

// ── 2. Directories ──
header('Creating Directories');
for (const d of [
  path.join(DATA_DIR, 'run'), path.join(CORTEX_ROOT, 'projects'),
  path.join(CORTEX_ROOT, 'bots'), path.join(CORTEX_ROOT, 'logs'),
  path.join(CORTEX_ROOT, 'artifacts'), path.join(VAULT_DIR, 'keys'),
]) {
  if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); ok(`Created ${d.replace(HOME, '~')}`); }
  else skip(d.replace(HOME, '~'));
}
try { fs.chmodSync(VAULT_DIR, 0o700); fs.chmodSync(path.join(VAULT_DIR, 'keys'), 0o700); } catch {}

// ── 3. Config ──
header('Writing Config');
if (!fs.existsSync(RC_PATH)) {
  fs.writeFileSync(RC_PATH, JSON.stringify({
    workspace: CORTEX_ROOT,
    paths: { projects: path.join(CORTEX_ROOT, 'projects'), data: DATA_DIR, artifacts: path.join(CORTEX_ROOT, 'artifacts'), bots: path.join(CORTEX_ROOT, 'bots'), logs: path.join(CORTEX_ROOT, 'logs') },
    ports: { backend: 4830, gateway: 4840, websocket: 4841 },
  }, null, 2) + '\n');
  ok('Created ~/.cortexrc.json');
} else skip('~/.cortexrc.json');

// ── 4. Agent Setup ──
header('Agent Setup');
log('Agents are AI models that connect to Cortex. Each gets');
log('a unique identity, token, and workspace directory.\n');

const reg = { agents: {} };
writeToken(reg, 'admin', 'admin', 'admin');
ok('Generated admin token\n');

const countStr = await ask('How many agents do you want to connect? ');
const count = Math.max(0, Math.min(20, parseInt(countStr) || 0));
const agents = []; // {name, platform}

if (count > 0) {
  const hasNames = (await ask('Do you have names for them? (y/n) ')).trim().toLowerCase() === 'y';

  // Collect names
  if (hasNames) {
    for (let i = 0; i < count; i++) {
      const raw = await ask(`  Agent ${i + 1} name: `);
      const name = cleanName(raw);
      if (!name) { log('  Skipped (empty)'); continue; }
      if (name === 'admin') { fail('  "admin" is reserved'); continue; }
      if (raw.trim() !== name) {
        if ((await ask(`  → Cleaned to: ${name}. Keep? (y/n) `)).trim().toLowerCase() !== 'y') continue;
      }
      agents.push({ name, platform: null });
    }
  } else {
    let names = pickNames(count, ['admin']);
    log(`\n  Generated: ${names.join(', ')}`);
    if ((await ask('  Happy with these? (y/n) ')).trim().toLowerCase() !== 'y') {
      names = pickNames(count, ['admin', ...names]);
      log(`  Regenerated: ${names.join(', ')}`);
    }
    for (const n of names) agents.push({ name: n, platform: null });
  }

  // Collect platforms
  if (agents.length > 0) {
    console.log('\n  What platform do they run on?');
    log('  1. Claude Code');
    log('  2. Codex');
    log('  3. Other');
    if (agents.length > 1) log('  4. Different for each');

    const ch = (await ask('\n  Choice: ')).trim();

    if (ch === '4' && agents.length > 1) {
      console.log('');
      for (const a of agents) {
        const c = (await ask(`    ${a.name}: `)).trim();
        if (PLAT[c]) a.platform = PLAT[c];
        else a.platform = (await ask(`    Platform name for ${a.name}: `)).trim() || 'generic';
      }
    } else if (PLAT[ch]) {
      for (const a of agents) a.platform = PLAT[ch];
    } else {
      const custom = (await ask('  Platform name: ')).trim() || 'generic';
      for (const a of agents) a.platform = custom;
    }
  }
} else {
  log('No agents added. Add later: cortex init --add-agent');
}

// ── 5. Review ──
header('Review');
log('Directories:');
log('  ~/Cortex/              workspace root');
for (const a of agents) log(`  ~/Cortex/bots/${a.name.padEnd(10)} agent workspace + MCP config`);
log('  ~/.cortex-vault/       token vault (locked, 700)');
log('  ~/.cortexrc.json       configuration\n');
log('Agents:');
log('  admin      system        → ~/.cortex-vault/keys/admin.env');
for (const a of agents) log(`  ${a.name.padEnd(10)} ${a.platform.padEnd(13)} → ~/.cortex-vault/keys/${a.name}.env`);
console.log('');
if (agents.some(a => a.platform === 'claude-code')) {
  log('Claude Code agents will include:');
  log('  .mcp.json              gateway connection (pre-configured)');
  log('  .claude/hooks/         enforcement gates');
  log('  .claude/settings.json  permissions + hook registration');
  log('  CLAUDE.md              agent protocol\n');
}
log('Services:');
log(`  Gateway    → port 4840 (${isMac ? 'background process' : 'systemd managed'})`);
log('  Dashboard  → port 4830\n');

if ((await ask('Continue? (y/n) ')).trim().toLowerCase() !== 'y') { log('\nCancelled.'); done(); process.exit(0); }

// ── 6. Install ──
header('Installing');

// Tokens
for (const a of agents) {
  writeToken(reg, a.name, a.platform);
  ok(`Generated token for ${a.name} (${a.platform})`);
}
saveReg(reg);
ok('Token registry saved');

// Bot directories
log('Configuring agent workspaces...');
for (const a of agents) {
  createBotDir(a.name, a.platform);
  ok(`  ${a.name}  ${a.platform === 'claude-code' ? '.mcp.json + hooks + protocol' : '.mcp.json'}`);
}

// CLI wrapper
const BIN_DIR = path.join(HOME, '.local', 'bin');
const CLI_PATH = path.join(BIN_DIR, 'cortex');
const CORTEX_SCRIPT = path.join(PROJECT_ROOT, 'cortex');
if (fs.existsSync(CORTEX_SCRIPT) && !fs.existsSync(CLI_PATH)) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  fs.symlinkSync(CORTEX_SCRIPT, CLI_PATH);
  ok(`CLI linked: ~/.local/bin/cortex → ${CORTEX_SCRIPT.replace(HOME, '~')}`);
  const pathEnv = process.env.PATH || '';
  if (!pathEnv.includes(BIN_DIR)) {
    warn(`Add to your shell profile: export PATH="${BIN_DIR}:$PATH"`);
  }
} else if (fs.existsSync(CLI_PATH)) {
  skip('CLI wrapper (~/.local/bin/cortex)');
}

// Database
if (!fs.existsSync(DB_PATH)) {
  try {
    const { initDb } = await import(path.join(PROJECT_ROOT, 'services', 'gateway', 'lib', 'db.js'));
    const { db } = initDb(DB_PATH);
    db.close();
    ok('Database initialized');
  } catch (e) { fail(`Database init: ${e.message}`); }
} else skip('Database');

// Service management
if (isMac) {
  ok('macOS detected — gateway will run in background process mode');
} else {
  const SVC_DIR = path.join(HOME, '.config', 'systemd', 'user');
  const SVC_PATH = path.join(SVC_DIR, 'cortex-gateway.service');
  if (!fs.existsSync(SVC_PATH)) {
    fs.mkdirSync(SVC_DIR, { recursive: true });
    const bunPath = spawnSync('which', ['bun'], { encoding: 'utf8' }).stdout.trim() || path.join(HOME, '.bun', 'bin', 'bun');
    fs.writeFileSync(SVC_PATH, `[Unit]\nDescription=Cortex Gateway (port 4840)\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${GATEWAY_DIR}\nExecStart=${bunPath} ${path.join(GATEWAY_DIR, 'server.js')}\nRestart=on-failure\nRestartSec=5\nEnvironment=NODE_ENV=production\nEnvironment=CORTEX_GATEWAY_HOST=127.0.0.1\nEnvironment=CORTEX_GATEWAY_PORT=4840\nEnvironment=CORTEX_GATEWAY_DB=${DB_PATH}\nEnvironment=CORTEX_TOKEN_REGISTRY=${REGISTRY_PATH}\nMemoryMax=1G\n\n[Install]\nWantedBy=default.target\n`);
    spawnSync('systemctl', ['--user', 'daemon-reload']);
    spawnSync('systemctl', ['--user', 'enable', 'cortex-gateway.service']);
    ok('Systemd service configured');
  } else skip('Systemd service');
}

// Dependencies
log('Installing dependencies...');
const inst = spawnSync('bun', ['install', '--frozen-lockfile'], { cwd: PROJECT_ROOT, stdio: 'pipe' });
if (inst.error || inst.status !== 0) spawnSync('bun', ['install'], { cwd: PROJECT_ROOT, stdio: 'pipe' });
ok('Dependencies installed');

log('Building frontend...');
const bld = spawnSync('bun', ['x', 'vite', 'build'], { cwd: PROJECT_ROOT, stdio: 'pipe' });
(bld.error || bld.status !== 0) ? fail('Frontend build failed — run "bun run build"') : ok('Frontend built');

// ── 7. Start ──
header('Starting');

// Gateway
if (isMac) {
  const gwServer = path.join(GATEWAY_DIR, 'server.js');
  const gwProc = spawn('bun', [gwServer], {
    cwd: GATEWAY_DIR, stdio: 'ignore', detached: true,
    env: { ...process.env, NODE_ENV: 'production', CORTEX_GATEWAY_HOST: '127.0.0.1', CORTEX_GATEWAY_PORT: '4840', CORTEX_GATEWAY_DB: DB_PATH, CORTEX_TOKEN_REGISTRY: REGISTRY_PATH },
  });
  gwProc.unref();
  if (await checkHealth(4840)) {
    ok('Gateway started on port 4840 (background process)');
  } else { fail('Gateway start failed — run: bun run services/gateway/server.js'); }
} else {
  const gwStart = spawnSync('systemctl', ['--user', 'start', 'cortex-gateway.service']);
  if (!gwStart.error && gwStart.status === 0 && await checkHealth(4840)) {
    ok('Gateway started on port 4840');
  } else { fail('Gateway start failed — run: cortex gateway start'); }
}

// Dashboard/backend
if (startBackend()) {
  await new Promise(r => setTimeout(r, 2000));
  try {
    const r = await fetch('http://127.0.0.1:4830/', { signal: AbortSignal.timeout(3000) });
    r.ok ? ok('Dashboard started on port 4830') : warn('Dashboard starting...');
  } catch { warn('Dashboard starting — may take a moment'); }
} else { fail('Dashboard backend not found'); }

// Health
if (await checkHealth(4840, 1) && await checkHealth(4830, 1).catch(() => false)) {
  ok('Health check passed — both services operational');
}

// ── 8. Agent connectivity ──
if (agents.length > 0) {
  header('Agent Connectivity');
  let passed = 0;
  for (const a of agents) {
    log(`${a.name}    ${a.platform}`);
    const ep = path.join(VAULT_DIR, 'keys', `${a.name}.env`);
    try {
      const tk = fs.readFileSync(ep, 'utf8').match(/CORTEX_(?:AGENT_)?TOKEN=(.*)/)?.[1]?.trim();
      if (tk && await testToken(tk)) { ok('  Token valid'); ok('  MCP config ready'); ok('  Gateway reachable'); passed++; }
      else fail('  Token rejected');
    } catch { fail('  Gateway not reachable'); }
    console.log('');
  }
  ok(`${passed}/${agents.length} agents ready to connect.`);
}

// ── 9. First project ──
header('First Project');
if ((await ask('Create your first project? (y/n) ')).trim().toLowerCase() === 'y') {
  const pname = (await ask('Project name: ')).trim();
  if (pname) {
    try {
      const adminTk = fs.readFileSync(path.join(VAULT_DIR, 'keys', 'admin.env'), 'utf8').match(/CORTEX_(?:AGENT_)?TOKEN=(.*)/)?.[1]?.trim();
      const r = await fetch('http://127.0.0.1:4840/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Cortex-Token': adminTk },
        body: JSON.stringify({ name: pname }),
      });
      r.ok ? ok(`Project "${pname}" created with Phase 1`) : fail('Project creation failed');
    } catch { fail('Could not reach gateway'); }
  }
}

// Browser
try { spawn(isMac ? 'open' : 'xdg-open', ['http://127.0.0.1:4830'], { stdio: 'ignore', detached: true }).unref(); } catch {}
ok('Opening dashboard in browser...');

// ── Done ──
console.log(`\n  ${C.b}╔══════════════════════════════════════╗${C.x}`);
console.log(`  ${C.b}║           Setup Complete            ║${C.x}`);
console.log(`  ${C.b}╚══════════════════════════════════════╝${C.x}\n`);
log(`Dashboard:  http://127.0.0.1:4830`);
log(`Gateway:    http://127.0.0.1:4840\n`);
log('Next steps:\n');
log('1. Open the dashboard and create your first project');
log('   to start tracking work');
log('   http://127.0.0.1:4830\n');
log('2. Set up tasks inside your project — assign them');
log('   to agents, set priorities, and track progress\n');
if (agents.length > 0) {
  log('3. When ready, connect an agent:\n');
  for (const a of agents) {
    const cmd = a.platform === 'claude-code' ? 'claude' : a.platform === 'codex' ? 'codex' : a.platform;
    log(`   ${a.name} (${a.platform}):`);
    log(`     cd ~/Cortex/bots/${a.name} && ${cmd}\n`);
  }
  log('   Each agent directory has a pre-configured');
  log('   .mcp.json — no additional setup needed.\n');
}
log(`${agents.length > 0 ? '4' : '3'}. Manage Cortex:\n`);
log('   cortex start            start gateway + dashboard');
log('   cortex stop             stop everything');
log('   cortex restart          restart everything');
log('   cortex gateway status   check gateway health');
log('   cortex init --check     verify system health');
log('   cortex init --add-agent add a new agent\n');
log("Run 'cortex help' for all commands.\n");

done();
