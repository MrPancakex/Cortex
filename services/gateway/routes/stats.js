/**
 * /api/stats — Cost summaries, activity, health
 */
import { getStmts, jsonParse } from '../lib/db.js';

export default function statsRoutes() {
  return {
    // Cost summary grouped by project + bot
    costSummary() {
      const stmts = getStmts();
      return stmts.getCostSummary.all();
    },

    // Usage by bot
    usageByBot(botId, limit) {
      const stmts = getStmts();
      const usage = stmts.getUsageByBot.all(botId, limit || 100);
      return usage.map(u => ({ ...u, meta: jsonParse(u.meta, {}) }));
    },

    // Usage by project
    usageByProject(projectId, limit) {
      const stmts = getStmts();
      const usage = stmts.getUsageByProject.all(projectId, limit || 100);
      return usage.map(u => ({ ...u, meta: jsonParse(u.meta, {}) }));
    },
  };
}
