/**
 * Auth barrel. Hides the internal split between identity, registry, and
 * middleware so callers have a single import surface.
 */
export { loadIdentity, saveIdentity, rotateIdentity } from './identity.js';
export { registerAgent, findAgent, listAgents, revokeAgent } from './registry.js';
export { resolveBaseAgent, sameBaseAgent } from './same-base.js';
export { authMiddleware, requireAdmin, requireAgent } from './middleware.js';
export { verifyToken, signToken } from './verify.js';
export { SHA256_HEX_RE, deriveBearer, hashSecret, sha256Hex, constantTimeEqual } from './crypto.js';
export { TOKEN_LINE_RE, resolveAgentToken } from './token-resolver.js';
export { peelSlotSuffix, tokenFileNames, vaultCandidates } from './slot.js';
export { loadCredentials, saveCredentials, deleteCredential } from './credentials.js';
export { initAuth } from './init.js';
export { generateToken } from './generate-token.js';
export { loadToken } from './load-token.js';
export { loadAdminToken } from './load-admin-token.js';
export { adminIdentity, isAdmin } from './admin.js';
export { getAgentId, mustGetAgentId, getAgentPlatform, agentContext } from './agent-context.js';
export {
  loadTokenRegistryFile,
  resolveTokenRegistryPath,
} from './token-registry-file.js';
