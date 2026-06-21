/**
 * Plugin manifest. Every plugin on disk ships a `plugin.manifest.json`
 * validated by this schema before the loader touches its code. Unknown
 * fields are rejected so a typo can't silently disable a capability.
 */
import { z } from 'zod';

export const SemverSchema = z
  .string()
  .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/, 'must be semver (MAJOR.MINOR.PATCH)');

export const PluginKindSchema = z.enum(['bot', 'service', 'adapter', 'ui', 'tool']);

export const PluginRuntimeSchema = z.enum(['bun', 'node', 'deno', 'python', 'binary', 'container']);

export const PluginManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    version: SemverSchema,
    kind: PluginKindSchema,
    runtime: PluginRuntimeSchema,
    entry: z.string().min(1),
    api: z.object({
      http_version: z.string().regex(/^v\d+$/),
      mcp_tool_versions: z.record(z.string(), SemverSchema).default({}),
    }),
    subscribes: z.array(z.string().regex(/^[a-z]+(\.[a-z_*]+)+$/)).default([]),
    requires_endpoints: z.array(z.string().regex(/^\//)).default([]),
    exposes: z
      .object({
        health: z.string().optional(),
        push: z.string().optional(),
        endpoints: z
          .array(
            z.object({
              path: z.string().regex(/^\//),
              methods: z.array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])),
              auth: z.enum(['none', 'gateway', 'user']).default('gateway'),
            }),
          )
          .default([]),
        mcp_tools: z.array(z.string()).default([]),
        publishes: z.array(z.string()).default([]),
      })
      .default({}),
    auth: z.object({
      token_file: z.string().optional(),
      identity: z.string().min(1),
      capabilities: z.array(z.string().regex(/^[a-z]+\.[a-z_]+$/)).default([]),
      signed: z.boolean().default(false),
      signature: z.string().optional(),
    }),
    lifecycle: z.object({
      install: z.string().optional(),
      start: z.string(),
      stop: z.string().optional(),
      health: z.string().optional(),
      restart_policy: z.enum(['never', 'on-failure', 'always']).default('on-failure'),
      startup_timeout_ms: z.number().int().positive().default(5000),
      shutdown_signal: z.enum(['SIGTERM', 'SIGINT', 'SIGKILL']).default('SIGTERM'),
      shutdown_timeout_ms: z.number().int().positive().default(3000),
      max_restarts: z.number().int().nonnegative().default(5),
    }),
    metadata: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

/**
 * Phase-11 additions.
 *
 * The Phase-1 `PluginManifestSchema` above stays as the permissive, broadly-
 * accepting schema that the Phase-1 tests and external consumers pin to.
 * Phase 11 layers stricter variants on top:
 *
 *   - StrictPluginManifestSchema: all the same fields, but every sub-object
 *     is `.strict()` so a typo'd exposes.mcp_tools entry is rejected, and
 *     the capabilities regex requires `domain.action` form.
 *   - SignedPluginManifestSchema: the Strict manifest plus a `signature`
 *     envelope the registry verifies against the trust store.
 *   - PluginTrustKeySchema / PluginTrustStoreSchema: the set of signing
 *     keys the registry trusts.
 *
 * These are exported for `services/gateway/plugins/registry.js` and the
 * `plugin_register` MCP tool. The existing schema is not touched so older
 * manifests parse unchanged.
 */

const _StrictApiSchema = z
  .object({
    http_version: z.string().regex(/^v\d+$/),
    mcp_tool_versions: z.record(z.string(), z.string()).default({}),
  })
  .strict();

const _StrictEndpointSchema = z
  .object({
    path: z.string().regex(/^\//),
    methods: z
      .array(z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']))
      .min(1),
    auth: z.enum(['none', 'agent', 'gateway', 'admin', 'user']).default('agent'),
  })
  .strict();

// MCP tool names use snake_case by convention (matches the gateway's
// tool descriptors in services/gateway/mcp/tools/*.js and the codex
// examples in the schema comment below). Hyphens are also accepted for
// plugins that chose a kebab-case identifier scheme.
const MCP_TOOL_NAME_RE = /^[a-z][a-z0-9_-]*$/;

const _StrictMcpToolRefSchema = z
  .object({
    name: z.string().regex(MCP_TOOL_NAME_RE),
    version: SemverSchema.or(z.string().regex(/^\d+\.\d+$/)),
  })
  .strict();

const _StrictExposesSchema = z
  .object({
    health: z.string().optional(),
    push: z.string().optional(),
    endpoints: z.array(_StrictEndpointSchema).default([]),
    // Accept bare tool names OR {name, version} objects so both the channel
    // plugin ("mcp_tools": []) and the codex-reviewer plugin
    // ("mcp_tools": [{"name": "codex_review_list", "version": "1.0"}])
    // parse cleanly.
    mcp_tools: z
      .array(z.union([z.string().regex(MCP_TOOL_NAME_RE), _StrictMcpToolRefSchema]))
      .default([]),
    publishes: z.array(z.string()).default([]),
  })
  .strict();

const _StrictAuthSchema = z
  .object({
    token_file: z.string().optional(),
    identity: z.string().min(1),
    capabilities: z
      .array(z.string().regex(/^[a-z_]+\.[a-z_]+$/))
      .default([]),
    signed: z.boolean().default(false),
  })
  .strict();

const _StrictLifecycleSchema = z
  .object({
    install: z.string().optional(),
    start: z.string().min(1),
    stop: z.string().optional(),
    health: z.string().optional(),
    restart_policy: z
      .enum(['never', 'on-failure', 'always'])
      .default('on-failure'),
    startup_timeout_ms: z.number().int().positive().default(5000),
    shutdown_signal: z
      .enum(['SIGTERM', 'SIGINT', 'SIGKILL'])
      .default('SIGTERM'),
    shutdown_timeout_ms: z.number().int().positive().default(3000),
    max_restarts: z.number().int().nonnegative().default(5),
  })
  .strict();

const _StrictMetadataSchema = z
  .object({
    description: z.string().optional(),
    replaces: z.string().optional(),
    phase: z.number().int().optional(),
    docs: z.string().optional(),
  })
  .passthrough();

export const StrictPluginManifestSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
    version: SemverSchema,
    // Strict accepts the Phase-11 kinds the supervisor recognises.
    kind: z.enum(['adapter', 'reviewer', 'tool', 'runner', 'bot', 'service', 'ui']),
    runtime: PluginRuntimeSchema,
    entry: z.string().min(1),
    api: _StrictApiSchema,
    subscribes: z
      .array(z.string().regex(/^[a-z]+(\.[a-z_*]+)+$/))
      .default([]),
    requires_endpoints: z.array(z.string().regex(/^\//)).default([]),
    exposes: _StrictExposesSchema.default({}),
    auth: _StrictAuthSchema,
    lifecycle: _StrictLifecycleSchema,
    metadata: _StrictMetadataSchema.default({}),
  })
  .strict();

export const PluginTrustKeySchema = z
  .object({
    key_id: z.string().min(1),
    algorithm: z.literal('RSA-SHA256'),
    public_key_pem: z.string().min(1),
    issuer: z.string().optional(),
    valid_from: z.number().int().optional(),
    valid_to: z.number().int().optional(),
  })
  .strict();

export const PluginTrustStoreSchema = z
  .object({
    keys: z.array(PluginTrustKeySchema).default([]),
  })
  .strict();

const _SignatureSchema = z
  .object({
    key_id: z.string().min(1),
    algorithm: z.literal('RSA-SHA256'),
    value: z.string().min(1),
    signed_at: z.number().int().optional(),
  })
  .strict();

export const SignedPluginManifestSchema = StrictPluginManifestSchema.extend({
  signature: _SignatureSchema,
}).strict();
