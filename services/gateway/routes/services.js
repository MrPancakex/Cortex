/**
 * /api/services — Service event logging + listing
 */
import { getStmts, jsonParse } from '../lib/db.js';

export default function serviceRoutes() {
  return {
    // Log a service event
    log(service, event, payload) {
      const stmts = getStmts();
      stmts.logEvent.run(service, event, JSON.stringify(payload || {}), Date.now());
    },

    // List recent events (all services)
    list(limit) {
      const stmts = getStmts();
      const events = stmts.listEvents.all(limit || 100);
      return events.map(e => ({ ...e, payload: jsonParse(e.payload, {}) }));
    },

    // List events for a specific service
    byService(service, limit) {
      const stmts = getStmts();
      const events = stmts.listEventsByService.all(service, limit || 100);
      return events.map(e => ({ ...e, payload: jsonParse(e.payload, {}) }));
    },
  };
}
