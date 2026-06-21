import { MAX_WS_PER_AGENT } from '@cortex/core/constants';
import { swallow } from '../errors/index.js';

/**
 * Tracks WebSocket clients keyed by agent id. Enforces the per-agent cap
 * by evicting the oldest socket when a new one arrives past the limit.
 */
export class SocketRegistry {
  constructor({ maxPerAgent = MAX_WS_PER_AGENT } = {}) {
    this.maxPerAgent = maxPerAgent;
    this.byAgent = new Map();
  }

  add(agentId, ws) {
    if (!this.byAgent.has(agentId)) this.byAgent.set(agentId, new Set());
    const set = this.byAgent.get(agentId);
    if (set.size >= this.maxPerAgent) {
      const [oldest] = set;
      this.remove(agentId, oldest);
      try {
        oldest.close(1013, 'evicted');
      } catch (err) {
        swallow('socket.evict_failed', err);
      }
    }
    set.add(ws);
  }

  remove(agentId, ws) {
    const set = this.byAgent.get(agentId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.byAgent.delete(agentId);
  }

  forAgent(agentId) {
    return [...(this.byAgent.get(agentId) || [])];
  }

  all() {
    const out = [];
    for (const set of this.byAgent.values()) out.push(...set);
    return out;
  }
}

export const globalRegistry = new SocketRegistry();
