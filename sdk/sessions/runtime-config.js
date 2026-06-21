/**
 * runtime-config.js — agent-scoped active-project file management. Lifted
 * from services/gateway/lib per Rule 1: per-session config file IO fits
 * the sessions domain, and both the project_connect / project_disconnect
 * handlers and (later) the proxy/hook code need these helpers.
 *
 * Four helpers:
 *   - resolveRuntimeDir(gateway) — returns the directory used for agent
 *     state files (current-task, active-project). Falls back to the
 *     parent of the configured currentTaskFile when runtimeDir is unset.
 *   - activeProjectPath(gateway) — resolves the per-agent file path.
 *   - writeActiveProject(gateway, projectId) — creates the file
 *     atomically. Returns the path for inclusion in the HTTP response.
 *   - clearActiveProject(gateway) — removes the file if present.
 *     Idempotent.
 */

import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { mustGetAgentId } from '../auth/index.js';

export function resolveRuntimeDir(gateway) {
  if (gateway?.config?.runtimeDir) return gateway.config.runtimeDir;
  const currentTaskFile = gateway?.config?.currentTaskFile;
  if (currentTaskFile) return path.dirname(currentTaskFile);
  return '/tmp';
}

export function activeProjectPath(gateway) {
  const dir = resolveRuntimeDir(gateway);
  const agentId = mustGetAgentId(gateway);
  return path.join(dir, `${agentId}-active-project`);
}

export async function writeActiveProject(gateway, projectId) {
  const target = activeProjectPath(gateway);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${projectId}\n`, 'utf8');
  return target;
}

export async function clearActiveProject(gateway) {
  const target = activeProjectPath(gateway);
  await rm(target, { force: true });
  return target;
}
