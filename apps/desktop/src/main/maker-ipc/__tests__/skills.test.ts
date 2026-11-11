import { describe, expect, it, vi } from 'vitest';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { MAKER_INVOKE, MAKER_PUSH } from '../channels';
import { createSkillsHost, registerSkillsHandlers, type SkillsHostDeps, type SkillsView } from '../skills';
import { IpcHarness } from './helpers/ipcHarness';

function writeSkill(dir: string, name: string, extra: Record<string, string> = {}): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} test skill\n---\n# ${name}\n\nA harmless test skill.\n`,
  );
  for (const [file, content] of Object.entries(extra)) {
    fs.writeFileSync(path.join(dir, file), content);
  }
}

interface TmpRoots {
  base: string;
  skillsRoot: string;
  disabledRoot: string;
  cleanup(): void;
}

function makeRoots(): TmpRoots {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-skills-test-'));
  return {
    base,
    skillsRoot: path.join(base, 'skills'),
    disabledRoot: path.join(base, 'skills-disabled'),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

function deps(roots: TmpRoots, overrides: Partial<SkillsHostDeps> = {}): SkillsHostDeps {
  return {
    roots: () => ({ skillsRoot: roots.skillsRoot, disabledRoot: roots.disabledRoot }),
    clone: vi.fn(async () => {
      throw new Error('clone not expected');
    }),
    tmpdir: () => roots.base,
    ...overrides,
  };
}

const byId = (view: SkillsView, id: string) => {
  const row = view.skills.find((s) => s.id === id);
  if (!row) throw new Error(`missing skill row ${id}`);
  return row;
};

describe('skills host (ROADMAP 4.4b)', () => {
  it('lists enabled and disabled skills sorted, with the builtin badge from the manifest', async () => {
    const roots = makeRoots();
    try {
      writeSkill(path.join(roots.skillsRoot, 'community', 'alpha'), 'alpha');
      writeSkill(path.join(roots.disabledRoot, 'community', 'beta'), 'beta');
      fs.writeFileSync(path.join(roots.skillsRoot, '.bundled_manifest'), 'alpha:deadbeef\n');

      const view = await createSkillsHost(deps(roots)).list();

      expect(view.skills.map((s) => s.id)).toEqual(['community/alpha', 'community/beta']);
      expect(byId(view, 'community/alpha')).toMatchObject({ enabled: true, builtin: true, description: 'alpha test skill' });
      expect(byId(view, 'community/beta')).toMatchObject({ enabled: false, builtin: false });
      expect(view.skillsRoot).toBe(roots.skillsRoot);
      expect(view.disabledRoot).toBe(roots.disabledRoot);
    } finally {
      roots.cleanup();
    }
  });

  it('scan local: benign skill is ok, a HIGH finding is review, a missing folder is invalid', async () => {
    const roots = makeRoots();
    try {
      const benign = path.join(roots.base, 'cand-benign');
      writeSkill(benign, 'benign');
      const risky = path.join(roots.base, 'cand-risky');
      writeSkill(risky, 'risky', { 'run.sh': '#!/bin/sh\ncat ~/.ssh/id_rsa\n' });

      const host = createSkillsHost(deps(roots));

      const okScan = await host.scan({ source: 'local', path: benign });
      expect(okScan.report).toMatchObject({ verdict: 'ok', name: 'benign', fileCount: 1 });
      expect(okScan.preparedId).toBeUndefined();

      const reviewScan = await host.scan({ source: 'local', path: risky });
      expect(reviewScan.report.verdict).toBe('review');
      expect(reviewScan.report.findings).toEqual(
        expect.arrayContaining([expect.objectContaining({ severity: 'high', rule: 'reads-credentials', file: 'run.sh', line: 2 })]),
      );

      const invalid = await host.scan({ source: 'local', path: path.join(roots.base, 'nope') });
      expect(invalid.report.verdict).toBe('invalid');

      await expect(host.scan({ source: 'local' })).rejects.toThrow('path (folder) required');
      await expect(host.scan({ source: 'carrier-pigeon' })).rejects.toThrow('source must be');
    } finally {
      roots.cleanup();
    }
  });

  it('scan git: clones into temp, returns a one-shot preparedId, and rejects bad URLs without cloning', async () => {
    const roots = makeRoots();
    try {
      const clone = vi.fn(async (_url: string, destDir: string) => {
        writeSkill(destDir, 'git-skill');
      });
      const host = createSkillsHost(deps(roots, { clone }));

      const res = await host.scan({ source: 'git', url: 'https://example.com/repo.git' });
      expect(clone).toHaveBeenCalledOnce();
      expect(res.report).toMatchObject({ verdict: 'ok', name: 'git-skill' });
      expect(res.preparedId).toMatch(/^prep-/);
      // The clone survives for the later install.
      const cloneDir = (clone.mock.calls[0] as unknown[])[1] as string;
      expect(fs.existsSync(path.join(cloneDir, 'SKILL.md'))).toBe(true);

      await expect(host.scan({ source: 'git', url: 'not-a-url' })).rejects.toThrow('git URL');
      await expect(host.scan({ source: 'git', url: 'https://example.com/r.git', subdir: '../escape' })).rejects.toThrow('subdir');
      expect(clone).toHaveBeenCalledTimes(1);
    } finally {
      roots.cleanup();
    }
  });

  it('scan git: subdir picks the skill inside a monorepo; multi-skill roots return candidates', async () => {
    const roots = makeRoots();
    try {
      const clone = vi.fn(async (_url: string, destDir: string) => {
        writeSkill(path.join(destDir, 'one'), 'one');
        writeSkill(path.join(destDir, 'two'), 'two');
      });
      const host = createSkillsHost(deps(roots, { clone }));

      const withSubdir = await host.scan({ source: 'git', url: 'https://example.com/mono.git', subdir: 'one' });
      expect(withSubdir.report).toMatchObject({ verdict: 'ok', name: 'one' });
      expect(withSubdir.preparedId).toBeDefined();

      const multi = await host.scan({ source: 'git', url: 'https://example.com/mono.git' });
      expect(multi.preparedId).toBeUndefined();
      expect(multi.report.verdict).toBe('invalid');
      expect([...(multi.candidates ?? [])].sort()).toEqual(['one', 'two']);
    } finally {
      roots.cleanup();
    }
  });

  it('scan git: a failed clone cleans its temp dir and throws', async () => {
    const roots = makeRoots();
    try {
      const before = fs.readdirSync(roots.base).length;
      const clone = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      });
      const host = createSkillsHost(deps(roots, { clone }));

      await expect(host.scan({ source: 'git', url: 'https://example.com/r.git' })).rejects.toThrow('git clone failed: ECONNREFUSED');
      expect(fs.readdirSync(roots.base)).toHaveLength(before);
    } finally {
      roots.cleanup();
    }
  });

  it('install local: copies into the category, refuses HIGH findings without acknowledgement', async () => {
    const roots = makeRoots();
    try {
      const benign = path.join(roots.base, 'cand-benign');
      writeSkill(benign, 'benign');
      const risky = path.join(roots.base, 'cand-risky');
      writeSkill(risky, 'risky', { 'run.sh': '#!/bin/sh\ncat ~/.ssh/id_rsa\n' });
      const host = createSkillsHost(deps(roots));

      const ok = await host.install({ source: 'local', path: benign, category: 'community' });
      expect(ok.installed).toBe(true);
      expect(fs.existsSync(path.join(roots.skillsRoot, 'community', 'benign', 'SKILL.md'))).toBe(true);

      // Never overwritten.
      const again = await host.install({ source: 'local', path: benign, category: 'community' });
      expect(again).toMatchObject({ installed: false, reason: 'exists' });

      const gated = await host.install({ source: 'local', path: risky, category: 'community' });
      expect(gated).toMatchObject({ installed: false, reason: 'needs-acknowledgement' });
      expect(fs.existsSync(path.join(roots.skillsRoot, 'community', 'risky'))).toBe(false);

      const acked = await host.install({ source: 'local', path: risky, category: 'community', acknowledgeHigh: true });
      expect(acked.installed).toBe(true);

      await expect(host.install({ source: 'local', path: benign, category: 'bad cat' })).rejects.toThrow('plain slug');
      await expect(host.install({ source: 'prepared', category: 'community' })).rejects.toThrow('preparedId required');
    } finally {
      roots.cleanup();
    }
  });

  it('install prepared: one-shot token installs the kept clone, then expires', async () => {
    const roots = makeRoots();
    try {
      let cloneDir = '';
      const clone = vi.fn(async (_url: string, destDir: string) => {
        cloneDir = destDir;
        writeSkill(destDir, 'git-skill');
      });
      const host = createSkillsHost(deps(roots, { clone }));

      const scanned = await host.scan({ source: 'git', url: 'https://example.com/repo.git' });
      const installed = await host.install({ source: 'prepared', preparedId: scanned.preparedId, category: 'community' });
      expect(installed.installed).toBe(true);
      expect(fs.existsSync(path.join(roots.skillsRoot, 'community', 'git-skill', 'SKILL.md'))).toBe(true);
      // The temp clone is cleaned up after install.
      expect(fs.existsSync(cloneDir)).toBe(false);

      await expect(
        host.install({ source: 'prepared', preparedId: scanned.preparedId, category: 'community' }),
      ).rejects.toThrow('prepared clone expired; scan again');
    } finally {
      roots.cleanup();
    }
  });

  it('install prepared: an expired prepared clone is refused', async () => {
    const roots = makeRoots();
    try {
      const clone = vi.fn(async (_url: string, destDir: string) => {
        writeSkill(destDir, 'git-skill');
      });
      const host = createSkillsHost(deps(roots, { clone, preparedTtlMs: 0 }));

      const scanned = await host.scan({ source: 'git', url: 'https://example.com/repo.git' });
      expect(scanned.preparedId).toBeDefined();
      await expect(
        host.install({ source: 'prepared', preparedId: scanned.preparedId, category: 'community' }),
      ).rejects.toThrow('prepared clone expired; scan again');
    } finally {
      roots.cleanup();
    }
  });

  it('setEnabled moves the folder between roots and refuses built-ins', async () => {
    const roots = makeRoots();
    try {
      writeSkill(path.join(roots.skillsRoot, 'community', 'alpha'), 'alpha');
      writeSkill(path.join(roots.skillsRoot, 'bundled', 'core-skill'), 'core-skill');
      fs.writeFileSync(path.join(roots.skillsRoot, '.bundled_manifest'), 'core-skill:deadbeef\n');
      const host = createSkillsHost(deps(roots));

      const off = await host.setEnabled({ category: 'community', name: 'alpha', enabled: false });
      expect(byId(off, 'community/alpha').enabled).toBe(false);
      expect(fs.existsSync(path.join(roots.disabledRoot, 'community', 'alpha', 'SKILL.md'))).toBe(true);
      expect(fs.existsSync(path.join(roots.skillsRoot, 'community', 'alpha'))).toBe(false);

      const on = await host.setEnabled({ category: 'community', name: 'alpha', enabled: true });
      expect(byId(on, 'community/alpha').enabled).toBe(true);
      expect(fs.existsSync(path.join(roots.skillsRoot, 'community', 'alpha', 'SKILL.md'))).toBe(true);

      await expect(host.setEnabled({ category: 'bundled', name: 'core-skill', enabled: false })).rejects.toThrow('built-in');
      await expect(host.setEnabled({ category: 'community', name: 'ghost', enabled: false })).rejects.toThrow();
      await expect(host.setEnabled({ category: '../evil', name: 'alpha', enabled: false })).rejects.toThrow('plain slug');
      await expect(host.setEnabled({ category: 'community', name: 'alpha', enabled: 'yes' })).rejects.toThrow('enabled (boolean)');
    } finally {
      roots.cleanup();
    }
  });

  it('uninstall removes from either root and refuses built-ins and unknown skills', async () => {
    const roots = makeRoots();
    try {
      writeSkill(path.join(roots.skillsRoot, 'community', 'alpha'), 'alpha');
      writeSkill(path.join(roots.disabledRoot, 'community', 'beta'), 'beta');
      writeSkill(path.join(roots.skillsRoot, 'bundled', 'core-skill'), 'core-skill');
      fs.writeFileSync(path.join(roots.skillsRoot, '.bundled_manifest'), 'core-skill:deadbeef\n');
      const host = createSkillsHost(deps(roots));

      const afterAlpha = await host.uninstall({ category: 'community', name: 'alpha' });
      expect(afterAlpha.skills.map((s) => s.id).sort()).toEqual(['bundled/core-skill', 'community/beta']);
      expect(fs.existsSync(path.join(roots.skillsRoot, 'community', 'alpha'))).toBe(false);

      await host.uninstall({ category: 'community', name: 'beta' });
      expect(fs.existsSync(path.join(roots.disabledRoot, 'community', 'beta'))).toBe(false);

      await expect(host.uninstall({ category: 'bundled', name: 'core-skill' })).rejects.toThrow('built-in');
      await expect(host.uninstall({ category: 'community', name: 'ghost' })).rejects.toThrow('unknown skill');
    } finally {
      roots.cleanup();
    }
  });

  describe('addToExpert (ROADMAP 4.4)', () => {
    function makeExpert(root: string, slug: string, agent = 'hermes') {
      const dir = path.join(root, slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'expert.md'),
        `---\nname: ${slug}\nagent: ${agent}\ndescription: test expert\ntags: [testing]\n---\nPrompt body\n`,
        'utf8',
      );
      return dir;
    }

    it('adds a skill to an expert frontmatter and copies the skill directory', async () => {
      const roots = makeRoots();
      const expertsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-test-experts-'));
      try {
        makeExpert(expertsRoot, 'reviewer');
        writeSkill(path.join(roots.skillsRoot, 'community', 'my-skill'), 'my-skill', { 'helper.py': 'print("hi")\n' });

        const host = createSkillsHost(deps(roots, { expertsRootDir: expertsRoot }));
        const res = await host.addToExpert('community/my-skill', 'reviewer');

        expect(res).toEqual({ ok: true, slug: 'reviewer', skillName: 'my-skill' });

        // expert.md frontmatter updated
        const md = fs.readFileSync(path.join(expertsRoot, 'reviewer', 'expert.md'), 'utf8');
        expect(md).toContain('skills:');
        expect(md).toContain('my-skill');
        expect(md).toContain('tags:');

        // skill folder copied into expert's skills/ directory
        const copiedSkill = path.join(expertsRoot, 'reviewer', 'skills', 'my-skill');
        expect(fs.existsSync(path.join(copiedSkill, 'SKILL.md'))).toBe(true);
        expect(fs.readFileSync(path.join(copiedSkill, 'helper.py'), 'utf8')).toBe('print("hi")\n');
      } finally {
        roots.cleanup();
        fs.rmSync(expertsRoot, { recursive: true, force: true });
      }
    });

    it('is idempotent: calling twice does not duplicate skill entry in frontmatter', async () => {
      const roots = makeRoots();
      const expertsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-test-experts-'));
      try {
        makeExpert(expertsRoot, 'reviewer');
        writeSkill(path.join(roots.skillsRoot, 'community', 'my-skill'), 'my-skill');

        const host = createSkillsHost(deps(roots, { expertsRootDir: expertsRoot }));
        await host.addToExpert('community/my-skill', 'reviewer');
        const res = await host.addToExpert('community/my-skill', 'reviewer');

        expect(res).toEqual({ ok: true, slug: 'reviewer', skillName: 'my-skill' });

        const md = fs.readFileSync(path.join(expertsRoot, 'reviewer', 'expert.md'), 'utf8');
        const matches = md.match(/my-skill/g);
        expect(matches).toHaveLength(1);
      } finally {
        roots.cleanup();
        fs.rmSync(expertsRoot, { recursive: true, force: true });
      }
    });

    it('can copy from disabledRoot if skill is currently disabled', async () => {
      const roots = makeRoots();
      const expertsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-test-experts-'));
      try {
        makeExpert(expertsRoot, 'reviewer');
        writeSkill(path.join(roots.disabledRoot, 'community', 'off-skill'), 'off-skill');

        const host = createSkillsHost(deps(roots, { expertsRootDir: expertsRoot }));
        const res = await host.addToExpert('community/off-skill', 'reviewer');

        expect(res).toEqual({ ok: true, slug: 'reviewer', skillName: 'off-skill' });
        expect(fs.existsSync(path.join(expertsRoot, 'reviewer', 'skills', 'off-skill', 'SKILL.md'))).toBe(true);
      } finally {
        roots.cleanup();
        fs.rmSync(expertsRoot, { recursive: true, force: true });
      }
    });

    it('refuses invalid slug, unknown skill, or non-Hermes expert', async () => {
      const roots = makeRoots();
      const expertsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-test-experts-'));
      try {
        makeExpert(expertsRoot, 'codex-bot', 'codex');
        makeExpert(expertsRoot, 'reviewer', 'hermes');
        writeSkill(path.join(roots.skillsRoot, 'community', 'my-skill'), 'my-skill');

        const host = createSkillsHost(deps(roots, { expertsRootDir: expertsRoot }));

        await expect(host.addToExpert('community/my-skill', '')).rejects.toThrow('invalid expert slug');
        await expect(host.addToExpert('invalid-id', 'reviewer')).rejects.toThrow('invalid skill id');
        await expect(host.addToExpert('community/missing', 'reviewer')).rejects.toThrow('unknown skill');
        await expect(host.addToExpert('community/my-skill', 'nonexistent')).rejects.toThrow('cannot update expert');
        await expect(host.addToExpert('community/my-skill', 'codex-bot')).rejects.toThrow('not a hermes agent');
      } finally {
        roots.cleanup();
        fs.rmSync(expertsRoot, { recursive: true, force: true });
      }
    });
  });
});

describe('skills IPC (ROADMAP 4.4b)', () => {
  const freshView: SkillsView = { skills: [], skillsRoot: '/tmp/skills', disabledRoot: '/tmp/skills-disabled' };

  function hostStub() {
    return {
      list: vi.fn(async () => freshView),
      scan: vi.fn(async () => ({ report: { dir: '/tmp/x', fileCount: 1, findings: [], verdict: 'ok' as const } })),
      install: vi.fn(async () => ({
        installed: true as const,
        dir: '/tmp/skills/community/x',
        report: { dir: '/tmp/x', fileCount: 1, findings: [], verdict: 'ok' as const },
      })),
      setEnabled: vi.fn(async () => freshView),
      uninstall: vi.fn(async () => freshView),
      addToExpert: vi.fn(async () => ({ ok: true as const, slug: 'reviewer', skillName: 'my-skill' })),
      resolvePinned: vi.fn(async () => ({ skills: [], knownSlugs: [], estimatedDiscoveryTokens: 0 })),
    };
  }

  it('all seven channels require a trusted sender; an untrusted call never reaches the host', async () => {
    const host = hostStub();
    const harness = new IpcHarness();
    registerSkillsHandlers(harness, {
      host,
      assertTrusted: () => {
        throw new Error('untrusted sender');
      },
      broadcast: vi.fn(),
    });

    await expect(harness.invoke(MAKER_INVOKE.SKILLS_LIST)).rejects.toThrow('untrusted sender');
    await expect(harness.invoke(MAKER_INVOKE.SKILLS_SCAN, { source: 'local', path: '/x' })).rejects.toThrow('untrusted sender');
    await expect(harness.invoke(MAKER_INVOKE.SKILLS_INSTALL, { source: 'local', path: '/x', category: 'c' })).rejects.toThrow('untrusted sender');
    await expect(harness.invoke(MAKER_INVOKE.SKILLS_SET_ENABLED, { category: 'c', name: 'n', enabled: false })).rejects.toThrow('untrusted sender');
    await expect(harness.invoke(MAKER_INVOKE.SKILLS_UNINSTALL, { category: 'c', name: 'n' })).rejects.toThrow('untrusted sender');
    await expect(harness.invoke(MAKER_INVOKE.SKILLS_ADD_TO_EXPERT, { id: 'c/n', slug: 'reviewer' })).rejects.toThrow('untrusted sender');
    await expect(harness.invoke(MAKER_INVOKE.SKILLS_RESOLVE_PINNED, { slugs: ['x'] })).rejects.toThrow('untrusted sender');
    expect(host.list).not.toHaveBeenCalled();
    expect(host.scan).not.toHaveBeenCalled();
    expect(host.install).not.toHaveBeenCalled();
    expect(host.setEnabled).not.toHaveBeenCalled();
    expect(host.uninstall).not.toHaveBeenCalled();
    expect(host.addToExpert).not.toHaveBeenCalled();
    expect(host.resolvePinned).not.toHaveBeenCalled();
  });

  it('scan returns the report without broadcasting; install/set-enabled/uninstall broadcast changed', async () => {
    const host = hostStub();
    const broadcast = vi.fn();
    const assertTrusted = vi.fn();
    const harness = new IpcHarness();
    registerSkillsHandlers(harness, { host, assertTrusted, broadcast });

    const report = await harness.invoke(MAKER_INVOKE.SKILLS_SCAN, { source: 'local', path: '/x' });
    expect(host.scan).toHaveBeenCalledWith({ source: 'local', path: '/x' });
    expect(report).toMatchObject({ report: { verdict: 'ok' } });
    expect(broadcast).not.toHaveBeenCalled();

    const installResult = await harness.invoke(MAKER_INVOKE.SKILLS_INSTALL, { source: 'local', path: '/x', category: 'community' });
    expect(installResult).toMatchObject({ installed: true });
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.SKILLS_CHANGED);

    const setResult = await harness.invoke(MAKER_INVOKE.SKILLS_SET_ENABLED, { category: 'community', name: 'x', enabled: false });
    expect(host.setEnabled).toHaveBeenCalledWith({ category: 'community', name: 'x', enabled: false });
    expect(setResult).toEqual(freshView);

    const uninstallResult = await harness.invoke(MAKER_INVOKE.SKILLS_UNINSTALL, { category: 'community', name: 'x' });
    expect(host.uninstall).toHaveBeenCalledWith({ category: 'community', name: 'x' });
    expect(uninstallResult).toEqual(freshView);
    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(assertTrusted).toHaveBeenCalledTimes(4);

    const addResult = await harness.invoke(MAKER_INVOKE.SKILLS_ADD_TO_EXPERT, { id: 'community/x', slug: 'reviewer' });
    expect(host.addToExpert).toHaveBeenCalledWith('community/x', 'reviewer');
    expect(addResult).toEqual({ ok: true, slug: 'reviewer', skillName: 'my-skill' });
    expect(broadcast).toHaveBeenCalledWith(MAKER_PUSH.EXPERTS_CHANGED);
  });
});

describe('skills host resolvePinned (ROADMAP 11.1 Tier 2B)', () => {
  it('returns full bodies for known slugs and omits unknown ones', async () => {
    const roots = makeRoots();
    try {
      const skillDir = path.join(roots.skillsRoot, 'development', 'git-worktree');
      writeSkill(skillDir, 'git-worktree');
      fs.mkdirSync(path.join(skillDir, 'scripts'), { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'scripts', 'add.sh'), '#!/bin/sh\necho never-in-context\n');
      const result = await createSkillsHost(deps(roots)).resolvePinned({
        slugs: ['git-worktree', 'does-not-exist'],
      });
      expect(result.knownSlugs).toEqual(['git-worktree']);
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].instructions).toContain('# git-worktree');
      expect(result.skills[0].instructions).not.toContain('never-in-context');
      expect(result.skills[0].availableScripts).toEqual(['scripts/add.sh']);
      expect(result.estimatedDiscoveryTokens).toBeLessThan(1000);
    } finally {
      roots.cleanup();
    }
  });

  it('fails closed for chat-only sessions', async () => {
    const roots = makeRoots();
    try {
      writeSkill(path.join(roots.skillsRoot, 'development', 'a-skill'), 'a-skill');
      const result = await createSkillsHost(deps(roots)).resolvePinned({ slugs: ['a-skill'], chatOnly: true });
      expect(result).toEqual({ skills: [], knownSlugs: [], estimatedDiscoveryTokens: 0 });
    } finally {
      roots.cleanup();
    }
  });

  it('a user pin can activate a skill that disabled autonomous activation', async () => {
    const roots = makeRoots();
    try {
      const dir = path.join(roots.skillsRoot, 'development', 'manual');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\nname: manual\ndescription: manual only\ndisableModelActivation: true\n---\nManual procedure.\n');
      const result = await createSkillsHost(deps(roots)).resolvePinned({ slugs: ['manual'] });
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].instructions).toContain('Manual procedure.');
    } finally {
      roots.cleanup();
    }
  });
});
