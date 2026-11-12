import { describe, expect, it } from 'vitest';

import {
  buildSessionManifest,
  compareSessionManifests,
  frontmatterLine,
  groupSessionManifest,
  parseSessionManifest,
  reproduceSessionManifest,
  serializeSessionManifest,
  sessionManifestFingerprint,
  sessionManifestKindSummary,
  toSessionLaunchRecipe,
  type SessionManifestInput,
} from '../session-manifest';

const EXPERT_MD = `---
name: Code Reviewer
agent: hermes
model: local-small
tools:
  - read_file
  - search_notes
skills:
  - review-checklist
toolsets:
  - filesystem
---
You review diffs.
`;

function input(overrides: Partial<SessionManifestInput> = {}): SessionManifestInput {
  return {
    session: {
      id: 'session-1',
      agentKind: 'hermes',
      model: 'qwen3-8b',
      providerId: 'lmstudio-local',
      permissionMode: 'default',
    },
    expert: {
      slug: 'code-reviewer',
      name: 'Code Reviewer',
      dir: '/experts/code-reviewer',
      model: 'local-small',
      tools: ['read_file', 'search_notes'],
      toolsets: ['filesystem'],
      skills: ['review-checklist'],
      skillFiles: ['/experts/code-reviewer/skills/review-checklist/SKILL.md'],
      markdown: EXPERT_MD,
    },
    skills: [
      { id: 'research/vault-notes', name: 'Vault Notes', enabled: true },
      { id: 'disabled/one', enabled: false },
    ],
    mcpServers: [
      { id: 'hermes/cindy_vault_notes', name: 'cindy_vault_notes', source: 'hermes', transport: 'stdio', enabled: true },
      { id: 'lizi/off', name: 'off', source: 'lizi', enabled: false },
    ],
    providers: [
      { id: 'lmstudio-local', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234', local: true },
      { id: 'remote-paid', kind: 'openai-compatible', baseUrl: 'https://example.test', local: false },
    ],
    routing: {
      routes: { 'local-small': { provider: 'lmstudio-local', model: 'qwen3-8b' } },
      rules: { 'chat.default': 'local-small' },
    },
    pinnedNotes: ['memory/Project - Cindy.md'],
    vaultDir: '/vault',
    ...overrides,
  };
}

function kinds(manifest: ReturnType<typeof buildSessionManifest>): string[] {
  return [...new Set(manifest.capabilities.map((row) => row.kind))].sort();
}

function find(manifest: ReturnType<typeof buildSessionManifest>, id: string) {
  return manifest.capabilities.find((row) => row.id === id);
}

describe('buildSessionManifest', () => {
  it('declares all seven capability groups for a bound expert', () => {
    const manifest = buildSessionManifest(input());
    expect(kinds(manifest)).toEqual([
      'connector',
      'expert',
      'model-route',
      'permission',
      'pinned-note',
      'skill',
      'tool',
    ]);
    expect(manifest.version).toBe(1);
    expect(manifest.session.providerId).toBe('lmstudio-local');
  });

  it('adds an adr group only when past decisions matched the first prompt (ROADMAP 11.8)', () => {
    const manifest = buildSessionManifest(
      input({
        relevantAdrs: [
          { title: 'Use SQLite', path: 'docs/decisions/0001-use-sqlite.md', source: 'repo', status: 'Accepted' },
          { title: 'Gateway per session', path: 'Cindy/Decisions/2026-11-01-gateway.md', source: 'vault' },
        ],
        adrWorkspaceDir: '/repo',
      }),
    );
    expect(kinds(manifest)).toContain('adr');
    expect(find(manifest, 'adr:repo:docs/decisions/0001-use-sqlite.md')).toMatchObject({
      label: 'Use SQLite',
      file: '/repo/docs/decisions/0001-use-sqlite.md',
      declaredInterface: 'ADR (Accepted)',
      trust: 'local-file',
    });
    expect(find(manifest, 'adr:vault:Cindy/Decisions/2026-11-01-gateway.md')?.file).toBe(
      '/vault/Cindy/Decisions/2026-11-01-gateway.md',
    );
    expect(kinds(buildSessionManifest(input()))).not.toContain('adr');
  });

  it('is deterministic and sorted by kind then id', () => {
    const first = buildSessionManifest(input());
    const second = buildSessionManifest(input());
    expect(first).toEqual(second);
    const ids = first.capabilities.map((row) => `${row.kind}:${row.id}`);
    expect(ids).toEqual([...ids].sort());
  });

  it('points every capability at a real local file and a reason', () => {
    const manifest = buildSessionManifest(input());
    for (const row of manifest.capabilities) {
      expect(row.file.length).toBeGreaterThan(0);
      expect(row.reason.length).toBeGreaterThan(0);
      expect(row.declaredInterface.length).toBeGreaterThan(0);
    }
    expect(find(manifest, 'expert:code-reviewer')?.file).toBe('/experts/code-reviewer/expert.md');
    expect(find(manifest, 'pinned-note:memory/Project - Cindy.md')?.file).toBe(
      '/vault/memory/Project - Cindy.md',
    );
  });

  it('uses real frontmatter line numbers from expert.md', () => {
    expect(frontmatterLine(EXPERT_MD, 'name')).toBe(2);
    expect(frontmatterLine(EXPERT_MD, 'tools')).toBe(5);
    expect(frontmatterLine(EXPERT_MD, 'nope')).toBeUndefined();
    expect(frontmatterLine(undefined, 'name')).toBeUndefined();
    const manifest = buildSessionManifest(input());
    expect(find(manifest, 'expert:code-reviewer')?.line).toBe(2);
    expect(find(manifest, 'tool:read_file')?.line).toBe(5);
    expect(find(manifest, 'skill:review-checklist')?.line).toBe(8);
    expect(find(manifest, 'tool:toolset:filesystem')?.line).toBe(10);
  });

  it('resolves skill files from the expert declaration', () => {
    const manifest = buildSessionManifest(input());
    expect(find(manifest, 'skill:review-checklist')?.file).toBe(
      '/experts/code-reviewer/skills/review-checklist/SKILL.md',
    );
    expect(find(manifest, 'skill:research/vault-notes')).toBeUndefined();
  });

  it('falls back to enabled skills when no expert is bound', () => {
    const manifest = buildSessionManifest(input({ expert: null }));
    expect(find(manifest, 'skill:research/vault-notes')?.file).toBe(
      '~/.hermes-cindy/skills/research/vault-notes/SKILL.md',
    );
    expect(find(manifest, 'skill:disabled/one')).toBeUndefined();
    expect(find(manifest, 'expert:code-reviewer')).toBeUndefined();
  });

  it('skips disabled MCP servers and declares enabled ones as tools', () => {
    const manifest = buildSessionManifest(input());
    expect(find(manifest, 'tool:mcp:hermes/cindy_vault_notes')?.file).toBe(
      '~/.hermes-cindy/config.yaml',
    );
    expect(find(manifest, 'tool:mcp:lizi/off')).toBeUndefined();
  });

  it('includes the route provider and local candidates, never an unused remote endpoint', () => {
    const manifest = buildSessionManifest(input());
    expect(find(manifest, 'connector:lmstudio-local')?.reason).toContain('active model route');
    expect(find(manifest, 'connector:remote-paid')).toBeUndefined();
    const withRemoteSelected = buildSessionManifest(
      input({ session: { ...input().session, providerId: 'remote-paid' } }),
    );
    expect(find(withRemoteSelected, 'connector:remote-paid')?.trust).toBe('remote');
  });

  it('declares the session model, expert route, default route and permission', () => {
    const manifest = buildSessionManifest(input());
    expect(find(manifest, 'model-route:session-model')?.locator).toContain('routes.local-small');
    expect(find(manifest, 'model-route:expert:code-reviewer')?.line).toBe(4);
    expect(find(manifest, 'model-route:default:local-small')?.value).toBe(
      'lmstudio-local/qwen3-8b',
    );
    expect(find(manifest, 'permission:default')?.file).toContain('SQLite');
  });

  it('marks a missing model as disabled instead of inventing a fallback', () => {
    const manifest = buildSessionManifest(
      input({ session: { ...input().session, model: '' } }),
    );
    expect(find(manifest, 'model-route:session-model')?.enabled).toBe(false);
    expect(find(manifest, 'model-route:session-model')?.value).toBe('');
  });

  it('accepts a brand new kind with no central edit', () => {
    const custom = buildSessionManifest(input());
    custom.capabilities.push({
      kind: 'quantum-widget',
      id: 'quantum-widget:one',
      label: 'One',
      value: 'one',
      enabled: true,
      file: '/widgets/one.yaml',
      reason: 'Declared in a local file',
      trust: 'local-file',
      declaredInterface: 'widget.yaml',
    });
    expect(groupSessionManifest(custom).map((group) => group.kind)).toContain('quantum-widget');
    expect(parseSessionManifest(serializeSessionManifest(custom)).ok).toBe(true);
  });
});

describe('session manifest YAML', () => {
  it('round-trips with quotes, colons, hashes, unicode and newlines', () => {
    const original = buildSessionManifest(
      input({
        pinnedNotes: ['memory/Weird: "note" #1.md', 'memory/日本語\nline.md'],
        expert: { ...input().expert!, name: 'Reviewer: "senior" #1' },
      }),
    );
    const yaml = serializeSessionManifest(original);
    const parsed = parseSessionManifest(yaml);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.manifest).toEqual(original);
  });

  it('emits the expected file-backed shape', () => {
    const yaml = serializeSessionManifest(buildSessionManifest(input()));
    expect(yaml).toContain('# Cindy session manifest');
    expect(yaml).toContain('version: 1');
    expect(yaml).toContain('  - kind: "expert"');
    expect(yaml).toContain('    file: "/experts/code-reviewer/expert.md"');
    expect(yaml).toContain('    line: 2');
    expect(yaml).toContain('    reason: ');
  });

  it('rejects a wrong version and malformed rows', () => {
    const yaml = serializeSessionManifest(buildSessionManifest(input()));
    expect(parseSessionManifest(yaml.replace('version: 1', 'version: 2')).ok).toBe(false);
    expect(parseSessionManifest('version: 1\nsession:\n  id: "x"\ncapabilities:\n')).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(parseSessionManifest('version: 1\nnot-a-key: 3\n')).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(parseSessionManifest(yaml.replace('trust: "local-file"', 'trust: "cloud"')).ok).toBe(
      false,
    );
    expect(parseSessionManifest(yaml.replace('enabled: true', 'enabled: "yes"')).ok).toBe(false);
  });

  it('rejects duplicate capability ids', () => {
    const manifest = buildSessionManifest(input());
    manifest.capabilities.push({ ...manifest.capabilities[0] });
    const result = parseSessionManifest(serializeSessionManifest(manifest));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('duplicate');
  });

  it('is stable across serialise and parse', () => {
    const manifest = buildSessionManifest(input());
    const once = serializeSessionManifest(manifest);
    const parsed = parseSessionManifest(once);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(serializeSessionManifest(parsed.manifest)).toBe(once);
  });
});

describe('reproduce and compare', () => {
  it('reproduces the same capability set into a fresh session id', () => {
    const manifest = buildSessionManifest(input());
    const fresh = reproduceSessionManifest(manifest, 'fresh-session-2');
    expect(fresh.session.id).toBe('fresh-session-2');
    expect(compareSessionManifests(manifest, fresh).same).toBe(true);
    expect(sessionManifestFingerprint(manifest)).toBe(sessionManifestFingerprint(fresh));
    expect(fresh.capabilities).not.toBe(manifest.capabilities);
  });

  it('a parsed YAML reproduces the same capability set', () => {
    const original = buildSessionManifest(input());
    const parsed = parseSessionManifest(serializeSessionManifest(original));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fresh = reproduceSessionManifest(parsed.manifest, 'fresh-session-3');
    expect(compareSessionManifests(original, fresh).same).toBe(true);
  });

  it('reports added and removed capabilities', () => {
    const a = buildSessionManifest(input());
    const b = buildSessionManifest(input({ pinnedNotes: [] }));
    const comparison = compareSessionManifests(a, b);
    expect(comparison.same).toBe(false);
    expect(comparison.removed).toEqual(['pinned-note:memory/Project - Cindy.md']);
    expect(comparison.added).toEqual([]);
  });

  it('builds a launch recipe from the manifest', () => {
    const recipe = toSessionLaunchRecipe(buildSessionManifest(input()));
    expect(recipe.expertSlug).toBe('code-reviewer');
    expect(recipe.model).toBe('qwen3-8b');
    expect(recipe.permissionMode).toBe('default');
    expect(recipe.pinnedNotes).toEqual(['memory/Project - Cindy.md']);
    expect(recipe.skills).toEqual(['review-checklist']);
    expect(recipe.tools).toContain('read_file');
    expect(recipe.connectors).toContain('lmstudio-local');
    expect(recipe.capabilityIds.length).toBeGreaterThan(7);
  });

  it('shows every known kind in the chip summary, including zero counts', () => {
    const withoutPins = buildSessionManifest(input({ pinnedNotes: [] }));
    const summary = sessionManifestKindSummary(withoutPins);
    expect(summary.map((row) => row.kind)).toEqual([
      'expert',
      'skill',
      'tool',
      'connector',
      'pinned-note',
      'model-route',
      'permission',
    ]);
    expect(summary.find((row) => row.kind === 'pinned-note')?.count).toBe(0);
    expect(summary.find((row) => row.kind === 'skill')?.count).toBe(1);
  });

  it('groups in a stable display order and keeps unknown kinds', () => {
    const manifest = buildSessionManifest(input());
    const grouped = groupSessionManifest(manifest);
    expect(grouped[0].kind).toBe('expert');
    expect(grouped.map((group) => group.kind)).toContain('permission');
    expect(grouped.reduce((total, group) => total + group.items.length, 0)).toBe(
      manifest.capabilities.length,
    );
  });
});

describe('chat-only sessions (ROADMAP 10.3)', () => {
  it('records the mode as a capability so a resumed session cannot silently regain tools', () => {
    const manifest = buildSessionManifest({
      ...input(),
      session: { ...input().session, chatOnly: true },
    });
    expect(manifest.session.chatOnly).toBe(true);
    const row = manifest.capabilities.find((capability) => capability.id === 'permission:chat-only');
    expect(row).toMatchObject({
      kind: 'permission',
      label: 'Chat only',
      value: 'no tools, no MCP',
      trust: 'session-state',
    });
    expect(row?.reason).toMatch(/--safe-mode/);
  });

  it('leaves the manifest unchanged for a normal session', () => {
    const manifest = buildSessionManifest(input());
    expect(manifest.session.chatOnly).toBeUndefined();
    expect(manifest.capabilities.some((capability) => capability.id === 'permission:chat-only')).toBe(false);
  });

  it('survives the YAML round-trip', () => {
    const withChatOnly = buildSessionManifest({ ...input(), session: { ...input().session, chatOnly: true } });
    const parsed = parseSessionManifest(serializeSessionManifest(withChatOnly));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.session.chatOnly).toBe(true);
    expect(serializeSessionManifest(parsed.manifest)).toBe(serializeSessionManifest(withChatOnly));
  });

  it('rejects a non-boolean chatOnly instead of guessing', () => {
    const yaml = serializeSessionManifest(buildSessionManifest({ ...input(), session: { ...input().session, chatOnly: true } }))
      .replace('chatOnly: true', 'chatOnly: yes please');
    const parsed = parseSessionManifest(yaml);
    expect(parsed.ok).toBe(false);
  });
});
