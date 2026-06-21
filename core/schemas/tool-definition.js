/**
 * Tool definition. Unified surface used by MCP, HTTP, and the in-process
 * dispatcher. Tools declare their input/output shape plus the permission
 * the caller must hold; the runtime enforces both.
 */
import { z } from 'zod';

export const ToolDefinitionSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9_]+$/, 'lowercase_snake_case'),
    protocolVersion: z.string().default('1'),
    summary: z.string().max(400),
    description: z.string().max(4000).default(''),
    input_schema: z.record(z.unknown()),
    output_schema: z.record(z.unknown()),
    permission: z.enum(['public', 'agent', 'admin']).default('agent'),
    idempotent: z.boolean().default(false),
    timeout_ms: z.number().int().min(100).max(600_000).default(30_000),
    tags: z.array(z.string()).default([]),
  })
  .strict();
