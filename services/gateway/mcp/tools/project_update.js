import { z } from 'zod';
import { gatewayJson } from './_shared.js';

// Contract aligned with the PATCH /v1/api/projects/:id route (project-routes.js
// ProjectUpdateSchema): name, description, default_reviewer (nullable to clear),
// root_path. NOTE: `status` is intentionally NOT exposed — the route does not
// persist a project status field, so advertising it would silently drop the
// value. Project archiving via status is a separate
// feature, deferred past the foundation freeze. root_path is admin-gated on the
// route and not surfaced through this agent tool.
// .strict() so a stale caller passing an unsupported field (notably `status`,
// which the route does NOT persist) is REJECTED with invalid_arguments rather
// than having the field silently stripped and the call reported as a success
// no-op. Project archiving via status is a deferred feature.
export const ProjectUpdateInputSchema = z.object({
  project_id: z.string().min(1),
  default_reviewer: z.string().nullable().optional(),
  // name min(1) mirrors the route's ProjectUpdateSchema — an empty-string name
  // is a no-op masquerading as a clear, so reject it with invalid_arguments
  // rather than letting it through as a silent {} no-op. description carries no
  // min: "" is a deliberate clear and the route persists it.
  name: z.string().min(1).optional(),
  description: z.string().optional(),
}).strict();

export const definition = {
  name: 'project_update',
  protocolVersion: '1.0',
  description: 'Update project name, description, or default reviewer.',
  inputSchema: {
    type: 'object',
    properties: {
      project_id: { type: 'string' },
      default_reviewer: { type: ['string', 'null'] },
      name: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['project_id'],
  },
  schema: ProjectUpdateInputSchema,
  capability: 'project.update',
};

export async function handler(args, gateway) {
  const parsed = definition.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, error: 'invalid_arguments', issues: parsed.error.issues };
  }
  args = parsed.data;
  const body = {};
  // Presence-based (!== undefined), not truthiness: a deliberate `description: ""`
  // is a clear and must be forwarded (the route persists it); an empty `name` is
  // already rejected by the schema's min(1) above, so it can't reach here.
  if (args.name !== undefined) body.name = args.name;
  if (args.description !== undefined) body.description = args.description;
  // Send default_reviewer when present (incl. explicit null to clear it) — it
  // was previously dropped despite being advertised + supported by the route.
  if (args.default_reviewer !== undefined) body.default_reviewer = args.default_reviewer;
  return gatewayJson(gateway, `/v1/api/projects/${encodeURIComponent(args.project_id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
