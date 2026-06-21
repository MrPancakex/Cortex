export const SESSION_SLOT_SUFFIX_RE = /-\d+$/;

export function peelSlotSuffix(agentId) {
  if (typeof agentId !== 'string' || agentId.length === 0) return agentId;
  return agentId.replace(SESSION_SLOT_SUFFIX_RE, '') || agentId;
}

export function tokenFileNames(agentId) {
  const peeled = peelSlotSuffix(agentId);
  return peeled === agentId ? [agentId] : [agentId, peeled];
}

export function vaultCandidates(dir, agentId) {
  if (!dir) return [];
  return tokenFileNames(agentId).map((name) => `${dir}/${name}.env`);
}

export function uniqueVaultCandidates(dirs, agentId) {
  return dirs
    .filter(Boolean)
    .flatMap((dir) => vaultCandidates(dir, agentId))
    .filter((candidate, index, all) => all.indexOf(candidate) === index);
}
