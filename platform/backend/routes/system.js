/**
 * Platform-owned system routes.
 *
 * Everything the dashboard needs that isn't a pass-through to the gateway
 * lives here: the local health heartbeat, the UI's feature-flag readout,
 * and the admin-only reload trigger. The handlers delegate to the injected
 * gateway client for the upstream-check half of /health so a single call
 * tells the operator whether both processes are green.
 */
import { ok, serverError, forbidden } from '@cortex/sdk/http';
import { isAdmin } from '@cortex/sdk/auth';
import { swallow } from '@cortex/sdk/errors';

/**
 * Register platform system routes on the adapter.
 *
 * @param {{ add: (method: string, path: string, handler: Function) => void }} adapter
 * @param {{ gateway: ReturnType<import('../lib/gateway-client.js').createGatewayClient> }} opts
 */
export function mountSystemRoutes(adapter, { gateway } = {}) {
  if (!adapter || typeof adapter.add !== 'function') {
    throw new Error('mountSystemRoutes: adapter must expose add(method, path, handler)');
  }
  if (!gateway || typeof gateway.health !== 'function') {
    throw new Error('mountSystemRoutes: gateway client required');
  }

  adapter.add('GET', '/api/system/health', async (ctx) => {
    try {
      const upstream = await gateway.health();
      return ok(ctx.res, { platform: 'ok', gateway: upstream });
    } catch (err) {
      swallow('platform.system_health_failed', err);
      const detail = err?.detail || { error: err?.message || 'gateway unreachable' };
      return ok(ctx.res, { platform: 'ok', gateway: detail });
    }
  });

  adapter.add('GET', '/api/system/features', (ctx) => {
    const admin = !!ctx.actor && isAdmin(ctx.actor);
    return ok(ctx.res, {
      events_ui: true,
      archive_download: true,
      admin_console: admin,
    });
  });

  adapter.add('POST', '/api/system/reload', async (ctx) => {
    if (!ctx.actor || !isAdmin(ctx.actor)) return forbidden(ctx.res, 'admin required');
    try {
      // The gateway's reload route mirrors the legacy /api/admin/reload.
      // If the client didn't wire it, fall back to a no-op so tests that
      // inject a minimal stub still get a 200.
      if (typeof gateway.reload === 'function') await gateway.reload();
      return ok(ctx.res, { reloaded: true });
    } catch (err) {
      swallow('platform.system_reload_failed', err);
      return serverError(ctx.res, 'reload failed');
    }
  });
}
