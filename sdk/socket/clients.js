import { globalRegistry } from './registry.js';
import { swallow } from '../errors/index.js';

export function trackClient(agentId, ws) {
  globalRegistry.add(agentId, ws);
  ws.on('close', () => globalRegistry.remove(agentId, ws));
  ws.on('error', (err) => {
    swallow('socket.client_failed', err);
    globalRegistry.remove(agentId, ws);
  });
}

export function untrackClient(agentId, ws) {
  globalRegistry.remove(agentId, ws);
}

export function broadcastToAgent(agentId, payload) {
  const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
  let delivered = 0;
  for (const ws of globalRegistry.forAgent(agentId)) {
    if (ws.readyState !== 1) continue;
    try {
      ws.send(msg);
      delivered += 1;
    } catch (err) {
      swallow('socket.broadcast_failed', err);
    }
  }
  return delivered;
}
