import { writeFileSync, rmSync, readdirSync, unlinkSync, chmodSync } from 'node:fs';
import { swallow } from '@cortex/sdk/errors';
import { claimSessionSlot, releaseSessionSlot, defaultRunDir } from '@cortex/sdk/sessions';
import {
  DEFAULT_TOKEN_DIR,
  buildImplicitTokenCandidates as buildResolverImplicitTokenCandidates,
  resolveAgentToken,
} from '../../../sdk/auth/token-resolver.js';
import { peelSlotSuffix } from '../../../sdk/auth/slot.js';

/**
 * Scan runDir for claude-<pid>.session files whose PID is no longer alive
 * and remove them. Catches kill -9 / OOM kills from prior sessions.
 * EPERM (PID alive, wrong owner) is treated as live — pointer left alone.
 */
export function sweepDeadPointers(runDir) {
  let files;
  try { files = readdirSync(runDir); }
  catch { return; } // runDir might not exist yet on a cold start

  for (const file of files) {
    if (!file.startsWith('claude-') || !file.endsWith('.session')) continue;
    const pid = Number(file.slice('claude-'.length, -'.session'.length));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 0); // throws if dead
    } catch (err) {
      if (err.code !== 'ESRCH') continue; // EPERM → process exists; leave it
      try { unlinkSync(`${runDir}/${file}`); }
      catch (delErr) {
        process.stderr.write(`[cortex-mcp] WARNING: could not remove stale pointer ${file}: ${delErr.message}\n`);
      }
    }
  }
}

/**
 * Full bootstrap for the stdio MCP entrypoint. Factored out of
 * mcp/stdio.js so the transport file stays ~25 lines and this reusable
 * unit can be exercised by tests or reused by hook-cli session commands.
 *
 * Returns { gateway, cleanup }. Caller is responsible for wiring signal
 * handlers and invoking cleanup at exit.
 */
/**
 * Normalise a configured agent id down to its BASE by peeling one trailing
 * `-<digits>` session-slot segment. A correctly-configured launcher exports
 * the base (`CORTEX_AGENT_ID=nova`) and lets claimSessionSlot derive the
 * slot, so this is a no-op there. But if a launcher exports a session-scoped
 * id literally (`CORTEX_AGENT_ID=nova-2`), using it raw would: (a) make
 * claimSessionSlot mint `nova-2-2`, and (b) make token resolution hunt for a
 * nonexistent `nova-2.env` — yielding no token, so the gate's auth/check
 * fail-safe-denies every write ("nova-2 rejected because of its id"). Peeling
 * here restores a coherent base so slot-claim + token both work.
 * @param {string} id
 * @returns {string}
 */
export function normaliseBaseAgentId(id) {
  return peelSlotSuffix(id);
}

/**
 * Build the ordered implicit token-candidate list for an agent id.
 *
 * Two axes, EXACT-id-before-PEELED-base as the OUTER axis within each dir tier:
 *
 *   Dir-tier precedence (highest first):
 *     1. CORTEX_TOKEN_DIR/<…>.env — operator/test override; only present when
 *        CORTEX_TOKEN_DIR is set to a NON-default value. Documented as a
 *        legacy/operator override, so it MUST win over the canonical vault: an
 *        operator who points CORTEX_TOKEN_DIR at an alternate vault expects it
 *        honoured even when the canonical vault has a matching file.
 *     2. ~/.cortex/keys/<…>.env — canonical operator vault (os.homedir()-derived).
 *     3. /etc/cortex/agents/<…>.env — legacy system vault (last resort).
 *
 *   Within each dir tier: <id>.env (EXACT) then <base>.env (PEELED). A
 *   standalone registered numeric-suffix agent (`nova-2` with its own
 *   `nova-2.env`) resolves its exact keyfile; a session slot (`nova-2` with
 *   no `nova-2.env`, sharing the base token) misses the exact candidate and
 *   falls through to `nova.env`. For a bare base id exact === base, so dedup
 *   collapses each tier to one path — identical to the pre-exact-first chain.
 *
 *   IMPORTANT: pass the RAW agent id here (e.g. `process.env.CORTEX_AGENT_ID`),
 *   NOT the slot-minted `${base}-${n}` identity. The peel is derived internally
 *   via normaliseBaseAgentId, so the exact tier reflects the configured id and
 *   a correctly-configured slot (`CORTEX_AGENT_ID=nova`) never grabs another
 *   process's `nova-<n>.env`.
 *
 * Note: the explicit-token branches (CORTEX_AGENT_TOKEN, CORTEX_TOKEN_FILE /
 * CORTEX_AGENT_TOKEN_FILE) are handled inside resolveAgentToken and take
 * priority over ALL of these — this helper only orders the implicit chain.
 *
 * The override entry is omitted when CORTEX_TOKEN_DIR is unset/default so the
 * normal boot path stays `[canonical, legacy]` (after dedup). Dedup keeps the
 * list clean when entries collapse to the same path.
 *
 * @param {string} agentId  - raw agent id (may carry a session-slot suffix)
 * @param {string} tokenDir - value of CORTEX_TOKEN_DIR (may be default)
 * @returns {string[]}
 */
export function buildImplicitTokenCandidates(agentId, tokenDir) {
  return buildResolverImplicitTokenCandidates(agentId, { CORTEX_TOKEN_DIR: tokenDir });
}

export async function bootstrapHealthAndManifest(gateway, {
  out = process.stderr,
  timeoutMs = 1000,
} = {}) {
  const base = gateway?.config?.gatewayUrl || '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/v1/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      out.write?.(`[cortex-mcp] WARN gateway returned ${res.status}; possible cutover drift; agent will continue\n`);
      return { ok: false, status: res.status };
    }
    const body = await res.json().catch(() => ({}));
    const tools = body?.tools && typeof body.tools === 'object' ? body.tools : null;
    const count = tools ? Object.keys(tools).length : 0;
    if (tools) {
      gateway.config.routes = tools;
      gateway.config.routesSchemaVersion = body.schema_version || null;
    } else {
      out.write?.("[cortex-mcp] WARN health response missing 'tools' field\n");
    }
    out.write?.(`[cortex-mcp] gateway=ok tools=${count} schema=${body?.schema_version || 'unknown'}\n`);
    return { ok: true, count };
  } catch (err) {
    clearTimeout(timer);
    const error = err?.name === 'AbortError' ? 'timeout' : (err?.message || String(err));
    out.write?.(`[cortex-mcp] WARN bootstrap failed: ${error}; agent will continue\n`);
    return { ok: false, error };
  }
}

export async function bootstrapStdioGateway() {
  const GATEWAY_URL      = process.env.CORTEX_API            || 'http://127.0.0.1:4840';
  const BASE_AGENT_ID    = normaliseBaseAgentId(process.env.CORTEX_AGENT_ID || 'unknown');
  const AGENT_PLATFORM   = process.env.CORTEX_AGENT_PLATFORM || BASE_AGENT_ID;
  const CORTEX_TOKEN_DIR = process.env.CORTEX_TOKEN_DIR      || '/etc/cortex/agents';
  const CONFIGURED_TASK_FILE = process.env.CORTEX_CURRENT_TASK_FILE || null;
  const ACTIVE_RUN_DIR   = defaultRunDir();

  // Slot claim — gives us a per-session N so concurrent stdio servers
  // (e.g. nova + nova-2) don't fight over the same pointer.
  const { n: SESSION_N } = claimSessionSlot(ACTIVE_RUN_DIR, BASE_AGENT_ID);
  const AGENT_ID = SESSION_N === 1 ? BASE_AGENT_ID : `${BASE_AGENT_ID}-${SESSION_N}`;

  // Remove pointers from sessions that exited without cleanup (kill -9, OOM).
  sweepDeadPointers(ACTIVE_RUN_DIR);

  // PID→session pointer so the statusline script can discover the session
  // id without env plumbing. Keyed by the parent PID.
  const SESSION_POINTER = `${ACTIVE_RUN_DIR}/claude-${process.ppid}.session`;
  try {
    writeFileSync(SESSION_POINTER, `${AGENT_ID}\n`);
    // 0o640 = owner rw + group r. Group is CORTEX_GROUP (from setgid on the
    // parent dir), which includes the gateway/plugin user.
    // Without group-read, the cortex-channel plugin can't read pointers
    // written by other agent users and the channel attachment handshake fails.
    try { chmodSync(SESSION_POINTER, 0o640); }
    catch (err) { swallow('mcp.stdio_pointer_chmod_failed', err); }
  } catch (err) {
    swallow('mcp.stdio_pointer_write_failed', err);
    process.stderr.write(`[cortex-mcp] WARNING: session pointer write failed: ${err.message}\n`);
  }

  // Token resolution via shared contract (sdk/auth/token-resolver.js).
  // The resolver owns CORTEX_AGENT_TOKEN_FILE and CORTEX_TOKEN_DIR directly.
  let AGENT_TOKEN = null;
  try {
    const resolveEnv = { ...process.env };
    // Pass the RAW configured id (not the peeled BASE_AGENT_ID, and never the
    // slot-minted AGENT_ID): buildImplicitTokenCandidates probes <id>.env first
    // then the peeled <base>.env, so a standalone `nova-2` finds nova-2.env
    // while a session slot falls through to the shared nova.env.
    const RAW_AGENT_ID = process.env.CORTEX_AGENT_ID || BASE_AGENT_ID;
    const candidates = resolveEnv.CORTEX_TOKEN_FILE || resolveEnv.CORTEX_AGENT_TOKEN_FILE
      ? null  // resolver handles explicit-file branch
      : buildImplicitTokenCandidates(RAW_AGENT_ID, CORTEX_TOKEN_DIR);
    AGENT_TOKEN = resolveAgentToken({
      baseAgent: BASE_AGENT_ID,
      env: resolveEnv,
      candidates: candidates ?? undefined,
      swallowFn: (_metric, err) => swallow('mcp.stdio_token_load_failed', err),
    });
  } catch {
    process.stderr.write(`[cortex-mcp] WARNING: no token for ${BASE_AGENT_ID}\n`);
  }

  const CURRENT_TASK_FILE = CONFIGURED_TASK_FILE
    || `${ACTIVE_RUN_DIR}/${AGENT_ID}-current-task`;

  process.stderr.write(`[cortex-mcp] session identity: ${AGENT_ID}\n`);

  let cleanedUp = false;
  function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    try { rmSync(SESSION_POINTER, { force: true }); }
    catch (err) { swallow('mcp.stdio_pointer_cleanup_failed', err); }
    releaseSessionSlot(ACTIVE_RUN_DIR, BASE_AGENT_ID, SESSION_N);
  }

  const gateway = {
    config: {
      agentId:         AGENT_ID,
      agentPlatform:   AGENT_PLATFORM,
      agentToken:      AGENT_TOKEN,
      gatewayUrl:      GATEWAY_URL,
      currentTaskFile: CURRENT_TASK_FILE,
    },
  };

  await bootstrapHealthAndManifest(gateway);

  return { gateway, cleanup };
}
