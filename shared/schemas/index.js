// Barrel export for Cortex shared schemas. Consumed by:
//   - services/gateway/mcp/tools.js (inputSchema derivation via zod-to-json-schema)
//   - services/gateway/mcp/tool-handlers.js (schema.parse at handler entry)
//   - services/gateway/routes/cortex-tasks.js (parseBody HTTP validation)
//   - platform/frontend (typed hooks, via z.infer)
export * from './bridge.js';
export * from './task.js';
export * from './progress.js';
export * from './agent.js';
