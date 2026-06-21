/**
 * Admin identity helpers. A token with kind='admin' bypasses agent checks
 * but still has to pass verifyToken first.
 */
export function isAdmin(auth) {
  return !!auth && auth.kind === 'admin';
}

export function adminIdentity() {
  return { kind: 'admin', sub: 'root' };
}
