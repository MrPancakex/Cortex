import path from 'node:path';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';

export async function syncCurrentTaskFile(gateway, taskId) {
  const taskFile = gateway.config.currentTaskFile;
  if (!taskFile) return { ok: false, skipped: true };
  const dir = path.dirname(taskFile);
  await mkdir(dir, { recursive: true });
  await writeFile(taskFile, `${taskId}\n`, 'utf8');
  return { ok: true, path: taskFile };
}

export async function clearCurrentTaskFile(gateway, expectedTaskId = null) {
  const taskFile = gateway.config.currentTaskFile;
  if (!taskFile) return { ok: false, skipped: true };
  if (expectedTaskId) {
    try {
      const currentTaskId = (await readFile(taskFile, 'utf8')).trim();
      if (currentTaskId && currentTaskId !== expectedTaskId) {
        return { ok: false, skipped: true, current_task_id: currentTaskId };
      }
    } catch (err) {
      if (err?.code === 'ENOENT') return { ok: false, skipped: true, missing: true };
      throw err;
    }
  }
  await rm(taskFile, { force: true });
  return { ok: true, path: taskFile, cleared: true };
}

export async function persistTaskState(gateway, response, action, taskId = null) {
  try {
    const localState = action === 'clear'
      ? await clearCurrentTaskFile(gateway, taskId)
      : await syncCurrentTaskFile(gateway, taskId);
    if (localState.ok) {
      response.local_state = {
        ...(response.local_state || {}),
        current_task_file: localState.path,
        action,
      };
    }
  } catch (err) {
    response.warning = `${response.warning ? `${response.warning}; ` : ''}failed to ${action} local current-task file: ${err.message}`;
  }
  return response;
}
