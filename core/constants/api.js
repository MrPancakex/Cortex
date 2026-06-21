/**
 * API contract versioning. Every HTTP response from the gateway carries
 * `__schema_version` equal to this value so consumers can detect field-name
 * drift at the boundary rather than silently serving stale shapes.
 *
 * Bump this string whenever a breaking field rename or removal lands in the
 * response serializers (serialize.js / project-routes.js / phase-routes.js /
 * sessions/routes.js / bridge/handlers.js).
 *
 * The frontend's `assertSchemaVersion` helper warns in the console when the
 * received version doesn't match — no throw, soft-fail only.
 *
 * Mirror: shared/constants.js exports the same value for the frontend build
 * which cannot resolve workspace packages. Keep both in sync when bumping.
 */

export const API_SCHEMA_VERSION = 'v0.2';
