import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { SkillScanReport } from '@cindy/maker-core/skills';

import type { SkillRow } from '../../../../main/maker-ipc/skills';
import { ScanReportView, SkillsListView, skillsTestIdSuffix } from '../SkillsSection';

const row = (id: string, extra: Partial<SkillRow> = {}): SkillRow => {
  const slash = id.indexOf('/');
  return {
    id,
    category: id.slice(0, slash),
    name: id.slice(slash + 1),
    enabled: true,
    builtin: false,
    ...extra,
  };
};

const renderList = (skills: SkillRow[], extra: Partial<Parameters<typeof SkillsListView>[0]> = {}) =>
  renderToStaticMarkup(
    <SkillsListView skills={skills} pending={null} confirmingUninstall={null} onToggle={() => undefined} onUninstall={() => undefined} {...extra} />,
  );

const report = (extra: Partial<SkillScanReport> = {}): SkillScanReport => ({
  dir: '/tmp/candidate',
  name: 'candidate',
  fileCount: 2,
  findings: [],
  verdict: 'ok',
  ...extra,
});

const renderReport = (r: SkillScanReport, extra: Partial<Parameters<typeof ScanReportView>[0]> = {}) =>
  renderToStaticMarkup(<ScanReportView report={r} installing={false} onInstall={() => undefined} {...extra} />);

describe('Settings skills manager (ROADMAP 4.4b)', () => {
  it('lists skills with category badge, description and a toggle per row', () => {
    const html = renderList([
      row('community/alpha', { description: 'alpha test skill' }),
      row('bundled/core-skill', { builtin: true }),
      row('community/beta', { enabled: false }),
    ]);
    expect(html).toContain('alpha');
    expect(html).toContain('community');
    expect(html).toContain('alpha test skill');
    expect(html).toContain('data-testid="skills-toggle-community-alpha"');
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="skills-toggle-community-alpha"/);
    expect(html).toMatch(/aria-checked="false"[^>]*data-testid="skills-toggle-community-beta"/);
    expect(html).toContain('Disabled');
  });

  it('built-in rows carry the badge and no remove button, and their toggle is disabled', () => {
    const html = renderList([row('bundled/core-skill', { builtin: true }), row('community/alpha')]);
    expect(html).toContain('data-testid="skills-builtin-bundled-core-skill"');
    expect(html).not.toContain('skills-uninstall-bundled-core-skill');
    expect(html).toContain('data-testid="skills-uninstall-community-alpha"');
    expect(html).toMatch(/data-disabled=""[^>]*data-testid="skills-toggle-bundled-core-skill"/);
    expect(html).not.toMatch(/data-disabled=""[^>]*data-testid="skills-toggle-community-alpha"/);
  });

  it('the second uninstall click is explicit (Confirm? label on the armed row only)', () => {
    const html = renderList([row('community/alpha'), row('community/beta')], { confirmingUninstall: 'community/alpha' });
    expect(html).toContain('Confirm?');
    expect(html).toMatch(/data-testid="skills-uninstall-community-alpha".*Confirm\?/s);
    expect(html).not.toMatch(/data-testid="skills-uninstall-community-beta".*Confirm\?/s);
  });

  it('the in-flight toggle is disabled so it cannot be double-fired', () => {
    const html = renderList([row('community/alpha'), row('community/beta')], { pending: 'community/alpha' });
    expect(html).toMatch(/data-disabled=""[^>]*data-testid="skills-toggle-community-alpha"/);
    expect(html).not.toMatch(/data-disabled=""[^>]*data-testid="skills-toggle-community-beta"/);
  });

  it('the empty state is explicit', () => {
    expect(renderList([])).toContain('No skills installed');
  });

  it('scan report: an ok report offers Install; a review report counts the HIGH findings', () => {
    const okHtml = renderReport(report());
    expect(okHtml).toContain('data-testid="skills-scan-verdict"');
    expect(okHtml).toContain('OK');
    expect(okHtml).toContain('>Install</');
    expect(okHtml).not.toContain('Install anyway');
    expect(okHtml).toContain('No findings');

    const reviewHtml = renderReport(
      report({
        verdict: 'review',
        findings: [
          { severity: 'high', rule: 'reads-credentials', file: 'run.sh', line: 2, excerpt: 'cat ~/.ssh/id_rsa' },
          { severity: 'medium', rule: 'network-call', file: 'SKILL.md', line: 9, excerpt: 'curl https://x' },
        ],
      }),
    );
    expect(reviewHtml).toContain('Review');
    expect(reviewHtml).toContain('Install anyway (1 HIGH findings)');
    expect(reviewHtml).toContain('reads-credentials');
    expect(reviewHtml).toContain('run.sh:2');
    expect(reviewHtml).toContain('cat ~/.ssh/id_rsa');
    expect(reviewHtml).toContain('network-call');
  });

  it('scan report: blocked and invalid reports explain themselves and offer no install', () => {
    const blockedHtml = renderReport(report({ verdict: 'blocked' }));
    expect(blockedHtml).toContain('Blocked');
    expect(blockedHtml).toContain('symlinks');
    expect(blockedHtml).not.toContain('skills-install-button');

    const invalidHtml = renderReport(report({ verdict: 'invalid', error: 'folder not found' }));
    expect(invalidHtml).toContain('Invalid');
    expect(invalidHtml).toContain('folder not found');
    expect(invalidHtml).not.toContain('skills-install-button');
  });

  it('testid suffixes are sanitized', () => {
    expect(skillsTestIdSuffix('community/a b/c_d')).toBe('community-a-b-c-d');
  });

  describe('Add to expert dropdown (ROADMAP 4.4c)', () => {
    it('renders "Add to expert…" select with available Hermes experts', () => {
      const html = renderList([row('community/alpha')], {
        expertOptions: [
          { slug: 'researcher', name: 'Researcher' },
          { slug: 'coder', name: 'Code Expert' },
        ],
        onAddToExpert: () => undefined,
      });
      expect(html).toContain('data-testid="skills-add-expert-community-alpha"');
      expect(html).toContain('Add to expert…');
      expect(html).toContain('value="researcher"');
      expect(html).toContain('>Researcher</option>');
      expect(html).toContain('value="coder"');
      expect(html).toContain('>Code Expert</option>');
    });

    it('renders disabled select with "No experts" when expert list is empty', () => {
      const html = renderList([row('community/alpha')], {
        expertOptions: [],
        onAddToExpert: () => undefined,
      });
      expect(html).toContain('data-testid="skills-add-expert-community-alpha"');
      expect(html).toMatch(/<select[^>]*disabled=""[^>]*data-testid="skills-add-expert-community-alpha"/);
      expect(html).toContain('No experts');
    });

    it('disables the select while an addition is in flight', () => {
      const html = renderList([row('community/alpha')], {
        expertOptions: [{ slug: 'researcher', name: 'Researcher' }],
        addingToExpert: 'community/alpha',
        onAddToExpert: () => undefined,
      });
      expect(html).toMatch(/<select[^>]*disabled=""[^>]*data-testid="skills-add-expert-community-alpha"/);
    });
  });
});

