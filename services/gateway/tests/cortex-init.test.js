import { describe, expect, it } from 'bun:test';
import { canonicalAgentForPlatform, mergeMarkdownContent, MANAGED_END_MARKER, resolveWorkspace, isOptRuntimePath, resolveManagedGatewayDir } from '../bin/cortex-init.js';

describe('cortex init alignment', () => {
  it('maps detected runtimes to canonical Cortex agent identities', () => {
    expect(canonicalAgentForPlatform('claude-code', '~/.claude')).toMatchObject({
      name: 'atlas',
      displayName: 'Atlas',
      platform: 'claude-code',
      gated: true,
    });

    expect(canonicalAgentForPlatform('codex', '~/.codex')).toMatchObject({
      name: 'zeus',
      displayName: 'Zeus',
      platform: 'codex',
      gated: true,
    });

    expect(canonicalAgentForPlatform('openclaw', ':18789')).toMatchObject({
      name: 'gerald',
      displayName: 'Gerald',
      platform: 'openclaw',
      gated: true,
    });
  });

  it('replaces the full managed markdown block and removes stale duplicate protocol text', () => {
    const marker = '<!-- cortex-managed -->';
    const existing = `${marker}
## Cortex Agent Configuration
Old managed block

## Cortex Agent Configuration
Stale duplicated block
`;
    const replacement = `${marker}
## Cortex Agent Configuration
New managed block
${MANAGED_END_MARKER}
`;

    const merged = mergeMarkdownContent(existing, marker, replacement);
    expect(merged).toContain('New managed block');
    expect(merged).toContain(MANAGED_END_MARKER);
    expect(merged).not.toContain('Old managed block');
    expect(merged).not.toContain('Stale duplicated block');
  });

  it('treats /opt/cortex as runtime and prefers configured user workspace', () => {
    expect(isOptRuntimePath('/opt/cortex/current')).toBe(true);
    expect(isOptRuntimePath('/home/testuser/CortexHub/cortex-v01')).toBe(false);

    const previous = process.env.CORTEX_WORKSPACE;
    process.env.CORTEX_WORKSPACE = '/home/testuser/CortexHub/cortex-v01';
    try {
      expect(resolveWorkspace('/opt/cortex/current')).toBe('/home/testuser/CortexHub/cortex-v01');
    } finally {
      if (previous === undefined) delete process.env.CORTEX_WORKSPACE;
      else process.env.CORTEX_WORKSPACE = previous;
    }
  });

  it('uses /opt/cortex/current for managed gateway paths instead of pinning a dated release', () => {
    expect(resolveManagedGatewayDir('/opt/cortex/releases/20260325-221314/services/gateway/bin'))
      .toBe('/opt/cortex/current/services/gateway');
    expect(resolveManagedGatewayDir('/opt/cortex/current/services/gateway/bin'))
      .toBe('/opt/cortex/current/services/gateway');
    expect(resolveManagedGatewayDir('/home/testuser/CortexHub/cortex-v01/services/gateway/bin'))
      .toBe('/home/testuser/CortexHub/cortex-v01/services/gateway');
  });
});
