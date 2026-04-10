#!/usr/bin/env bun
/**
 * cortex init — Cortex Installer
 *
 * Detects AI coding agents, starts gateway, routes traffic, generates gate files,
 * and enables basic stub/fake detection. No sudo. Runs from ~/.cortex/.
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, chmodSync, unlinkSync } from 'node:fs';
import { execSync, spawn } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline';
import { randomBytes, createHash } from 'node:crypto';
import { homedir } from 'node:os';

const HOME = homedir();
const CORTEX_DIR = join(HOME, '.cortex');
const CORTEX_DATA = join(CORTEX_DIR, 'data');
const CORTEX_AGENTS = join(CORTEX_DIR, 'agents');
const CORTEX_CONFIG = join(CORTEX_DIR, 'config.json');
const REGISTRY_PATH = join(CORTEX_DATA, 'token-registry.json');
const GATEWAY_PORT = 4840;
const GATEWAY_HOST = '127.0.0.1';
const GATEWAY_URL = `http://${GATEWAY_HOST}:${GATEWAY_PORT}`;
const BUN_BIN = which('bun') || 'bun';

const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
function resolveManagedGatewayDir(scriptDir = SCRIPT_DIR) {
  const currentGatewayDir = '/opt/cortex/current/services/gateway';
  if (scriptDir.startsWith('/opt/cortex/releases/') || scriptDir.startsWith('/opt/cortex/current/')) {
    return currentGatewayDir;
  }
  return resolve(scriptDir, '..');
}

const GATEWAY_DIR = resolveManagedGatewayDir(SCRIPT_DIR);
const MCP_STDIO = join(GATEWAY_DIR, 'mcp', 'stdio.js');
const SERVER_JS = join(GATEWAY_DIR, 'server.js');
const MANAGED_END_MARKER = '<!-- /cortex-managed -->';

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function which(cmd) {
  try { return execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf8' }).trim(); } catch { return null; }
}
function fileExists(p) { try { return existsSync(p); } catch { return false; } }
function backupIfExists(p) {
  if (fileExists(p)) copyFileSync(p, p + '.bak');
}
function serviceActive(n) {
  try { return execSync(`systemctl is-active ${n} 2>/dev/null`, { encoding: 'utf8' }).trim() === 'active'; } catch { return false; }
}
function httpHealthy(url) {
  try { execSync(`curl -sf --max-time 2 ${url} >/dev/null 2>&1`); return true; } catch { return false; }
}
function ensureDir(d) { mkdirSync(d, { recursive: true }); }
function isOptRuntimePath(p) { return typeof p === 'string' && /^\/opt\/cortex(?:\/|$)/.test(p); }

function loadConfiguredWorkspace() {
  try {
    const config = JSON.parse(readFileSync(CORTEX_CONFIG, 'utf8'));
    return typeof config.workspace === 'string' && config.workspace ? config.workspace : null;
  } catch {
    return null;
  }
}

function resolveWorkspace(cwd = process.cwd()) {
  const envWorkspace = process.env.CORTEX_WORKSPACE;
  if (envWorkspace) return envWorkspace;

  const configuredWorkspace = loadConfiguredWorkspace();
  if (isOptRuntimePath(cwd) && configuredWorkspace && !isOptRuntimePath(configuredWorkspace)) {
    return configuredWorkspace;
  }

  if (configuredWorkspace && !isOptRuntimePath(configuredWorkspace) && !fileExists(join(cwd, '.claude')) && !fileExists(join(cwd, '.codex')) && !fileExists(join(cwd, '.openclaw'))) {
    return configuredWorkspace;
  }

  return cwd;
}

const WORKSPACE = resolveWorkspace();

function readPidFile(path) {
  try {
    const pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function processExists(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readProcessEnv(pid) {
  try {
    const raw = readFileSync(`/proc/${pid}/environ`);
    return raw.toString('utf8').split('\0').reduce((acc, entry) => {
      const idx = entry.indexOf('=');
      if (idx > 0) acc[entry.slice(0, idx)] = entry.slice(idx + 1);
      return acc;
    }, {});
  } catch {
    return null;
  }
}

function readProcessCmdline(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`).toString('utf8').replace(/\0/g, ' ');
  } catch {
    return '';
  }
}

function findManagedGatewayPid() {
  const pidFile = join(CORTEX_DIR, 'gateway.pid');
  const fromPidFile = readPidFile(pidFile);
  if (processExists(fromPidFile)) return fromPidFile;

  try {
    const out = execSync('ps -eo pid=,args=', { encoding: 'utf8' });
    for (const line of out.split('\n')) {
      if (!line.includes(SERVER_JS)) continue;
      const match = line.trim().match(/^(\d+)\s+/);
      if (!match) continue;
      const pid = Number.parseInt(match[1], 10);
      if (processExists(pid)) return pid;
    }
  } catch {}

  return null;
}

function stopProcess(pid) {
  if (!processExists(pid)) return true;
  try { process.kill(pid, 'SIGTERM'); } catch {}
  for (let i = 0; i < 20; i++) {
    execSync('sleep 0.1');
    if (!processExists(pid)) return true;
  }
  try { process.kill(pid, 'SIGKILL'); } catch {}
  return !processExists(pid);
}

function generateToken(agentName) {
  const raw = `cortex_${agentName}_${randomBytes(32).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  return { raw, hash };
}

function getLegacyAgentName(agent) {
  return agent.platform;
}

const rl = createInterface({ input: process.stdin, output: process.stdout });
function ask(q) { return new Promise(r => rl.question(q, r)); }
function print(msg = '') { console.log(msg); }
function printHeader(msg) { print(); print(`  ${msg}`); print(`  ${'─'.repeat(msg.length)}`); }

function writeManagedFile(path, content, options = {}) {
  const { mode, backup = true } = options;
  ensureDir(dirname(path));
  let existing = null;
  try { existing = readFileSync(path, 'utf8'); } catch {}
  if (existing === content) {
    if (mode !== undefined && fileExists(path)) chmodSync(path, mode);
    return;
  }
  if (backup) backupIfExists(path);
  writeFileSync(path, content, mode !== undefined ? { mode } : undefined);
}

/**
 * Merge JSON files — reads existing, applies updater function, writes back.
 * Creates .bak backup of existing file before modification.
 */
function mergeJsonFile(path, updater) {
  ensureDir(dirname(path));
  let existing = {};
  let raw = '';
  try { raw = readFileSync(path, 'utf8'); } catch {}
  try { existing = raw ? JSON.parse(raw) : {}; } catch {}
  const merged = updater(existing);
  const next = JSON.stringify(merged, null, 2) + '\n';
  if (next !== raw) {
    backupIfExists(path);
    writeFileSync(path, next);
  }
}

function mergeMarkdownContent(existing, marker, content) {
  const escapedMarker = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedEndMarker = MANAGED_END_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (existing.includes(marker)) {
    const re = new RegExp(`${escapedMarker}[\\s\\S]*?(?:${escapedEndMarker}|$)`);
    return existing.replace(re, content);
  }
  return existing + (existing.endsWith('\n') ? '' : '\n') + content;
}

/**
 * Merge a markdown file — replaces the full managed section if present.
 * Creates .bak backup of existing file before modification.
 */
function mergeMarkdownSection(path, marker, content) {
  ensureDir(dirname(path));
  let existing = '';
  try { existing = readFileSync(path, 'utf8'); } catch {}
  const next = mergeMarkdownContent(existing, marker, content);
  if (next !== existing) {
    backupIfExists(path);
    writeFileSync(path, next);
  }
}

// ---------------------------------------------------------------------------
// Step 1: Agent Detection
// ---------------------------------------------------------------------------

function makeDetectedAgent({ name, displayName, platform, path, enforcement, gated }) {
  return { name, displayName, platform, path, enforcement, gated };
}

function canonicalAgentForPlatform(platform, path) {
  switch (platform) {
    case 'claude-code':
      return makeDetectedAgent({ name: 'atlas', displayName: 'Atlas', platform, path, enforcement: 'hooks', gated: true });
    case 'codex':
      return makeDetectedAgent({ name: 'zeus', displayName: 'Zeus', platform, path, enforcement: 'execpolicy', gated: true });
    case 'openclaw':
      return makeDetectedAgent({ name: 'gerald', displayName: 'Gerald', platform, path, enforcement: 'exec-approvals', gated: true });
    case 'ollama':
      return makeDetectedAgent({ name: 'ollama', displayName: 'Ollama', platform, path, enforcement: 'none', gated: false });
    case 'cursor':
      return makeDetectedAgent({ name: 'cursor', displayName: 'Cursor', platform, path, enforcement: 'none', gated: false });
    case 'cline':
      return makeDetectedAgent({ name: 'cline', displayName: 'Cline', platform, path, enforcement: 'none', gated: false });
    default:
      return null;
  }
}

function detectAgents() {
  const agents = [];

  if (which('claude') || fileExists(join(HOME, '.claude')))
    agents.push(canonicalAgentForPlatform('claude-code', which('claude') || '~/.claude'));

  if (which('codex') || fileExists(join(HOME, '.codex')))
    agents.push(canonicalAgentForPlatform('codex', which('codex') || '~/.codex'));

  if (serviceActive('openclaw') || httpHealthy('http://localhost:18789/health') || fileExists(join(HOME, '.openclaw')))
    agents.push(canonicalAgentForPlatform('openclaw', serviceActive('openclaw') ? 'systemd' : ':18789'));

  if (which('ollama') || httpHealthy('http://localhost:11434/api/tags'))
    agents.push(canonicalAgentForPlatform('ollama', which('ollama') || ':11434'));

  if (fileExists(join(HOME, '.cursor')))
    agents.push(canonicalAgentForPlatform('cursor', '~/.cursor'));

  if (fileExists(join(HOME, '.cline')))
    agents.push(canonicalAgentForPlatform('cline', '~/.cline'));

  return agents.filter(Boolean);
}

// ---------------------------------------------------------------------------
// Step 2: Selection UI
// ---------------------------------------------------------------------------

async function selectAgents(detected) {
  if (detected.length === 0) {
    print('  No AI coding agents detected.');
    process.exit(1);
  }

  print();
  print('  Detected agents:');
  for (const a of detected) {
    const tag = a.gated ? '[gated]' : '[route]';
    const label = a.platform === a.name ? a.displayName : `${a.displayName} (${a.platform})`;
    print(`    ${tag} ${label.padEnd(24)} — ${a.path}`);
  }
  print();
  print('  Select agents to route through Cortex:');
  print('    [1] All detected agents (recommended)');
  print('    [2] Choose individually');
  print('    [3] Skip — configure later');
  print();

  const choice = await ask('  > ');
  if (choice.trim() === '3') return [];
  if (choice.trim() === '1') return detected;

  const selected = [];
  for (const a of detected) {
    const yn = await ask(`    Route ${a.displayName}? [Y/n] `);
    if (yn.trim().toLowerCase() !== 'n') selected.push(a);
  }
  return selected;
}

// ---------------------------------------------------------------------------
// Step 3: Gateway Setup
// ---------------------------------------------------------------------------

function setupGateway() {
  ensureDir(CORTEX_DIR);
  ensureDir(CORTEX_DATA);
  ensureDir(CORTEX_AGENTS);
  const desiredDbPath = join(CORTEX_DATA, 'gateway.db');
  const desiredRegistryPath = REGISTRY_PATH;

  if (!fileExists(SERVER_JS)) {
    print(`  Error: Gateway source not found at ${SERVER_JS}`);
    return false;
  }

  // Ensure registry file exists before gateway starts so fs.watch() can attach
  if (!fileExists(REGISTRY_PATH)) {
    writeFileSync(REGISTRY_PATH, JSON.stringify({ agents: {} }) + '\n');
  }

  if (httpHealthy(`${GATEWAY_URL}/health`)) {
    const pid = findManagedGatewayPid();
    if (!pid) {
      print('  Gateway already running on :4840 (unmanaged instance detected)');
      return true;
    }

    const cmdline = readProcessCmdline(pid);
    const env = readProcessEnv(pid) || {};
    const managed = cmdline.includes(SERVER_JS);
    const dbMatches = env.CORTEX_GATEWAY_DB === desiredDbPath;
    const registryMatches = env.CORTEX_TOKEN_REGISTRY === desiredRegistryPath;

    if (managed && dbMatches && registryMatches) {
      writeFileSync(join(CORTEX_DIR, 'gateway.pid'), String(pid));
      print('  Gateway already running on :4840');
      return true;
    }

    print('  Gateway running with stale or missing Cortex env; restarting...');
    if (!stopProcess(pid)) {
      print(`  Error: Could not stop existing gateway process ${pid}`);
      return false;
    }
  }

  print('  Starting gateway...');
  const child = spawn('bun', [SERVER_JS], {
    env: {
      ...process.env,
      CORTEX_GATEWAY_HOST: GATEWAY_HOST,
      CORTEX_GATEWAY_PORT: String(GATEWAY_PORT),
      CORTEX_GATEWAY_DB: desiredDbPath,
      CORTEX_TOKEN_REGISTRY: REGISTRY_PATH,
    },
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  writeFileSync(join(CORTEX_DIR, 'gateway.pid'), String(child.pid));

  for (let i = 0; i < 20; i++) {
    execSync('sleep 0.25');
    if (httpHealthy(`${GATEWAY_URL}/health`)) {
      print(`  Gateway started (pid ${child.pid})`);
      return true;
    }
  }
  print('  Warning: Gateway started but health check failed');
  return true;
}

// ---------------------------------------------------------------------------
// Step 4: Token Registration
// ---------------------------------------------------------------------------

function registerAgent(agent) {
  let registry;
  try { registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')); } catch { registry = { agents: {} }; }
  const legacyName = getLegacyAgentName(agent);
  const legacyEnvPath = join(CORTEX_AGENTS, `${legacyName}.env`);
  const canonicalEnvPath = join(CORTEX_AGENTS, `${agent.name}.env`);

  if (legacyName && legacyName !== agent.name && registry.agents[legacyName] && !registry.agents[agent.name]) {
    registry.agents[agent.name] = {
      ...registry.agents[legacyName],
      platform: agent.platform,
    };
    delete registry.agents[legacyName];

    if (fileExists(legacyEnvPath) && !fileExists(canonicalEnvPath)) {
      const legacyEnv = readFileSync(legacyEnvPath, 'utf8');
      writeFileSync(canonicalEnvPath, legacyEnv, { mode: 0o600 });
    }
  }

  if (legacyName && legacyName !== agent.name && registry.agents[legacyName]) {
    delete registry.agents[legacyName];
  }

  // If already registered with valid env file, return existing
  if (registry.agents[agent.name]) {
    const envPath = canonicalEnvPath;
    if (fileExists(envPath)) {
      const m = readFileSync(envPath, 'utf8').match(/CORTEX_AGENT_TOKEN=(.+)/);
      if (m) {
        writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
        if (fileExists(legacyEnvPath) && legacyEnvPath !== canonicalEnvPath) {
          try { unlinkSync(legacyEnvPath); } catch {}
        }
        return m[1].trim();
      }
    }
  }

  const { raw, hash } = generateToken(agent.name);
  registry.agents[agent.name] = { hash, platform: agent.platform, created: new Date().toISOString() };
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
  writeFileSync(canonicalEnvPath, `CORTEX_AGENT_TOKEN=${raw}\n`, { mode: 0o600 });
  if (fileExists(legacyEnvPath) && legacyEnvPath !== canonicalEnvPath) {
    try { unlinkSync(legacyEnvPath); } catch {}
  }
  return raw;
}

function registerAdmin() {
  let registry;
  try { registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')); } catch { registry = { agents: {} }; }

  if (registry.agents['admin']) {
    const envPath = join(CORTEX_AGENTS, 'admin.env');
    if (fileExists(envPath)) {
      const m = readFileSync(envPath, 'utf8').match(/CORTEX_ADMIN_TOKEN=(.+)/);
      if (m) return m[1].trim();
    }
  }

  const raw = `cortex_admin_${randomBytes(32).toString('hex')}`;
  const hash = createHash('sha256').update(raw).digest('hex');
  registry.agents['admin'] = { hash, platform: 'admin', role: 'admin', created: new Date().toISOString() };
  writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2) + '\n');
  writeFileSync(join(CORTEX_AGENTS, 'admin.env'), `CORTEX_ADMIN_TOKEN=${raw}\n`, { mode: 0o600 });
  return raw;
}

// ---------------------------------------------------------------------------
// Step 5: Gate File Generation
// ---------------------------------------------------------------------------

/**
 * Claude Code gate files.
 * Hooks read token from ENV_FILE at runtime — no raw tokens in generated files.
 * Agent name is read from AGENT_NAME, not $(whoami).
 */
function generateClaudeCodeGates(agentName) {
  const hookDir = join(WORKSPACE, '.claude', 'hooks');
  const envFile = join(CORTEX_AGENTS, `${agentName}.env`);
  const runtimeDir = join(CORTEX_DIR, 'run');
  const taskFile = join(runtimeDir, `${agentName}-current-task`);
  ensureDir(hookDir);

  // --- cortex-gate.sh ---
  writeManagedFile(join(hookDir, 'cortex-gate.sh'), `#!/usr/bin/env bash
set -euo pipefail

CORTEX="${GATEWAY_URL}"
AGENT_NAME="${agentName}"
ENV_FILE="${envFile}"
RUNTIME_DIR="${runtimeDir}"
TASK_FILE="${taskFile}"
WORKSPACE="${WORKSPACE}"

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR" 2>/dev/null || true
TOKEN=\$(grep CORTEX_AGENT_TOKEN "\$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo "")
cortex_curl() {
  [ -n "\$TOKEN" ] || return 1
  curl --config <(printf '%s\\n' "header = \\"X-Cortex-Token: \$TOKEN\\"") "$@"
}

INPUT=\$(cat)
if ! echo "\$INPUT" | jq empty 2>/dev/null; then
  echo '{"decision":"block","reason":"BLOCKED: Invalid JSON input"}'
  exit 2
fi

TOOL_NAME=\$(echo "\$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=\$(echo "\$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""')

# --- MCP task tools exempt from gate (how agents get/create tasks) ---
case "\$TOOL_NAME" in
  mcp__cortex__task_create|mcp__cortex__task_list|mcp__cortex__task_get|mcp__cortex__get_next_task|mcp__cortex__claim_task|mcp__cortex__task_release|mcp__cortex__task_reassign|mcp__cortex__task_cancel|mcp__cortex__task_reopen|mcp__cortex__heartbeat|mcp__cortex__health_check|mcp__cortex__agent_status|mcp__cortex__agent_register|mcp__cortex__gateway_stats|mcp__cortex__cost_summary|mcp__cortex__logs_query|mcp__cortex__error_history|mcp__cortex__context_save|mcp__cortex__context_retrieve|mcp__cortex__context_list|mcp__cortex__project_list|mcp__cortex__project_get|mcp__cortex__project_create|mcp__cortex__project_summary|mcp__cortex__bridge_inbox)
    exit 0 ;;
esac

# --- Bash command filtering ---
if [ "\$TOOL_NAME" = "Bash" ]; then
  CMD=\$(echo "\$INPUT" | jq -r '.tool_input.command // ""')

  # Block dangerous commands
  if echo "\$CMD" | grep -qP '(\\brm\\s+-rf\\b|\\bgit\\s+push\\s+--force\\b|\\bsudo\\b)'; then
    echo '{"decision":"block","reason":"BLOCKED: Dangerous command blocked by Cortex."}'
    exit 2
  fi

  # Never grant permissions to others/everyone
  if echo "\$CMD" | grep -qP '\\bchmod\\b' 2>/dev/null; then
    if echo "\$CMD" | grep -qP '\\bchmod\\s+[0-7]{3,4}0\\b' 2>/dev/null; then
      : # numeric chmod is only allowed when others permissions are 0
    else
      echo '{"decision":"block","reason":"BLOCKED: chmod must never grant permissions to others/everyone. Numeric modes must end in 0."}'
      exit 2
    fi
  fi

  # Reject shell metacharacters (command injection via substitution/chaining)
  if echo "\$CMD" | grep -qP '(\\$\\(|\`|;\\s|&&|\\|\\||&\\s)' 2>/dev/null; then
    : # Fall through to task check
  # Reject commands with write sinks
  elif echo "\$CMD" | grep -qP '(>\\s|>>\\s|\\btee\\b|\\bdd\\b|\\binstall\\b|\\bwget\\b|\\bcurl\\s+-o|\\bcurl\\s+--output|\\bsed\\s+-i|\\bchmod\\b|\\bchown\\b|\\brm\\s|\\bmv\\s|\\bcp\\s|\\bmkdir\\s|\\btouch\\s)' 2>/dev/null; then
    : # Fall through to task check
  # Allow read-only commands without task
  elif echo "\$CMD" | grep -qP '^\\s*(ls|cat|head|tail|echo|printf|wc|file|stat|du|df|find|which|type|env|id|whoami|hostname|uname|date|uptime|free|ps|ss|curl\\s+-s|curl\\s.*localhost|git\\s+(status|log|diff|show|branch|remote|blame)|grep|rg|sort|uniq|cut|tr|less|more|realpath|basename|dirname|pwd|jq|sg\\s+)' 2>/dev/null; then
    exit 0
  fi
fi

# --- Read operations always allowed ---
case "\$TOOL_NAME" in
  Read|Glob|Grep|Agent|WebFetch|WebSearch) exit 0 ;;
esac

# --- Task check for write operations ---
if [ ! -f "\$TASK_FILE" ]; then
  echo '{"decision":"block","reason":"BLOCKED: No active Cortex task. Claim a task first."}'
  exit 2
fi

TASK_ID=\$(cat "\$TASK_FILE")
if [ -z "\$TASK_ID" ]; then
  echo '{"decision":"block","reason":"BLOCKED: Task file is empty."}'
  exit 2
fi

if [ -z "\$TOKEN" ]; then
  echo '{"decision":"block","reason":"BLOCKED: Missing Cortex agent token."}'
  exit 2
fi

TASK_DATA=\$(cortex_curl -sf --max-time 4 "\$CORTEX/tasks/\$TASK_ID" 2>/dev/null || echo '{"error":"unreachable"}')
STATUS=\$(echo "\$TASK_DATA" | jq -r '.status // "unknown"')

if [[ "\$STATUS" != "claimed" && "\$STATUS" != "in_progress" ]]; then
  echo '{"decision":"block","reason":"BLOCKED: Task status must be claimed or in_progress."}'
  exit 2
fi

# --- Path enforcement ---
if [[ "\$TOOL_NAME" =~ ^(Write|Edit|NotebookEdit)$ ]] && [[ -n "\$FILE_PATH" ]]; then
  REAL_PATH=\$(realpath -m "\$FILE_PATH" 2>/dev/null || echo "\$FILE_PATH")
  if [ -L "\$FILE_PATH" ]; then
    LINK_TARGET=\$(readlink -f "\$FILE_PATH" 2>/dev/null || echo "\$FILE_PATH")
    if [[ "\$LINK_TARGET" != "\$WORKSPACE"/* ]]; then
      echo '{"decision":"block","reason":"BLOCKED: Symlink target outside workspace."}'
      exit 2
    fi
  fi
  if [[ "\$REAL_PATH" != "\$WORKSPACE"/* ]]; then
    echo '{"decision":"block","reason":"BLOCKED: Cannot write outside workspace."}'
    exit 2
  fi
fi

# --- Heartbeat ---
cortex_curl -sf --max-time 2 -X POST "\$CORTEX/heartbeat" \\
  -H "Content-Type: application/json" \\
  -d "{\\"agent_id\\":\\"\$AGENT_NAME\\",\\"current_task\\":\\"\$TASK_ID\\"}" > /dev/null 2>&1 || true

exit 0
`, { mode: 0o755 });

  // --- cortex-report.sh ---
  writeManagedFile(join(hookDir, 'cortex-report.sh'), `#!/usr/bin/env bash
set -uo pipefail

CORTEX="${GATEWAY_URL}"
AGENT_NAME="${agentName}"
ENV_FILE="${envFile}"
RUNTIME_DIR="${runtimeDir}"
TASK_FILE="${taskFile}"

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR" 2>/dev/null || true
[ ! -f "\$TASK_FILE" ] && exit 0
TASK_ID=\$(cat "\$TASK_FILE" 2>/dev/null || echo "")
[ -z "\$TASK_ID" ] && exit 0

TOKEN=\$(grep CORTEX_AGENT_TOKEN "\$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo "")
cortex_curl() {
  [ -n "\$TOKEN" ] || return 1
  curl --config <(printf '%s\\n' "header = \\"X-Cortex-Token: \$TOKEN\\"") "$@"
}
INPUT=\$(cat)
TOOL_NAME=\$(echo "\$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
FILE_PATH=\$(echo "\$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // "unknown"' 2>/dev/null || echo "unknown")

# --- Stub Detection ---
STUB_DETECTED="false"
STUB_REASON=""

if [[ "\$TOOL_NAME" =~ ^(Write|Edit|NotebookEdit)$ ]]; then
  CONTENT=\$(echo "\$INPUT" | jq -r '.tool_input.content // .tool_input.new_string // ""' 2>/dev/null || echo "")

  if echo "\$CONTENT" | grep -qE 'return\\s*\\{\\s*(ok|success)\\s*:\\s*true\\s*\\}'; then
    if ! echo "\$CONTENT" | grep -qE '(await|fetch|query|exec|spawn|readFile|writeFile|createHash)'; then
      STUB_DETECTED="true"
      STUB_REASON="Returns ok/success with no real implementation"
    fi
  fi

  if echo "\$CONTENT" | grep -qiE '\\b(TODO|FIXME|PLACEHOLDER|STUB|NOT_IMPLEMENTED|HACK)\\b'; then
    STUB_DETECTED="true"
    STUB_REASON="Contains placeholder/stub markers"
  fi

  if echo "\$CONTENT" | grep -qP '(function|async function|const \\w+ = async)\\s*\\([^)]*\\)\\s*\\{\\s*\\}'; then
    STUB_DETECTED="true"
    STUB_REASON="Empty function body"
  fi

  # Pattern: pass/noop implementations
  if echo "\$CONTENT" | grep -qP 'function\\s+\\w+\\([^)]*\\)\\s*\\{\\s*(return;?|pass)\\s*\\}'; then
    STUB_DETECTED="true"
    STUB_REASON="Noop/pass function implementation"
  fi

  # Pattern: return null/undefined with no logic
  if echo "\$CONTENT" | grep -qP 'function\\s+\\w+\\([^)]*\\)\\s*\\{\\s*return\\s+(null|undefined|0|false|""|\\{\\})\\s*;?\\s*\\}'; then
    STUB_DETECTED="true"
    STUB_REASON="Function returns trivial value with no logic"
  fi

  # Pattern: will finish later / not done yet comments
  if echo "\$CONTENT" | grep -qiE '(will (finish|complete|implement|do) (later|this|soon)|not (done|finished|implemented) yet|come back to this|skip for now)'; then
    STUB_DETECTED="true"
    STUB_REASON="Contains deferred-work comments"
  fi

  # Pattern: console.log only implementation
  LINE_COUNT=\$(echo "\$CONTENT" | wc -l)
  LOG_COUNT=\$(echo "\$CONTENT" | grep -cE 'console\\.(log|warn|info|error)' || echo 0)
  if [ "\$LINE_COUNT" -lt 10 ] && [ "\$LOG_COUNT" -gt 0 ]; then
    REAL_LINES=\$(echo "\$CONTENT" | grep -cvE '^\\s*(\$|//|/\\*|\\*|console\\.|\\}|\\{|import|export|function|async|const|let|var)' || echo 0)
    if [ "\$REAL_LINES" -lt 2 ]; then
      STUB_DETECTED="true"
      STUB_REASON="Implementation is only console.log statements"
    fi
  fi
fi

if [ "\$TOOL_NAME" = "Bash" ]; then
  OUTPUT=\$(echo "\$INPUT" | jq -r '.tool_output // ""' 2>/dev/null || echo "")

  if echo "\$OUTPUT" | grep -qiE '(route\\.fulfill|page\\.route.*fulfill|intercept.*mock|mock.*response.*fake)'; then
    STUB_DETECTED="true"
    STUB_REASON="Test intercepts/mocks API responses"
  fi

  if echo "\$OUTPUT" | grep -qE 'expect\\(true\\)\\.toBe\\(true\\)|assert\\.ok\\(true\\)|expect\\(1\\)\\.toBe\\(1\\)'; then
    STUB_DETECTED="true"
    STUB_REASON="Test contains trivial always-passing assertions"
  fi
fi

# --- Report ---
PAYLOAD=\$(jq -n \\
  --arg agent "\$AGENT_NAME" \\
  --arg summary "\$TOOL_NAME on \$FILE_PATH" \\
  --arg file "\$FILE_PATH" \\
  --argjson stub "\$STUB_DETECTED" \\
  --arg stub_reason "\$STUB_REASON" \\
  '{agent_id: \$agent, status: "in_progress", summary: \$summary, files_changed: [\$file], stub_detected: \$stub, stub_reason: \$stub_reason}')

cortex_curl -sf --max-time 3 -X POST "\$CORTEX/tasks/\$TASK_ID/progress" \\
  -H "Content-Type: application/json" \\
  -d "\$PAYLOAD" > /dev/null 2>&1 || true

if [ "\$STUB_DETECTED" = "true" ]; then
  echo "STUB/FAKE DETECTED: \$STUB_REASON — File: \$FILE_PATH" >&2
fi

exit 0
`, { mode: 0o755 });

  // --- cortex-complete.sh ---
  writeManagedFile(join(hookDir, 'cortex-complete.sh'), `#!/usr/bin/env bash
CORTEX="${GATEWAY_URL}"
AGENT_NAME="${agentName}"
ENV_FILE="${envFile}"
RUNTIME_DIR="${runtimeDir}"
TASK_FILE="${taskFile}"

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR" 2>/dev/null || true
TOKEN=\$(grep CORTEX_AGENT_TOKEN "\$ENV_FILE" 2>/dev/null | cut -d= -f2- || echo "")
cortex_curl() {
  [ -n "\$TOKEN" ] || return 1
  curl --config <(printf '%s\\n' "header = \\"X-Cortex-Token: \$TOKEN\\"") "$@"
}

cortex_curl -sf --max-time 2 -X POST "\$CORTEX/heartbeat" \\
  -H "Content-Type: application/json" \\
  -d "{\\"agent_id\\":\\"\$AGENT_NAME\\",\\"current_task\\":null}" > /dev/null 2>&1 || true

[ -f "\$TASK_FILE" ] && rm -f "\$TASK_FILE"
exit 0
`, { mode: 0o755 });

  // --- settings.json — merge hooks, preserve existing non-cortex hooks ---
  mergeJsonFile(join(WORKSPACE, '.claude', 'settings.json'), (existing) => {
    if (!existing.hooks) existing.hooks = {};

    const cortexPre = { matcher: 'Write|Edit|NotebookEdit|Bash', hooks: [{ type: 'command', command: '.claude/hooks/cortex-gate.sh', timeout: 30000 }] };
    const cortexPost = { matcher: 'Write|Edit|NotebookEdit|Bash', hooks: [{ type: 'command', command: '.claude/hooks/cortex-report.sh', timeout: 10000 }] };
    const cortexStop = { matcher: '', hooks: [{ type: 'command', command: '.claude/hooks/cortex-complete.sh', timeout: 5000 }] };

    function mergeHookList(existing, cortexEntry) {
      if (!existing) return [cortexEntry];
      // Remove any existing cortex entries, then add the new one
      const filtered = existing.filter(h =>
        !h.hooks?.some(hk => typeof hk.command === 'string' && hk.command.includes('cortex-'))
      );
      filtered.push(cortexEntry);
      return filtered;
    }

    existing.hooks.PreToolUse = mergeHookList(existing.hooks.PreToolUse, cortexPre);
    existing.hooks.PostToolUse = mergeHookList(existing.hooks.PostToolUse, cortexPost);
    existing.hooks.Stop = mergeHookList(existing.hooks.Stop, cortexStop);

    return existing;
  });

  // --- CLAUDE.md — merge, don't overwrite ---
  const CORTEX_MARKER = '<!-- cortex-managed -->';
  const claudeMdContent = `${CORTEX_MARKER}
## Cortex Agent Configuration

### Identity
You are a Cortex-gated coding agent. You work exclusively on tasks
assigned through the Cortex orchestrator (localhost:${GATEWAY_PORT}).

### Mandatory Protocol
- NEVER write code without an active Cortex task
- ALWAYS decide task state before starting work:
  - If a matching pending task already exists, claim it
  - If the work is new and needs tracking, create a task first
  - Do not default to claim_task without checking
- ALWAYS call report_progress at least twice (planning + testing)
- ALWAYS call submit_result when done
- ALWAYS call request_verification after submission
- If verification returns rejected, address ALL feedback before resubmitting

### File Rules
- ALL files MUST be created inside the workspace
- NEVER create files outside the workspace directory
- NEVER produce stub implementations — all code must be functional
- NEVER mock API responses in tests unless explicitly instructed
- NEVER grant permissions to others/everyone
- For numeric chmod, modes MUST end in 0

### Tools Available via MCP
- mcp__cortex__task_list
- mcp__cortex__task_get
- mcp__cortex__task_create
- mcp__cortex__claim_task
- mcp__cortex__get_next_task
- mcp__cortex__task_release
- mcp__cortex__task_reassign
- mcp__cortex__task_cancel
- mcp__cortex__task_reopen
- mcp__cortex__report_progress
- mcp__cortex__submit_result
- mcp__cortex__request_verification
- mcp__cortex__task_approve
- mcp__cortex__task_reject
- mcp__cortex__task_update
- mcp__cortex__task_comment
- mcp__cortex__heartbeat
- mcp__cortex__agent_register
- mcp__cortex__bridge_inbox
- mcp__cortex__bridge_send
${MANAGED_END_MARKER}
`;
  mergeMarkdownSection(join(WORKSPACE, 'CLAUDE.md'), CORTEX_MARKER, claudeMdContent);

  // --- .mcp.json — merge, token from env var ---
  mergeJsonFile(join(WORKSPACE, '.mcp.json'), (existing) => {
    if (!existing.mcpServers) existing.mcpServers = {};
    existing.mcpServers.cortex = {
      type: 'stdio',
      command: BUN_BIN,
      args: [MCP_STDIO],
      env: {
        CORTEX_API: GATEWAY_URL,
        CORTEX_AGENT_TOKEN_FILE: envFile,
        CORTEX_GATEWAY_DB: join(CORTEX_DATA, 'gateway.db'),
        CORTEX_AGENT_ID: agentName,
        CORTEX_AGENT_PLATFORM: 'claude-code',
        CORTEX_CURRENT_TASK_FILE: taskFile,
      },
    };
    return existing;
  });

  return ['.claude/settings.json', '.claude/hooks/cortex-gate.sh', '.claude/hooks/cortex-report.sh', '.claude/hooks/cortex-complete.sh', 'CLAUDE.md', '.mcp.json'];
}

function generateCodexGates(agentName) {
  const files = [];
  const envFile = join(CORTEX_AGENTS, `${agentName}.env`);

  // --- Rules ---
  const rulesDir = join(HOME, '.codex', 'rules');
  ensureDir(rulesDir);
  writeManagedFile(join(rulesDir, 'cortex-enforcement.rules'), `prefix_rule(
    pattern=["rm", "-rf"],
    decision="forbidden",
    justification="Recursive deletion blocked by Cortex",
)

prefix_rule(
    pattern=["git", "push", "--force"],
    decision="forbidden",
    justification="Force push forbidden by Cortex",
)

prefix_rule(
    pattern=["git", "push"],
    decision="prompt",
    justification="Push requires approval",
)

prefix_rule(
    pattern=["git", "commit"],
    decision="prompt",
    justification="Commit requires approval",
)

prefix_rule(
    pattern=["sudo"],
    decision="forbidden",
    justification="Privilege escalation blocked by Cortex",
)

prefix_rule(
    pattern=["chmod"],
    decision="prompt",
    justification="Never grant permissions to others/everyone. Numeric chmod modes must end in 0.",
)
`);
  files.push('~/.codex/rules/cortex-enforcement.rules');

  // --- AGENTS.md — merge ---
  const CODEX_MARKER = '<!-- cortex-managed -->';
  mergeMarkdownSection(join(WORKSPACE, 'AGENTS.md'), CODEX_MARKER, `${CODEX_MARKER}
## Cortex Agent Protocol

### Mandatory Workflow
1. Check for available tasks via Cortex MCP tools before starting work
2. Decide whether to claim an existing matching task or create a new one before ANY code changes
3. Report progress at least twice during execution
4. Run tests before submitting
5. Submit result through Cortex
6. Request verification and handle feedback

### Constraints
- ALL files MUST be created inside the workspace
- NEVER produce stub implementations
- NEVER fake test results
- Never push to git without explicit task instruction
- NEVER grant permissions to others/everyone
- For numeric chmod, modes MUST end in 0
${MANAGED_END_MARKER}
`);
  files.push('AGENTS.md');

  // --- config.toml — idempotent merge (replace cortex block if exists, else append) ---
  const configToml = join(HOME, '.codex', 'config.toml');
  ensureDir(join(HOME, '.codex'));
  let tomlContent = '';
  try { tomlContent = readFileSync(configToml, 'utf8'); } catch {}

  const cortexBlock = `
# --- Cortex Integration (managed by cortex init) ---
[mcp_servers.cortex]
command = "${BUN_BIN}"
args = ["${MCP_STDIO}"]
enabled = true
tool_timeout_sec = 30

[mcp_servers.cortex.env]
CORTEX_API = "${GATEWAY_URL}"
CORTEX_AGENT_TOKEN_FILE = "${envFile}"
CORTEX_AGENT_ID = "${agentName}"
CORTEX_AGENT_PLATFORM = "codex"
CORTEX_GATEWAY_DB = "${join(CORTEX_DATA, 'gateway.db')}"
CORTEX_CURRENT_TASK_FILE = "${join(CORTEX_DIR, 'run', `${agentName}-current-task`)}"
# --- End Cortex Integration ---
`;

  const startMarker = '# --- Cortex Integration (managed by cortex init) ---';
  const endMarker = '# --- End Cortex Integration ---';

  if (tomlContent.includes(startMarker)) {
    // Replace existing block
    const re = new RegExp(`${startMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${endMarker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    tomlContent = tomlContent.replace(re, cortexBlock.trim());
  } else {
    tomlContent += cortexBlock;
  }
  writeManagedFile(configToml, tomlContent);
  files.push('~/.codex/config.toml');

  return files;
}

function generateOpenClawGates(agentName) {
  const files = [];
  const envFile = join(CORTEX_AGENTS, `${agentName}.env`);
  const openclawDir = join(HOME, '.openclaw');
  ensureDir(openclawDir);

  writeManagedFile(join(openclawDir, 'exec-approvals.json'), JSON.stringify({
    version: 1,
    defaults: { security: 'deny', ask: 'on-miss', askFallback: 'deny' },
    agents: {
      main: {
        security: 'allowlist', ask: 'on-miss', askFallback: 'deny',
        allowlist: [
          { pattern: 'npm test*' }, { pattern: 'npm run*' },
          { pattern: 'node *' }, { pattern: 'bun *' },
          { pattern: 'curl *localhost:4840*' },
          { pattern: 'git diff*' }, { pattern: 'git add*' },
          { pattern: 'git commit*' }, { pattern: 'git status*' },
          { pattern: 'git log*' },
          { pattern: 'ls *' }, { pattern: 'cat *' },
          { pattern: 'find *' }, { pattern: 'grep *' },
        ],
      },
    },
  }, null, 2) + '\n');
  files.push('~/.openclaw/exec-approvals.json');

  const SOUL_MARKER = '<!-- cortex-managed -->';
  mergeMarkdownSection(join(WORKSPACE, 'SOUL.md'), SOUL_MARKER, `${SOUL_MARKER}
## Cortex Integration

You are a gated agent managed by Cortex (localhost:${GATEWAY_PORT}).

### Mandatory Protocol
- You ONLY work on tasks assigned through Cortex
- Before ANY code changes, verify you have a claimed task
- Report progress at least twice per task
- Submit results through the Cortex API
- NEVER produce stub implementations — all code must be functional
- NEVER fake test results or mock API responses without instruction
- NEVER grant permissions to others/everyone
- For numeric chmod, modes MUST end in 0
${MANAGED_END_MARKER}
`);
  files.push('SOUL.md');

  return files;
}

// ---------------------------------------------------------------------------
// Step 6: Shared Config
// ---------------------------------------------------------------------------

function generateSharedConfig(selectedAgents) {
  const agents = {};
  for (const a of selectedAgents) {
    agents[a.name] = { platform: a.platform, enforcement: a.enforcement, registered: true, gated: a.gated };
  }

  mergeJsonFile(CORTEX_CONFIG, (existing) => ({
    ...existing,
    version: '0.1',
    gateway: { host: GATEWAY_HOST, port: GATEWAY_PORT, dbPath: join(CORTEX_DATA, 'gateway.db') },
    workspace: WORKSPACE,
    agents,
  }));

  // --- activate — NO raw tokens. Uses env var references only. ---
  writeManagedFile(join(CORTEX_DIR, 'activate'), `#!/bin/bash
# Generated by cortex init — source before launching agents
# Token loaded from file — never embedded in this script.
export CORTEX_API=${GATEWAY_URL}
export CORTEX_WORKSPACE=${WORKSPACE}

# Load admin token from env file (not embedded)
if [ -f "${join(CORTEX_AGENTS, 'admin.env')}" ]; then
  export CORTEX_ADMIN_TOKEN=\$(grep CORTEX_ADMIN_TOKEN "${join(CORTEX_AGENTS, 'admin.env')}" | cut -d= -f2-)
fi

alias cortex-status='curl -sf ${GATEWAY_URL}/health | jq'
alias cortex-logs='curl -sf ${GATEWAY_URL}/api/gateway/logs -H "X-Cortex-Token: \$CORTEX_ADMIN_TOKEN" | jq'
alias cortex-costs='curl -sf ${GATEWAY_URL}/api/gateway/logs/stats -H "X-Cortex-Token: \$CORTEX_ADMIN_TOKEN" | jq'
alias cortex-tasks='curl -sf ${GATEWAY_URL}/tasks -H "X-Cortex-Token: \$CORTEX_ADMIN_TOKEN" | jq'
`, { mode: 0o700 });
}

// ---------------------------------------------------------------------------
// Step 8: Verify
// ---------------------------------------------------------------------------

async function verify(selectedAgents, tokens) {
  const results = [];

  // Gateway health
  results.push({ check: 'Gateway health', ok: httpHealthy(`${GATEWAY_URL}/health`) });

  // Token auth works
  for (const a of selectedAgents) {
    const token = tokens[a.name];
    if (!token) continue;
    try {
      const res = await fetch(`${GATEWAY_URL}/api/agents/${encodeURIComponent(a.name)}`, {
        headers: { 'X-Cortex-Token': token },
        signal: AbortSignal.timeout(3000),
      });
      results.push({ check: `${a.displayName} token auth`, ok: res.status !== 401 });
    } catch {
      results.push({ check: `${a.displayName} token auth`, ok: false });
    }
  }

  // Task route auth rejection without token
  try {
    const res = await fetch(`${GATEWAY_URL}/api/agents`, {
      signal: AbortSignal.timeout(3000),
    });
    results.push({ check: 'Unauthenticated rejected', ok: res.status === 401 });
  } catch {
    results.push({ check: 'Unauthenticated rejected', ok: false });
  }

  // Gate files
  for (const a of selectedAgents) {
    if (!a.gated) continue;
    switch (a.platform) {
      case 'claude-code':
        results.push({ check: 'Claude Code gates', ok: fileExists(join(WORKSPACE, '.claude', 'hooks', 'cortex-gate.sh')) });
        break;
      case 'codex':
        results.push({ check: 'Codex rules', ok: fileExists(join(HOME, '.codex', 'rules', 'cortex-enforcement.rules')) });
        break;
      case 'openclaw':
        results.push({ check: 'OpenClaw approvals', ok: fileExists(join(HOME, '.openclaw', 'exec-approvals.json')) });
        break;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Step 9: Summary
// ---------------------------------------------------------------------------

function printSummary(selectedAgents, verifyResults) {
  const gated = selectedAgents.filter(a => a.gated).map(a => a.displayName);
  const routeOnly = selectedAgents.filter(a => !a.gated).map(a => a.displayName);

  print();
  print('  ============================================');
  print('   Cortex installed');
  print('  ============================================');
  print();
  if (gated.length) print(`  Gated:       ${gated.join(', ')}`);
  if (routeOnly.length) print(`  Route-only:  ${routeOnly.join(', ')} (telemetry, no enforcement)`);
  print(`  Gateway:     ${GATEWAY_URL}`);
  print(`  Workspace:   ${WORKSPACE}`);
  print();

  for (const r of verifyResults) {
    print(`  ${r.ok ? '[ok]' : '[!!]'} ${r.check}`);
  }

  print();
  print('  Run: source ~/.cortex/activate');
  print();
  print('  Installed features for gated agents:');
  print('    + Traffic routing + telemetry');
  print('    + Task enforcement (claim > progress > submit > verify)');
  print('    + Write blocking without active task');
  print('    + Path enforcement (workspace only)');
  print('    + Stub detection + fake output verification');
  print('    + Basic audit log');
  if (routeOnly.length) {
    print();
    print(`  Route-only agents (${routeOnly.join(', ')}) get telemetry only.`);
  }
  print();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  print();
  print('  Cortex — Agent Setup');
  print('  ====================');

  if (!which('jq')) { print('  Error: jq is required. Install with: apt install jq'); process.exit(1); }
  if (!which('curl')) { print('  Error: curl is required.'); process.exit(1); }
  if (isOptRuntimePath(process.cwd()) && WORKSPACE !== process.cwd()) {
    print(`  Note: using configured workspace ${WORKSPACE}`);
  }

  printHeader('Scanning for agents...');
  const detected = detectAgents();

  const selected = await selectAgents(detected);
  if (selected.length === 0) { print('  No agents selected.'); rl.close(); process.exit(0); }

  printHeader('Starting gateway...');
  setupGateway();

  printHeader('Registering agents...');
  const tokens = {};
  for (const a of selected) {
    tokens[a.name] = registerAgent(a);
    print(`  [ok] ${a.displayName} registered`);
  }
  registerAdmin();
  print('  [ok] Admin registered');

  // Signal gateway to reload the token registry
  const pidFile = join(CORTEX_DIR, 'gateway.pid');
  if (fileExists(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      process.kill(pid, 'SIGHUP');
      print('  [ok] Gateway reloaded token registry');
    } catch {
      print('  [--] Could not signal gateway — restart it to pick up tokens');
    }
  }

  printHeader('Generating gate files...');
  for (const a of selected) {
    let files = [];
    switch (a.platform) {
      case 'claude-code': files = generateClaudeCodeGates(a.name); break;
      case 'codex': files = generateCodexGates(a.name); break;
      case 'openclaw': files = generateOpenClawGates(a.name); break;
      default: print(`  [--] ${a.displayName} — routing only (no gate files)`); continue;
    }
    for (const f of files) print(`  [ok] ${f}`);
  }

  printHeader('Writing shared config...');
  generateSharedConfig(selected);
  print('  [ok] ~/.cortex/config.json');
  print('  [ok] ~/.cortex/activate');

  printHeader('Verifying...');
  const results = await verify(selected, tokens);

  printSummary(selected, results);
  rl.close();
}

if (import.meta.main) {
  main().catch(err => { console.error('cortex init failed:', err); rl.close(); process.exit(1); });
}

export { canonicalAgentForPlatform, detectAgents, mergeMarkdownContent, MANAGED_END_MARKER, resolveWorkspace, isOptRuntimePath, resolveManagedGatewayDir };
