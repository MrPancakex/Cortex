/**
 * Platform CORS wrapper. Re-exports the sdk/http/cors helpers so the
 * platform doesn't maintain its own allow-list logic. The default origins
 * are loopback on the platform port — consumers can override at mount.
 */
import { applyCors, cors as sdkCors } from '@cortex/sdk/http';
import { PLATFORM_PORT } from '@cortex/core/constants';

const DEFAULT_ORIGINS = Object.freeze([
  `http://localhost:${PLATFORM_PORT}`,
  `http://127.0.0.1:${PLATFORM_PORT}`,
]);

export function platformCors(options = {}) {
  const origins = options.origins || DEFAULT_ORIGINS;
  return sdkCors({ ...options, origins });
}

export { applyCors, DEFAULT_ORIGINS };
