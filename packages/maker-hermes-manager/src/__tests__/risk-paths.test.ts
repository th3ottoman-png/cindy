import { describe, expect, it } from 'vitest';

import {
  RISK_RULES,
  RISK_THRESHOLD,
  blastRadiusReason,
  classifyToolCallRisk,
  toolCallPaths,
} from '../risk-paths.js';

const write = (path: string) => ({ toolName: 'write_file', toolInput: { path, content: 'x' } });
const patch = (path: string, diff?: string) => ({
  toolName: 'patch',
  toolInput: { path, old_string: 'a', new_string: 'b', ...(diff ? { patch: diff } : {}) },
});

function category(path: string): string | undefined {
  const verdict = classifyToolCallRisk(write(path));
  return verdict.highRisk ? verdict.matches[0]?.category : undefined;
}

describe('high-blast-radius path classifier', () => {
  it.each([
    ['providers.yaml', 'harness-config'],
    ['routing.yaml', 'harness-config'],
    ['~/.hermes-cindy/config.yaml', 'harness-config'],
    ['~/.cindy-harness/security.json', 'harness-config'],
    ['apps/desktop/src/main/auth/session.ts', 'auth'],
    ['src/keychain.ts', 'auth'],
    ['lib/jwt.ts', 'auth'],
    ['db/migrations/001_init.sql', 'database'],
    ['db/schema.sql', 'database'],
    ['prisma/schema.prisma', 'database'],
    ['src/billing/stripe.ts', 'payment'],
    ['src/pricing.ts', 'payment'],
  ])('flags %s as %s', (path, expected) => {
    expect(category(path)).toBe(expected);
  });

  it.each([
    'README.md',
    'src/utils/math.ts',
    'docs/architecture.md',
    'package.json',
    'Dockerfile',
    'src/auth/session.test.ts',
    '__tests__/auth/session.ts',
  ])('does not flag %s', (path) => {
    expect(classifyToolCallRisk(write(path)).highRisk).toBe(false);
  });

  it('never inspects read tools', () => {
    expect(
      classifyToolCallRisk({ toolName: 'read_file', toolInput: { path: 'providers.yaml' } }).highRisk,
    ).toBe(false);
    expect(toolCallPaths({ toolName: 'read_file', toolInput: { path: 'providers.yaml' } })).toEqual([]);
  });

  it('a dangerous command without a risk path stays 11.3 territory, not this layer', () => {
    // `rm -rf /` is the command guardrail's job (11.3); `/` matches no risk rule here.
    expect(
      classifyToolCallRisk({ toolName: 'terminal', toolInput: { command: 'rm -rf /' } }).highRisk,
    ).toBe(false);
    expect(
      classifyToolCallRisk({ toolName: 'bash', toolInput: { command: 'git push --force origin main' } })
        .highRisk,
    ).toBe(false);
  });

  it.each([
    ['echo x > providers.yaml', ['providers.yaml']],
    ['cat notes.txt >> ~/.cindy-harness/providers.yaml', ['~/.cindy-harness/providers.yaml']],
    ['echo x | tee routing.yaml', ['routing.yaml']],
    ["sed -i 's/old/new/' providers.yaml", ['providers.yaml']],
    ['cp /tmp/new.yaml providers.yaml', ['/tmp/new.yaml', 'providers.yaml']],
    ['mv providers.yaml providers.bak', ['providers.yaml', 'providers.bak']],
    ['chmod 600 ~/.cindy-harness/security.json', ['~/.cindy-harness/security.json']],
    ['touch src/auth/session.ts', ['src/auth/session.ts']],
  ])('extracts terminal write targets from %s', (command, expected) => {
    expect(toolCallPaths({ toolName: 'terminal', toolInput: { command } })).toEqual(expected);
  });

  it('flags a terminal write to a high-blast-radius path', () => {
    const verdict = classifyToolCallRisk({
      toolName: 'terminal',
      toolInput: { command: 'echo "model: x" > ~/.cindy-harness/providers.yaml' },
    });
    expect(verdict.highRisk).toBe(true);
    expect(verdict.matches[0]?.category).toBe('harness-config');
    expect(classifyToolCallRisk({ toolName: 'bash', toolInput: { command: 'cp a prisma/schema.prisma' } }).highRisk).toBe(true);
    expect(classifyToolCallRisk({ toolName: 'shell', toolInput: { command: 'perl -pi -e s/a/b/ src/keychain.ts' } }).highRisk).toBe(true);
    expect(classifyToolCallRisk({ toolName: 'run_command', toolInput: { cmd: 'install -m 644 x src/billing/stripe.ts' } }).highRisk).toBe(true);
    expect(classifyToolCallRisk({ toolName: 'execute_command', toolInput: { script: 'rm db/schema.sql' } }).highRisk).toBe(true);
  });

  it('does not flag terminal reads, fd redirects or heredocs', () => {
    expect(toolCallPaths({ toolName: 'terminal', toolInput: { command: 'cat providers.yaml' } })).toEqual([]);
    expect(toolCallPaths({ toolName: 'terminal', toolInput: { command: 'grep route routing.yaml' } })).toEqual([]);
    expect(toolCallPaths({ toolName: 'terminal', toolInput: { command: 'git push 2>&1' } })).toEqual([]);
    expect(toolCallPaths({ toolName: 'terminal', toolInput: { command: 'cat <<EOF\nproviders.yaml\nEOF' } })).toEqual([]);
    expect(
      classifyToolCallRisk({ toolName: 'terminal', toolInput: { command: 'cat providers.yaml | grep model' } })
        .highRisk,
    ).toBe(false);
  });

  it('reads the patch tool path and the paths inside a unified diff', () => {
    expect(classifyToolCallRisk(patch('providers.yaml')).highRisk).toBe(true);
    const diff = [
      '*** Begin Patch',
      '*** Update File: routing.yaml',
      '@@',
      '-model: old',
      '+model: new',
      '*** Add File: src/auth/new.ts',
      '*** End Patch',
    ].join('\n');
    const verdict = classifyToolCallRisk({ toolName: 'patch', toolInput: { patch: diff } });
    expect(verdict.highRisk).toBe(true);
    expect(verdict.paths).toEqual(expect.arrayContaining(['routing.yaml', 'src/auth/new.ts']));
    expect(verdict.matches.map((match) => match.category)).toEqual(
      expect.arrayContaining(['harness-config', 'auth']),
    );
  });

  it('deduplicates repeated paths', () => {
    expect(toolCallPaths(write('providers.yaml'))).toEqual(['providers.yaml']);
    expect(toolCallPaths({ toolName: 'write_file', toolInput: { path: 'a/b.ts', file_path: 'a/b.ts' } })).toEqual([
      'a/b.ts',
    ]);
  });

  it('scores the highest matching category and honours a custom threshold', () => {
    const verdict = classifyToolCallRisk(write('providers.yaml'));
    expect(verdict.score).toBeGreaterThanOrEqual(RISK_THRESHOLD);
    expect(classifyToolCallRisk(write('package.json')).score).toBeLessThan(RISK_THRESHOLD);
    expect(classifyToolCallRisk(write('package.json'), { threshold: 0.5 }).highRisk).toBe(true);
  });

  it('builds a blast-radius checklist for the owner card', () => {
    const reason = blastRadiusReason(classifyToolCallRisk(write('providers.yaml')));
    expect(reason).toContain('High-risk system file: providers.yaml');
    expect(reason).toContain('Blast radius: Harness configuration');
    expect(reason).toContain('- This file drives every later turn');
    expect(reason).toContain('Allow once only after checking the list.');
    expect(blastRadiusReason({ highRisk: false, score: 0, matches: [], paths: [] })).toBeUndefined();
  });

  it('has a unique id and a valid pattern per rule', () => {
    const ids = new Set<string>();
    for (const rule of RISK_RULES) {
      expect(ids.has(rule.id)).toBe(false);
      ids.add(rule.id);
      expect(rule.pattern).toBeInstanceOf(RegExp);
    }
  });
});
