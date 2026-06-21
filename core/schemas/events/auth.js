/**
 * auth.* event payload schemas. Scope grant lifecycle events.
 */
import { z } from 'zod';
import { AgentIdSchema } from '../_primitives.js';

const GrantIdSchema = z.string().uuid();

export const AuthScopeGrantedSchema = z.object({
  grant_id: GrantIdSchema,
  agent: AgentIdSchema,
  target_scope: z.string().min(1),
  granted_by: z.string().min(1),
  granted_at: z.number().int().nonnegative(),
});

export const AuthScopeRevokedSchema = z.object({
  grant_id: GrantIdSchema,
  agent: AgentIdSchema,
  reason: z.string().min(1).optional(),
  revoked_at: z.number().int().nonnegative(),
});

export const AuthScopeExpiredSchema = z.object({
  grant_id: GrantIdSchema,
  agent: AgentIdSchema,
  expired_at: z.number().int().nonnegative(),
});

export const AuthEventPayloadMap = {
  'auth.scope_granted': AuthScopeGrantedSchema,
  'auth.scope_revoked': AuthScopeRevokedSchema,
  'auth.scope_expired': AuthScopeExpiredSchema,
};
