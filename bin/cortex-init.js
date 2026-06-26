#!/usr/bin/env bun
/**
 * Cortex v0.2 — Initialization & Management
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
import { randomBytes } from 'node:crypto';
import readline from 'node:readline';
import { sha256Hex } from '@cortex/sdk/auth';
import { TOKEN_LINE_RE } from '../sdk/auth/token-resolver.js';

const HOME = os.homedir();
const isMac = process.platform === 'darwin';
const CORTEX_ROOT = path.join(HOME, 'Cortex');
const VAULT_DIR = path.join(HOME, '.cortex');
const RC_PATH = path.join(HOME, '.cortexrc.json');
const PROJECT_ROOT = path.resolve(import.meta.dir, '..');
const GATEWAY_DIR = path.join(PROJECT_ROOT, 'services', 'gateway');
const PLATFORM_DIR = path.join(PROJECT_ROOT, 'platform', 'backend');
const DATA_DIR = path.join(CORTEX_ROOT, 'data');
// State files (DB, token-registry, identity, admin.token) live under data/state/
// — the canonical state root run-prod.sh seeds and the gateway resolves
// (resolveStateRoot → $CORTEX_DATA_DIR/state). Keep these in lockstep or the
// gateway re-seeds a fresh registry/identity on boot and dashboard login dies.
const STATE_ROOT = path.join(DATA_DIR, 'state');
const REGISTRY_PATH = path.join(STATE_ROOT, 'token-registry.json');
const DB_PATH = path.join(STATE_ROOT, 'cortex.db');
// data/run holds MCP session-pointer files. Single-user: plain 0770 user-owned.
// Multi-user (opt-in): 2770 owner:group with the setgid bit so a shared group of
// bot Linux users can all write session pointers — without it the cortex MCP
// stdio crashes EACCES at claimSessionSlot before connecting. Bun's fs.chmodSync
// strips setgid, so the multi-user perms are applied via coreutils chmod/chgrp
// (see enforceRunDirPerms / resolveRunDirPlan).
const RUN_DIR = path.join(DATA_DIR, 'run');
const DEFAULT_MULTI_USER_GROUP = process.env.CORTEX_GROUP || 'cortex-agents';
const CORTEX_PLATFORM_PORT = parseInt(process.env.CORTEX_PLATFORM_PORT || '4830', 10);

// ═══ Output helpers ═══
const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', c: '\x1b[36m', d: '\x1b[90m', b: '\x1b[1m', x: '\x1b[0m' };
function ok(m) { console.log(`  ${C.g}✓${C.x} ${m}`); }
function skip(m) { console.log(`  ${C.d}·${C.x} ${m} (already exists)`); }
function fail(m) { console.error(`  ${C.r}✗${C.x} ${m}`); }
function warn(m) { console.log(`  ${C.y}!${C.x} ${m}`); }
function log(m) { console.log(`  ${m}`); }
function header(m) { console.log(`\n  ${C.c}── ${m} ${'─'.repeat(Math.max(0, 38 - m.length))}${C.x}\n`); }

let _rl = null;
function rl() {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
function ask(q) { return new Promise(r => rl().question(`  ${q}`, r)); }
function done() { if (_rl) { _rl.close(); _rl = null; } }

// ═══ Utilities ═══
function portAvailable(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

export function genToken(name) {
  const raw = `cortex_${name}_${randomBytes(32).toString('hex')}`;
  const hash = sha256Hex(raw);
  return { raw, hash };
}

function parseTokenEnv(content) {
  return content.match(TOKEN_LINE_RE)?.[1]?.trim();
}

// Decide the run-dir permission plan. SINGLE-USER by default (plain user-owned
// 0770, no shared group). MULTI-USER is OPT-IN: --multi-user uses the default
// shared group, or CORTEX_GROUP names a specific group; both imply 2770+setgid
// so a shared group of agent processes can write session pointers.
export function resolveRunDirPlan({ args = process.argv.slice(2), env = process.env } = {}) {
  const flagMulti = args.includes('--multi-user');
  const envGroup = (env.CORTEX_GROUP || '').trim();
  if (envGroup) {
    return { multiUser: true, group: envGroup, mode: '2770', setgid: true };
  }
  if (flagMulti) {
    return { multiUser: true, group: DEFAULT_MULTI_USER_GROUP, mode: '2770', setgid: true };
  }
  return { multiUser: false, group: null, mode: '0770', setgid: false };
}

// Apply the run-dir perm plan. Single-user: plain 0770 via fs.chmodSync (no
// setgid needed → fs.chmodSync is fine). Multi-user: 2770 + setgid + group via
// coreutils (fs.chmodSync strips setgid on Bun). Returns { ok, mode, group,
// setgid, error? } — NEVER throws; callers decide whether a multi-user failure
// is fatal (it is only advisory for single-user).
export function enforceRunDirPerms({ dir = RUN_DIR, plan = resolveRunDirPlan() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (!plan.multiUser) {
    try { fs.chmodSync(dir, 0o770); } catch (e) {
      return { ok: true, mode: '0770', group: null, setgid: false, warning: e.message };
    }
    return { ok: true, mode: '0770', group: null, setgid: false };
  }
  const grp = spawnSync('chgrp', [plan.group, dir], { encoding: 'utf8' });
  if (grp.error || grp.status !== 0) {
    return { ok: false, error: `chgrp ${plan.group} ${dir} failed: ${grp.error?.message || grp.stderr?.trim() || `exit ${grp.status}`}` };
  }
  const mod = spawnSync('chmod', ['2770', dir], { encoding: 'utf8' });
  if (mod.error || mod.status !== 0) {
    return { ok: false, error: `chmod 2770 ${dir} failed: ${mod.error?.message || mod.stderr?.trim() || `exit ${mod.status}`}` };
  }
  const got = runDirPerms(dir);
  if (!got || !got.setgid || got.mode !== '2770' || got.group !== plan.group) {
    return { ok: false, error: `run-dir perms not enforced on ${dir}: have mode=${got?.mode || '?'} group=${got?.group || '?'} setgid=${got?.setgid ? 'yes' : 'no'}, want 2770 ${plan.group} setgid` };
  }
  return { ok: true, mode: got.mode, group: got.group, setgid: got.setgid };
}

// Read-only perms probe for --check. fs.statSync reads the setgid bit fine
// (only chmodSync strips it), so no shell write is needed here.
function runDirPerms(dir = RUN_DIR) {
  let st;
  try { st = fs.statSync(dir); } catch { return null; }
  const mode = (st.mode & 0o7777).toString(8).padStart(4, '0');
  let group = String(st.gid);
  const g = spawnSync('stat', isMac ? ['-f', '%Sg', dir] : ['-c', '%G', dir], { encoding: 'utf8' });
  if (!g.error && g.status === 0) group = g.stdout.trim();
  return { mode, group, setgid: (st.mode & 0o2000) !== 0 };
}

export function cleanName(raw) {
  return raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 30);
}

const NAMES_POOL = [
  'nova','echo','pulse','drift','shard','flux','prism','forge','ember','quill',
  'rune','spark','cipher','vector','nexus','orbit','veil','core','arc','blade',
  'ghost','helix','ion','jade','kelp','lux','mesa','node','opal','pike',
];

export function pickNames(n, exclude = []) {
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

// Model-agnostic connection facts. Init no longer generates model-specific
// wiring (.mcp.json / .claude/hooks / CLAUDE.md). It hands every agent these
// neutral facts + the onboarding prompt; the agent wires ITSELF in (adds the
// MCP server in its own runtime's format, registers, claims, runs the loop).
export function connectionFacts({ name, tokenPath }) {
  return {
    agentId: name,
    gatewayUrl: 'http://127.0.0.1:4840',
    mcpEndpoint: 'stdio',
    mcpCommand: 'bun',
    mcpArgs: [path.join(GATEWAY_DIR, 'mcp', 'stdio.js')],
    mcpEnv: { CORTEX_API: 'http://127.0.0.1:4840', CORTEX_AGENT_ID: name, CORTEX_TOKEN_DIR: path.join(VAULT_DIR, 'keys') },
    tokenPath,
  };
}

export function onboardingPromptPath() {
  return path.join(PROJECT_ROOT, 'docs', 'onboarding-prompt.md');
}

function printConnectionFacts(f) {
  log(`  Agent id:     ${f.agentId}`);
  log(`  Gateway:      ${f.gatewayUrl}`);
  log(`  MCP (stdio):  ${f.mcpCommand} ${f.mcpArgs.join(' ')}`);
  log(`  Token file:   ${f.tokenPath.replace(HOME, '~')}`);
  log(`  Onboarding:   ${onboardingPromptPath().replace(HOME, '~')}`);
}

function startPlatformBackend() {
  const sp = path.join(PLATFORM_DIR, 'server.js');
  if (!fs.existsSync(sp)) return false;
  const ch = spawn('bun', [sp], { cwd: PROJECT_ROOT, stdio: 'ignore', detached: true });
  ch.unref();
  return true;
}

// Build the gateway env once (was duplicated between the systemd unit and the
// macOS spawn). Reused by both portableLauncher() and installNativeService().
export function gatewayEnv() {
  return {
    NODE_ENV: 'production',
    CORTEX_GATEWAY_HOST: '127.0.0.1',
    CORTEX_GATEWAY_PORT: '4840',
    CORTEX_DB_PATH: DB_PATH,
    CORTEX_STATE_ROOT: STATE_ROOT,
    CORTEX_TOKEN_REGISTRY: REGISTRY_PATH,
    CORTEX_HOME: CORTEX_ROOT,
    CORTEX_HUB_DIR: CORTEX_ROOT,
    CORTEX_DATA_DIR: DATA_DIR,
    CORTEX_RUN_DIR: RUN_DIR,
    CORTEX_ADMIN_SOCKET: path.join(STATE_ROOT, 'admin.sock'),
  };
}

// OS-agnostic default: a detached `bun server.js` spawn. Returns a spec the
// caller passes to spawn() — pure so it is unit-testable.
export function portableLauncher({ gatewayDir = GATEWAY_DIR, env = gatewayEnv(), detached = true } = {}) {
  return {
    command: 'bun',
    args: [path.join(gatewayDir, 'server.js')],
    options: { cwd: gatewayDir, stdio: 'ignore', detached, env: { ...process.env, NODE_ENV: 'production', ...env } },
  };
}

// Native OS service install is OPT-IN. Default path is the portable launcher.
export function shouldInstallService(args = process.argv.slice(2)) {
  return args.includes('--service');
}

// Cross-platform browser opener command. 'start' is invoked via the shell on
// Windows (see openBrowser); 'open'/'xdg-open' are direct execs.
export function browserOpenerForPlatform(platform = process.platform) {
  if (platform === 'darwin') return 'open';
  if (platform === 'win32') return 'start';
  return 'xdg-open';
}

export function openBrowser(url, platform = process.platform) {
  try {
    const opener = browserOpenerForPlatform(platform);
    if (platform === 'win32') {
      // `start` is a cmd builtin, not an exe; the empty title arg avoids URL-as-title.
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn(opener, [url], { stdio: 'ignore', detached: true }).unref();
    }
    return true;
  } catch { return false; }
}

// OPT-IN (--service) native service install. Linux → systemd user unit. macOS
// launchd / Windows services are deferred (the portable launcher covers them);
// we return a status so the caller can print the right next step.
export function installNativeService() {
  if (isMac) return { installed: false, kind: 'launchd', note: 'launchd unit not generated — use the portable launcher (cortex start).' };
  if (process.platform === 'win32') return { installed: false, kind: 'windows', note: 'Windows service not generated — use the portable launcher (cortex start).' };
  const SVC_DIR = path.join(HOME, '.config', 'systemd', 'user');
  const SVC_PATH = path.join(SVC_DIR, 'cortex-gateway.service');
  if (fs.existsSync(SVC_PATH)) return { installed: false, kind: 'systemd', note: 'systemd unit already present.' };
  fs.mkdirSync(SVC_DIR, { recursive: true });
  const bunPath = spawnSync('which', ['bun'], { encoding: 'utf8' }).stdout.trim() || path.join(HOME, '.bun', 'bin', 'bun');
  const env = gatewayEnv();
  const envLines = Object.entries(env).map(([k, v]) => `Environment=${k}=${v}`).join('\n');
  fs.writeFileSync(SVC_PATH, `[Unit]\nDescription=Cortex Gateway (port 4840)\nAfter=network-online.target\n\n[Service]\nType=simple\nWorkingDirectory=${GATEWAY_DIR}\nExecStart=${bunPath} ${path.join(GATEWAY_DIR, 'server.js')}\nRestart=on-failure\nRestartSec=5\n${envLines}\nMemoryMax=1G\n\n[Install]\nWantedBy=default.target\n`);
  spawnSync('systemctl', ['--user', 'daemon-reload']);
  spawnSync('systemctl', ['--user', 'enable', 'cortex-gateway.service']);
  return { installed: true, kind: 'systemd', path: SVC_PATH };
}

function ensureCliLink(linkPath, targetPath) {
  if (!fs.existsSync(targetPath)) return false;

  fs.mkdirSync(path.dirname(linkPath), { recursive: true });

  try {
    const stat = fs.lstatSync(linkPath);
    if (!stat.isSymbolicLink()) {
      warn(`Skipping ${linkPath.replace(HOME, '~')} because a non-symlink file already exists there`);
      return false;
    }

    const currentTarget = fs.readlinkSync(linkPath);
    const resolvedTarget = path.resolve(path.dirname(linkPath), currentTarget);
    if (resolvedTarget === targetPath) return false;

    fs.rmSync(linkPath, { force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  fs.symlinkSync(targetPath, linkPath);
  return true;
}

function ensureCliWrappers() {
  const binDir = path.join(HOME, '.local', 'bin');
  const links = [
    { linkPath: path.join(binDir, 'cortex'), targetPath: path.join(PROJECT_ROOT, 'cortex') },
    { linkPath: path.join(binDir, 'watcher'), targetPath: path.join(PROJECT_ROOT, 'watcher') },
  ];

  let fixes = 0;
  for (const { linkPath, targetPath } of links) {
    const changed = ensureCliLink(linkPath, targetPath);
    if (changed) {
      ok(`CLI linked: ${linkPath.replace(HOME, '~')} → ${targetPath.replace(HOME, '~')}`);
      fixes += 1;
    } else if (fs.existsSync(linkPath)) {
      skip(`CLI wrapper (${linkPath.replace(HOME, '~')})`);
    }
  }

  const pathEnv = process.env.PATH || '';
  if (!pathEnv.split(path.delimiter).includes(binDir)) {
    warn(`Add to your shell profile: export PATH="${binDir}:$PATH"`);
  }

  return fixes;
}

async function checkHealth(port, retries = 5) {
  // Gateway uses /health, platform-backend uses / (no /health route on backend)
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

// ═══ Subcommand routing + main wizard — only when run directly (not on import) ═══
async function main() {
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
  console.log(`\n  ${C.b}Cortex v0.2${C.x}\n`);
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
  console.log(`\n  ${C.b}Cortex v0.2 — System Check${C.x}\n`);
  header('Configuration');
  fs.existsSync(RC_PATH) ? ok('~/.cortexrc.json') : fail('~/.cortexrc.json missing');
  header('Data');
  if (fs.existsSync(DB_PATH)) { ok(`cortex.db (${(fs.statSync(DB_PATH).size / 1048576).toFixed(1)} MB)`); } else fail('Database missing');
  if (fs.existsSync(REGISTRY_PATH)) { const r = loadReg(); ok(`Token registry (${Object.keys(r.agents).length} agents)`); } else fail('Token registry missing');
  {
    // Read-only run-dir perms probe. statSync reads setgid fine. The probe
    // matches the resolved plan: multi-user wants 2770+setgid+group; single-user
    // just reports the mode (informational).
    const runPlan = resolveRunDirPlan();
    const p = runDirPerms();
    if (!p) fail('data/run missing → run: cortex init --repair');
    else if (runPlan.multiUser) {
      (p.setgid && p.mode === runPlan.mode && p.group === runPlan.group)
        ? ok(`data/run perms ${p.mode} ${p.group} (setgid)`)
        : fail(`data/run perms ${p.mode} ${p.group} (setgid=${p.setgid ? 'yes' : 'no'}) — want ${runPlan.mode} ${runPlan.group} setgid → run: cortex init --repair`);
    } else {
      ok(`data/run perms ${p.mode} (single-user)`);
    }
  }
  header('Vault');
  const vk = path.join(VAULT_DIR, 'keys');
  if (fs.existsSync(vk)) { ok(`${fs.readdirSync(vk).filter(f => f.endsWith('.env')).length} token files (locked)`); } else fail('Vault missing');
  header('Services');
  (await checkHealth(4840, 1)) ? ok('Gateway    port 4840') : fail('Gateway    port 4840 not responding');
  try { const r = await fetch(`http://127.0.0.1:${CORTEX_PLATFORM_PORT}/`, { signal: AbortSignal.timeout(2000) }); r.ok ? ok(`Dashboard  port ${CORTEX_PLATFORM_PORT}`) : fail(`Dashboard  port ${CORTEX_PLATFORM_PORT}`); } catch { fail(`Dashboard  port ${CORTEX_PLATFORM_PORT} not responding`); }
  header('Agent Connectivity');
  const reg = loadReg();
  for (const [name, cfg] of Object.entries(reg.agents).filter(([n]) => n !== 'admin')) {
    log(`${name}    ${cfg.platform}`);
    const ep = path.join(VAULT_DIR, 'keys', `${name}.env`);
    if (!fs.existsSync(ep)) { fail('  Token file missing'); continue; }
    ok('  Token file exists');
    try {
      const tk = parseTokenEnv(fs.readFileSync(ep, 'utf8'));
      if (tk && await testToken(tk)) ok('  Gateway reachable with token');
      else fail('  Token rejected by gateway');
    } catch { fail('  Could not verify token'); }
    console.log('');
  }
  done(); process.exit(0);
}

// ────────────────────────── --add-agent ──────────────────────────
if (sub === 'add-agent') {
  console.log(`\n  ${C.b}Cortex v0.2 — Add Agent${C.x}\n`);
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
  header('Connection');
  const facts = connectionFacts({ name, tokenPath: path.join(VAULT_DIR, 'keys', `${name}.env`) });
  printConnectionFacts(facts);
  header('Connectivity Check');
  log(`${name}    ${plat}`);
  (await testToken(tk)) ? ok('  Gateway reachable with token') : fail('  Gateway not reachable');
  console.log(`\n  Hand ${name} the onboarding prompt (${onboardingPromptPath().replace(HOME, '~')}) and it will wire itself in.\n`);
  done(); process.exit(0);
}

// ────────────────────────── --reset ──────────────────────────
if (sub === 'reset') {
  console.log(`\n  ${C.b}Cortex v0.2 — Reset${C.x}\n`);
  warn('This will delete ALL Cortex data:\n');
  log('  ~/Cortex/data/         database, runtime files');
  log('  ~/.cortex/       all agent tokens');
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
  console.log(`\n  ${C.b}Cortex v0.2 — Repair${C.x}\n`);
  if (!isInstalled()) {
    const wrapperFixes = ensureCliWrappers();
    if (wrapperFixes > 0) {
      warn('Cortex is not fully installed for this user; repaired CLI wrappers only');
      ok(`Fixed ${wrapperFixes} issue(s)`);
      console.log('');
      done();
      process.exit(0);
    }
    fail('Not installed. Run: cortex init');
    done();
    process.exit(1);
  }

  let fixes = 0;

  // data/run perms — re-enforce against the resolved plan. Single-user 0770 is
  // always best-effort; a multi-user (2770+setgid+group) failure is surfaced but
  // never aborts repair (single-user perms still let the instance run).
  {
    const runPlan = resolveRunDirPlan();
    const before = runDirPerms();
    const want = runPlan.multiUser
      ? (!before || !before.setgid || before.mode !== runPlan.mode || before.group !== runPlan.group)
      : (!before || before.mode !== '0770');
    const after = enforceRunDirPerms({ plan: runPlan });
    if (after.ok) {
      if (want) { ok(`Re-enforced data/run perms ${after.mode}${after.group ? ` ${after.group}` : ''}${after.setgid ? ' (setgid)' : ''}`); fixes++; }
      else ok(`data/run perms ${after.mode}${after.group ? ` ${after.group}` : ''}${after.setgid ? ' (setgid)' : ''}`);
    } else {
      fail(`data/run perms: ${after.error}`);
      fail(`  Fix manually: chmod ${runPlan.mode} ${RUN_DIR} && chgrp ${runPlan.group} ${RUN_DIR}`);
    }
  }

  const reg = loadReg();
  for (const [name] of Object.entries(reg.agents).filter(([n]) => n !== 'admin')) {
    const ep = path.join(VAULT_DIR, 'keys', `${name}.env`);
    if (!fs.existsSync(ep)) {
      fail(`  Token file missing for ${name} → re-run: cortex init --add-agent`);
    } else {
      ok(`  ${name} token file present`);
    }
  }
  fixes += ensureCliWrappers();
  fixes === 0 ? ok('No issues found') : ok(`Fixed ${fixes} issue(s)`);
  console.log('');
  done(); process.exit(0);
}

// ═══════════════════════════════════════════════════════════════
//  MAIN INIT FLOW
// ═══════════════════════════════════════════════════════════════

console.log(`\n  ${C.b}╔══════════════════════════════════════╗${C.x}`);
console.log(`  ${C.b}║         Cortex v0.2 Setup           ║${C.x}`);
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
if (await portAvailable(CORTEX_PLATFORM_PORT)) ok(`Port ${CORTEX_PLATFORM_PORT} available (platform-backend)`);
else { fail(`Port ${CORTEX_PLATFORM_PORT} in use`); process.exit(1); }

// ── 2. Directories ──
header('Creating Directories');
for (const d of [
  RUN_DIR, STATE_ROOT, path.join(CORTEX_ROOT, 'projects'),
  path.join(CORTEX_ROOT, 'bots'), path.join(CORTEX_ROOT, 'logs'),
  path.join(CORTEX_ROOT, 'artifacts'), path.join(VAULT_DIR, 'keys'),
]) {
  if (!fs.existsSync(d)) { fs.mkdirSync(d, { recursive: true }); ok(`Created ${d.replace(HOME, '~')}`); }
  else skip(d.replace(HOME, '~'));
}
try { fs.chmodSync(VAULT_DIR, 0o700); fs.chmodSync(path.join(VAULT_DIR, 'keys'), 0o700); } catch {}
// data/run perms — single-user 0770 by default; multi-user 2770+setgid+group
// when --multi-user / CORTEX_GROUP is set (applied via coreutils since
// fs.chmodSync strips setgid). Never aborts on a multi-user failure: the
// single-user perms already on disk are enough to run.
const runPlan = resolveRunDirPlan();
const runPerms = enforceRunDirPerms({ plan: runPlan });
if (runPerms.ok) {
  ok(`data/run perms ${runPerms.mode}${runPerms.group ? ` ${runPerms.group}` : ''}${runPerms.setgid ? ' (setgid)' : ''}`);
} else {
  // Multi-user was requested but couldn't be applied — surface, but don't abort:
  // single-user perms already on disk are enough to run.
  warn(`data/run multi-user perms: ${runPerms.error}`);
  warn('  Continuing single-user. Re-run with elevated rights or fix the group, or drop --multi-user / CORTEX_GROUP.');
}

// ── 3. Config ──
header('Writing Config');
if (!fs.existsSync(RC_PATH)) {
  fs.writeFileSync(RC_PATH, JSON.stringify({
    workspace: CORTEX_ROOT,
    paths: { projects: path.join(CORTEX_ROOT, 'projects'), data: DATA_DIR, artifacts: path.join(CORTEX_ROOT, 'artifacts'), bots: path.join(CORTEX_ROOT, 'bots'), logs: path.join(CORTEX_ROOT, 'logs') },
    ports: { backend: CORTEX_PLATFORM_PORT, gateway: 4840, websocket: 4841 },
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
for (const a of agents) log(`  ~/Cortex/bots/${a.name.padEnd(10)} agent workspace (neutral home)`);
log('  ~/.cortex/       token vault (locked, 700)');
log('  ~/.cortexrc.json       configuration\n');
log('Agents:');
log('  admin      system        → ~/.cortex/keys/admin.env');
for (const a of agents) log(`  ${a.name.padEnd(10)} ${a.platform.padEnd(13)} → ~/.cortex/keys/${a.name}.env`);
console.log('');
log('Each agent gets a minted identity + token. Connect any MCP-capable');
log('agent with the printed connection facts + the onboarding prompt');
log(`(${onboardingPromptPath().replace(HOME, '~')}); no per-model wiring is generated.\n`);
log('Services:');
log(`  Gateway         → port 4840 (${shouldInstallService() ? 'native service' : 'portable launcher'})`);
log(`  Platform-backend → port ${CORTEX_PLATFORM_PORT}\n`);

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

// Connection facts (model-agnostic — no per-platform wiring generated).
log('Agent connection facts...');
for (const a of agents) {
  const facts = connectionFacts({ name: a.name, tokenPath: path.join(VAULT_DIR, 'keys', `${a.name}.env`) });
  ok(`  ${a.name}  identity + token minted`);
  printConnectionFacts(facts);
}

ensureCliWrappers();

// Database
if (!fs.existsSync(DB_PATH)) {
  try {
    const { getDb } = await import(path.join(PROJECT_ROOT, 'sdk', 'db', 'connection.js'));
    const db = getDb({ path: DB_PATH });
    db.close();
    ok('Database initialized');
  } catch (e) { fail(`Database init: ${e.message}`); }
} else skip('Database');

// Service management — portable launcher is the default; --service installs a
// native OS service.
if (shouldInstallService()) {
  const svc = installNativeService();
  svc.installed ? ok(`Native service configured (${svc.kind})`) : warn(svc.note);
} else {
  ok('Portable launcher mode — gateway starts as a detached process (cortex start). Pass --service to install a native OS service.');
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

// Gateway — native service if installed this run, else the portable launcher.
let gatewayStarted = false;
if (shouldInstallService() && !isMac && process.platform !== 'win32') {
  const gwStart = spawnSync('systemctl', ['--user', 'start', 'cortex-gateway.service']);
  gatewayStarted = !gwStart.error && gwStart.status === 0 && await checkHealth(4840);
  gatewayStarted ? ok('Gateway started on port 4840 (systemd)') : fail('Gateway start failed — run: cortex gateway start');
} else {
  const spec = portableLauncher();
  spawn(spec.command, spec.args, spec.options).unref();
  gatewayStarted = await checkHealth(4840);
  gatewayStarted ? ok('Gateway started on port 4840 (portable launcher)') : fail('Gateway start failed — run: bun services/gateway/server.js');
}

// Platform-backend
if (startPlatformBackend()) {
  await new Promise(r => setTimeout(r, 2000));
  try {
    const r = await fetch(`http://127.0.0.1:${CORTEX_PLATFORM_PORT}/`, { signal: AbortSignal.timeout(3000) });
    r.ok ? ok(`Platform-backend started on port ${CORTEX_PLATFORM_PORT}`) : warn('Platform-backend starting...');
  } catch { warn('Platform-backend starting — may take a moment'); }
} else { fail('Platform-backend not found'); }

// Health
if (await checkHealth(4840, 1) && await checkHealth(CORTEX_PLATFORM_PORT, 1).catch(() => false)) {
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
      const tk = parseTokenEnv(fs.readFileSync(ep, 'utf8'));
      if (tk && await testToken(tk)) { ok('  Token valid'); ok('  Gateway reachable'); passed++; }
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
      const adminTk = parseTokenEnv(fs.readFileSync(path.join(VAULT_DIR, 'keys', 'admin.env'), 'utf8'));
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
openBrowser(`http://127.0.0.1:${CORTEX_PLATFORM_PORT}`);
ok('Opening dashboard in browser...');

// ── Done ──
console.log(`\n  ${C.b}╔══════════════════════════════════════╗${C.x}`);
console.log(`  ${C.b}║           Setup Complete            ║${C.x}`);
console.log(`  ${C.b}╚══════════════════════════════════════╝${C.x}\n`);
log(`Dashboard:  http://127.0.0.1:${CORTEX_PLATFORM_PORT}`);
log(`Gateway:    http://127.0.0.1:4840`);
log(`Walkthrough: ${onboardingPromptPath().replace(HOME, '~')}`);
log(`Full guide:  docs/walkthrough.md\n`);
log('Next steps:\n');
log('1. Open the dashboard and create your first project');
log('   to start tracking work');
log(`   http://127.0.0.1:${CORTEX_PLATFORM_PORT}\n`);
log('2. Set up tasks inside your project — assign them');
log('   to agents, set priorities, and track progress\n');
if (agents.length > 0) {
  log('3. Connect an agent (any MCP-capable runtime):\n');
  log(`   - Open the onboarding prompt: ${onboardingPromptPath().replace(HOME, '~')}`);
  log('   - Hand it to your agent; it adds the Cortex MCP server in its own');
  log('     format, registers, claims its first task, and runs the loop.');
  log('   - Token files live in ~/.cortex/keys/<agent>.env\n');
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
}

if (import.meta.main) {
  await main();
}
