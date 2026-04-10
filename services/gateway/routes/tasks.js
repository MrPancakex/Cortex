/**
 * /api/tasks — Task CRUD, dispatch, complete, fail
 */
import { getStmts, jsonParse, genId } from '../lib/db.js';

export default function tasksRoutes() {
  return {
    // Get pending tasks for a bot
    getPending(botId) {
      const stmts = getStmts();
      const tasks = stmts.getPendingTasks.all(botId);
      return tasks.map(t => ({ ...t, payload: jsonParse(t.payload, {}) }));
    },

    // Create a task for a bot
    create(botId, projectId, type, payload) {
      const stmts = getStmts();
      const taskId = genId();
      stmts.createTask.run(taskId, botId, projectId || null, type, JSON.stringify(payload || {}), Date.now());
      return taskId;
    },

    // Start a task
    start(taskId) {
      const stmts = getStmts();
      stmts.startTask.run(Date.now(), taskId);
    },

    // Complete a task
    complete(taskId, status, result) {
      const stmts = getStmts();
      stmts.completeTask.run(status || 'completed', JSON.stringify(result || {}), Date.now(), taskId);
    },

    // List tasks by project
    byProject(projectId, limit) {
      const stmts = getStmts();
      const tasks = stmts.listTasksByProject.all(projectId, limit || 50);
      return tasks.map(t => ({ ...t, payload: jsonParse(t.payload, {}) }));
    },
  };
}
