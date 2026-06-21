/**
 * Gateway events barrel — WebSocket stream + HTTP cursor fallback. Wired
 * by the gateway composer so plugin manifests that declare
 * `/v1/api/events/stream` under `requires_endpoints` land on a real
 * handler instead of a 404.
 */
export { mountEventsRoutes } from './routes.js';
