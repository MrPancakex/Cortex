/**
 * @cortex/sdk — shared runtime infrastructure.
 *
 * Composed on top of @cortex/core. The gateway, MCP server, platform
 * backend, and plugins all import from sdk/* barrels. Every sub-module has
 * its own index; this top-level barrel namespaces them so consumers can
 * reach everything via `@cortex/sdk`.
 */
export * as auth from './auth/index.js';
export * as sessions from './sessions/index.js';
export * as db from './db/index.js';
export * as http from './http/index.js';
export * as socket from './socket/index.js';
export * as errors from './errors/index.js';
export * as logging from './logging/index.js';
export * as fs from './fs/index.js';
export * as events from './events/index.js';
