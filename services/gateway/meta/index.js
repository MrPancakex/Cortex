/**
 * Gateway meta barrel — health, stats, and gateway-wide logs. Single
 * public surface imported by the gateway composer at boot.
 */
export { mountMetaRoutes, createRestartHandler } from './routes.js';
