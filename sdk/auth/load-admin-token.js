import { loadToken } from './load-token.js';

export function loadAdminToken({ root } = {}) {
  return process.env.CORTEX_ADMIN_TOKEN || loadToken('admin.token', { root });
}
