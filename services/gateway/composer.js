/**
 * Public gateway composer — the lean carve's entrypoint.
 *
 * Mounts ONLY the kept planes (meta, events, sessions, tasks/projects/phases,
 * gate, auth) + boot side effects + the reconciler. It does NOT mount the cut
 * planes (bridge, subagents, router, proxy, providers, plugins) and serves only
 * PUBLIC_TOOL_REGISTRY over MCP.
 *
 * Derived from composer.js. The ledger self-check helpers are copied verbatim
 * (they have no cut-plane imports). The export pipeline (Plan E) renames this
 * file to composer.js in the staged tree.
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolveProjectsRoot } from '@cortex/core/constants';
import { swallow } from '@cortex/sdk/errors';
import { loadTokenRegistryFile } from '@cortex/sdk/auth';
import { getDb } from '@cortex/sdk/db';
import { bootGateway } from './boot.js';
import { reloadGatewayRuntimeState } from './runtime-reload.js';
import { mountSessionRoutes, startReaper } from './sessions/index.js';
import {
  mountTaskRoutes,
  mountProjectRoutes,
  mountPhaseRoutes,
  startTaskOrphanSubscriber,
} from './tasks/index.js';
import {
  mountGateRoutes,
  refreshPolicies,
  writeRegistrySnapshot,
  resolveSubject,
} from './gate/index.js';
import { mountAuthRoutes, mountGrantRoutes, startGrantReaper } from './auth/index.js';
import { mountMetaRoutes } from './meta/routes.js';
import { mountEventsRoutes } from './events/index.js';
import { createMCPHandler } from './mcp/handler.js';
import { PUBLIC_TOOL_REGISTRY } from './mcp/tools/_registry.js';
import { scanAll, bootRebuild, isTaskPlaneEmpty } from './tasks/reconciler.js';
import { startSummaryWriter } from './lib/summary-writer.js';

const MCP_PATHS = new Set(['/mcp', '/mcp/message']);
export function isMCPRoute(pathname) {
  return MCP_PATHS.has(pathname);
}

// -- Ledger append-only self-check (copied verbatim from composer.js) --------

export function lsattrHasAppendOnly(out) {
  const attrs = (String(out).trim().split(/\s+/)[0]) || '';
  return attrs.includes('a');
}

export function resolveLedgerProjectsDir(projectsDir) {
  return projectsDir || resolveProjectsRoot();
}

export function checkLedgerAppendOnlyAttributes(projectsDir) {
  const dir = resolveLedgerProjectsDir(projectsDir);
  if (!dir) return;
  let files;
  try {
    files = findJsonlFiles(dir);
  } catch (err) {
    swallow('gateway.ledger_scan_failed', err);
    return;
  }
  if (files.length === 0) return;
  let lsattrAvailable = true;
  for (const file of files) {
    if (!lsattrAvailable) break;
    try {
      const out = execFileSync('lsattr', [file], { encoding: 'utf8', timeout: 2000 });
      if (!lsattrHasAppendOnly(out)) {
        process.stderr.write(
          `[gate.f07] WARN: ledger file missing append-only (+a) attribute: ${file}\n` +
          `  Fix: sudo chattr +a "${file}"\n`,
        );
      }
    } catch (err) {
      if (err.code === 'ENOENT' || String(err.message).includes('not found')) {
        lsattrAvailable = false;
        process.stderr.write(
          '[gate.f07] WARN: lsattr not found — cannot verify ledger append-only attributes.\n' +
          '  Ensure chattr +a is set on all ledger.jsonl and reviews.jsonl files.\n' +
          '  See operator runbook §Ledger-append-only.\n',
        );
      } else {
        swallow('gateway.ledger_lsattr_failed', err);
      }
    }
  }
}

function findJsonlFiles(dir) {
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      results.push(...findJsonlFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Mount the kept core route planes in production order. Shared with
 * route-manifest-integrity.public.test.js so the public manifest test mirrors
 * the public composer's EXACT mount set. NO bridge/subagents/router/providers/
 * plugins mounts — those planes are cut.
 * @param {{ add: Function }} adapter
 */
export function mountPublicCoreRoutes(adapter) {
  mountMetaRoutes(adapter);
  mountEventsRoutes(adapter);
  mountSessionRoutes(adapter);
  mountTaskRoutes(adapter);
  mountProjectRoutes(adapter);
  mountPhaseRoutes(adapter);
  mountGateRoutes(adapter);
  mountAuthRoutes(adapter);
  mountGrantRoutes(adapter);
}

/**
 * Compose the lean (kept-planes-only) gateway onto the caller's HTTP adapter
 * and run the boot side effects.
 *
 * @param {{ add: (method: string, path: string, handler: Function) => void }} adapter
 * @param {object} [opts]  — same flag shape as composeGateway for the kept
 *   side effects (reaper / grantReaper / summaryWriter / reconcileOnBoot /
 *   checkLedgerAttributes / installProcessHandlers / drainRecovery / mcp /
 *   authRegistry / hydratePolicies). Cut-plane opts (plugins / proxy / bridge /
 *   subagentReaper / hydrateRules) are ignored — those planes do not exist here.
 * @returns {Promise<object>} boot result + reaperHandle/mcpHandler/etc.
 */
export async function composePublicGateway(adapter, opts = {}) {
  if (!adapter || typeof adapter.add !== 'function') {
    throw new Error('composePublicGateway: adapter must expose add(method, path, handler)');
  }

  // Mount kept planes first (synchronous) so any recovery-drain emit has a
  // destination handler. No plugin/proxy plane in the lean carve.
  mountPublicCoreRoutes(adapter);

  // MCP plane — built from PUBLIC_TOOL_REGISTRY (kept tools only). Same handler
  // factory as production; only the served tool set differs.
  let mcpHandler = null;
  if (opts.mcp !== false) {
    const gatewayUrl = opts.mcp?.gatewayUrl
      || process.env.CORTEX_API
      || 'http://127.0.0.1:4840';
    const mcpGateway = {
      config: { gatewayUrl },
      db: getDb(),
      toolRegistry: PUBLIC_TOOL_REGISTRY,
    };
    const identifyAgent = opts.mcp?.identifyAgent || ((req) => {
      try {
        const subject = resolveSubject({ headers: req.headers });
        return subject && subject.kind !== 'anon' ? (subject.base || subject.id) : null;
      } catch (err) {
        swallow('gateway.mcp_identify_failed', err);
        return null;
      }
    });
    mcpHandler = createMCPHandler(mcpGateway, { identifyAgent });
  }

  // Orphan subscriber — closes the sessions→tasks loop (dead sessions flip
  // their tasks to orphaned). Wired before the reaper to avoid a start race.
  let orphanSubscriberHandle = null;
  if (opts.orphanSubscriber !== false) {
    orphanSubscriberHandle = startTaskOrphanSubscriber();
  }

  // Session reaper — timed sweep + event subscriber for stale sessions.
  let reaperHandle = null;
  if (opts.reaper !== false) {
    reaperHandle = startReaper({
      intervalMs: opts.reaper?.intervalMs,
      runDir: opts.reaper?.runDir,
    });
  }

  // Grant reaper — 30s sweep for expired scope grants.
  let grantReaperHandle = null;
  if (opts.grantReaper !== false) {
    try {
      grantReaperHandle = startGrantReaper({ intervalMs: opts.grantReaper?.intervalMs });
    } catch (err) {
      swallow('gateway.grant_reaper_start_failed', err);
    }
  }

  // Summary writer — subscribes to task.submitted and writes summary.md.
  let summaryWriterHandle = null;
  if (opts.summaryWriter !== false) {
    try {
      summaryWriterHandle = startSummaryWriter();
    } catch (err) {
      swallow('gateway.summary_writer_start_failed', err);
    }
  }

  // Cold-boot registry + policy hydration (gate plane). No router rule
  // hydration — the router plane is cut.
  let registryHydration = { agents: 0, error: null };
  if (opts.authRegistry !== false) {
    try {
      const registry = opts.authRegistry?.snapshot
        ?? loadTokenRegistryFile({ path: opts.authRegistry?.path });
      writeRegistrySnapshot(registry);
      registryHydration = {
        agents: Object.keys(registry.agents || {}).length,
        error: null,
      };
    } catch (err) {
      swallow('gateway.boot_registry_hydrate_failed', err);
      registryHydration = { agents: 0, error: err.message };
    }
  }

  let policyHydration = { count: 0, version: null, error: null };
  if (opts.hydratePolicies !== false) {
    try {
      const version = refreshPolicies();
      policyHydration = { count: null, version, error: null };
    } catch (err) {
      swallow('gateway.boot_policy_hydrate_failed', err);
      policyHydration = { count: 0, version: null, error: err.message };
    }
  }

  // Boot side effects (idempotent). SIGHUP reload uses the public reload.
  const boot = await bootGateway({
    installProcessHandlers: opts.installProcessHandlers,
    drainRecovery: opts.drainRecovery,
    onSighup: () => reloadGatewayRuntimeState({
      authRegistry: opts.authRegistry,
      matrixPath: opts.matrixPath,
    }),
  });
  const recovery = boot.recovery || { drained: 0, kept: 0 };

  // Boot rebuild (gated by CORTEX_BOOT_REBUILD=1; only over an empty plane).
  let rebuildRan = false;
  if (process.env.CORTEX_BOOT_REBUILD === '1') {
    const empty = isTaskPlaneEmpty();
    if (empty) {
      rebuildRan = true;
      const projectsRoot = resolveProjectsRoot();
      try {
        const rebuildReport = await bootRebuild(projectsRoot);
        console.log(
          `[boot-rebuild] projects_added=${rebuildReport.projects_added}` +
          ` phases_added=${rebuildReport.phases_added}` +
          ` tasks_added=${rebuildReport.tasks_added}` +
          ` audit_added=${rebuildReport.audit_added}` +
          ` hard_errors=${rebuildReport.hard_errors.length}`,
        );
        if (rebuildReport.hard_errors.length > 0) {
          console.warn('[boot-rebuild] hard errors:', JSON.stringify(rebuildReport.hard_errors));
        }
      } catch (err) {
        swallow('boot_rebuild.failed', err);
        console.warn('[boot-rebuild] FAILED:', err.message);
      }
    } else {
      console.log('[boot-rebuild] task plane not empty — skipping rebuild');
    }
  }

  // Filesystem ledger reconciliation — background after boot. Skipped when the
  // flag-gated rebuild path ran (bootRebuild IS the reconcile for that boot).
  if (opts.reconcileOnBoot !== false && !rebuildRan) {
    setImmediate(() => {
      scanAll({ dryRun: false })
        .then((diff) => {
          const t = diff.totals;
          console.log(
            `[reconciler] boot scan: added=${t.added} updated=${t.updated}` +
            ` removed=${t.removed} projects=${t.projects_scanned}` +
            ` parity_failures=${t.parity_failures}`,
          );
        })
        .catch((err) => swallow('reconciler.boot_scan_failed', err));
    });
  }

  // Startup self-check — warn on ledger files missing chattr +a.
  if (opts.checkLedgerAttributes !== false) {
    setImmediate(() => {
      try {
        checkLedgerAppendOnlyAttributes();
      } catch (err) {
        swallow('gateway.ledger_attr_check_failed', err);
      }
    });
  }

  return {
    ...boot,
    recovery,
    pluginPlane: null,
    reaperHandle,
    grantReaperHandle,
    orphanSubscriberHandle,
    summaryWriterHandle,
    mcpHandler,
    registryHydration,
    policyHydration,
  };
}
