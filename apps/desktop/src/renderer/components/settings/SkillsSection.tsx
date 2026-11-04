import { useCallback, useEffect, useState } from 'react';
import { Download, FolderOpen, GitBranch, Puzzle, Search, Trash2 } from 'lucide-react';

import type { SkillScanReport } from '@cindy/maker-core/skills';

import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

import type { SkillRow, SkillScanResponse, SkillsView } from '../../../main/maker-ipc/skills';
import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

/**
 * Hermes skills manager (ROADMAP 4.4b). Lists the skills under the Cindy Hermes home,
 * toggles them (a move between `skills/` and the sibling `skills-disabled/` Hermes never
 * scans) and installs new ones from a local folder or a git URL. Nothing is installed
 * without the static security-scan report being shown first; a report with HIGH findings
 * needs an explicit "Install anyway". Built-in (bundled-manifest) skills are listed but
 * never toggled or removed here — Hermes updates manage them.
 */

const INPUT_CLASS =
  'rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 py-1 text-12 text-[var(--text-primary)] placeholder:text-[var(--text-placeholder)] focus:outline-none focus:ring-1 focus:ring-[var(--accent)]';
const BUTTON_CLASS =
  'flex items-center gap-1 rounded-md border border-[var(--border-subtle)] px-2 py-1 text-11 text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50';

/** `<category>/<name>` → testid-safe suffix. */
export function skillsTestIdSuffix(id: string): string {
  return id.replace(/[^a-zA-Z0-9]+/g, '-');
}

export interface SkillsListViewProps {
  skills: readonly SkillRow[];
  /** Row id whose toggle is in flight (its switch is disabled). */
  pending: string | null;
  /** Row id waiting for the second uninstall click. */
  confirmingUninstall: string | null;
  onToggle: (id: string, enabled: boolean) => void;
  onUninstall: (id: string) => void;
}

export function SkillsListView({ skills, pending, confirmingUninstall, onToggle, onUninstall }: SkillsListViewProps) {
  return (
    <div className={SETTINGS_CARD_CLASS}>
      {skills.length === 0 ? (
        <div className="px-4 py-3 text-12 text-[var(--text-tertiary)]">No skills installed.</div>
      ) : (
        <ul className="flex flex-col">
          {skills.map((skill) => {
            const suffix = skillsTestIdSuffix(skill.id);
            const confirming = confirmingUninstall === skill.id;
            return (
              <li key={skill.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-13 font-medium text-[var(--text-primary)]">
                    {skill.name}
                    <span className="ml-2 rounded border border-[var(--border-subtle)] px-1 py-px font-mono text-10 text-[var(--text-tertiary)]">
                      {skill.category}
                    </span>
                    {skill.builtin ? (
                      <span
                        className="ml-1 rounded border border-[var(--border-subtle)] px-1 py-px text-10 text-[var(--text-tertiary)]"
                        data-testid={`skills-builtin-${suffix}`}
                      >
                        Built-in
                      </span>
                    ) : null}
                    {!skill.enabled ? (
                      <span className="ml-2 text-11 text-[var(--text-tertiary)]">Disabled</span>
                    ) : null}
                  </span>
                  {skill.description ? <span className={SETTINGS_ROW_HINT_CLASS}>{skill.description}</span> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {skill.builtin ? null : (
                    <button
                      type="button"
                      className={cn(BUTTON_CLASS, confirming ? 'border-red-500/40 text-red-500' : undefined)}
                      onClick={() => onUninstall(skill.id)}
                      data-testid={`skills-uninstall-${suffix}`}
                    >
                      <Trash2 size={11} aria-hidden="true" />
                      {confirming ? 'Confirm?' : 'Remove'}
                    </button>
                  )}
                  <Switch
                    checked={skill.enabled}
                    disabled={skill.builtin || pending === skill.id}
                    onCheckedChange={(enabled) => onToggle(skill.id, enabled)}
                    aria-label={`Enable skill ${skill.id}`}
                    data-testid={`skills-toggle-${suffix}`}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const VERDICT_LABEL: Record<SkillScanReport['verdict'], string> = {
  ok: 'OK',
  review: 'Review',
  blocked: 'Blocked',
  invalid: 'Invalid',
};

function verdictClass(verdict: SkillScanReport['verdict']): string {
  switch (verdict) {
    case 'ok':
      return 'text-emerald-500';
    case 'review':
      return 'text-amber-500';
    default:
      return 'text-red-500';
  }
}

const SEVERITY_CLASS: Record<string, string> = {
  high: 'border-red-500/40 text-red-500',
  medium: 'border-amber-500/40 text-amber-500',
  low: 'border-[var(--border-subtle)] text-[var(--text-tertiary)]',
};

export interface ScanReportViewProps {
  report: SkillScanReport;
  installing: boolean;
  onInstall: () => void;
}

/** The scan report that must be seen before an install button exists. */
export function ScanReportView({ report, installing, onInstall }: ScanReportViewProps) {
  const highCount = report.findings.filter((f) => f.severity === 'high').length;
  const installable = report.verdict === 'ok' || report.verdict === 'review';
  return (
    <div className={cn(SETTINGS_CARD_CLASS, 'flex flex-col gap-2 p-3')} data-testid="skills-scan-report">
      <div className="flex items-center justify-between gap-2">
        <span className="text-13 font-medium text-[var(--text-primary)]">
          {report.name ?? 'Unnamed skill'}
          <span className={cn('ml-2 text-11', verdictClass(report.verdict))} data-testid="skills-scan-verdict">
            {VERDICT_LABEL[report.verdict]}
          </span>
          <span className="ml-2 text-11 text-[var(--text-tertiary)]">{report.fileCount} files</span>
        </span>
        {installable ? (
          <button
            type="button"
            className={cn(BUTTON_CLASS, report.verdict === 'review' ? 'border-amber-500/40 text-amber-500' : undefined)}
            disabled={installing}
            onClick={onInstall}
            data-testid="skills-install-button"
          >
            <Download size={11} aria-hidden="true" />
            {installing
              ? 'Installing…'
              : report.verdict === 'review'
                ? `Install anyway (${highCount} HIGH findings)`
                : 'Install'}
          </button>
        ) : null}
      </div>
      {report.description ? <span className={SETTINGS_ROW_HINT_CLASS}>{report.description}</span> : null}
      {report.verdict === 'blocked' ? (
        <span className="text-11 text-red-500">This skill contains symlinks and cannot be installed. Remove them first.</span>
      ) : null}
      {report.verdict === 'invalid' ? (
        <span className="text-11 text-red-500">{report.error ?? 'Not a valid skill folder.'}</span>
      ) : null}
      {report.findings.length > 0 ? (
        <ul className="flex flex-col gap-1" data-testid="skills-scan-findings">
          {report.findings.map((finding, i) => (
            <li key={`${finding.rule}-${finding.file}-${finding.line ?? 0}-${i}`} className="flex items-baseline gap-2 text-11">
              <span className={cn('shrink-0 rounded border px-1 py-px text-10 uppercase', SEVERITY_CLASS[finding.severity])}>
                {finding.severity}
              </span>
              <span className="shrink-0 font-mono text-[var(--text-secondary)]">{finding.rule}</span>
              <span className="shrink-0 font-mono text-[var(--text-tertiary)]">
                {finding.file}
                {finding.line ? `:${finding.line}` : ''}
              </span>
              {finding.excerpt ? (
                <span className="min-w-0 truncate font-mono text-[var(--text-tertiary)]">{finding.excerpt}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <span className={SETTINGS_ROW_HINT_CLASS}>No findings.</span>
      )}
    </div>
  );
}

export function SkillsSection() {
  const api = window.electronAPI?.maker?.skills;
  const [view, setView] = useState<SkillsView | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [confirmingUninstall, setConfirmingUninstall] = useState<string | null>(null);
  const [mode, setMode] = useState<'local' | 'git'>('local');
  const [localPath, setLocalPath] = useState('');
  const [gitUrl, setGitUrl] = useState('');
  const [gitSubdir, setGitSubdir] = useState('');
  const [category, setCategory] = useState('community');
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<SkillScanResponse | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      setView(await api.list());
    } catch {
      // A list failure keeps the last good view.
    }
  }, [api]);

  useEffect(() => {
    if (!api) return undefined;
    void refresh();
    const off = api.onChanged(() => void refresh());
    return off;
  }, [api, refresh]);

  if (!api) return null;

  const handleToggle = async (id: string, enabled: boolean) => {
    const [categoryPart, name] = id.split('/');
    setPending(id);
    setError(null);
    try {
      setView(await api.setEnabled({ category: categoryPart, name, enabled }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  };

  const handleUninstall = async (id: string) => {
    if (confirmingUninstall !== id) {
      setConfirmingUninstall(id);
      return;
    }
    setConfirmingUninstall(null);
    setError(null);
    const [categoryPart, name] = id.split('/');
    try {
      setView(await api.uninstall({ category: categoryPart, name }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleScan = async (subdirOverride?: string) => {
    setScanning(true);
    setError(null);
    try {
      const request =
        mode === 'local'
          ? { source: 'local' as const, path: localPath.trim() }
          : {
              source: 'git' as const,
              url: gitUrl.trim(),
              ...((subdirOverride ?? gitSubdir).trim() ? { subdir: (subdirOverride ?? gitSubdir).trim() } : {}),
            };
      const result = await api.scan(request);
      setScan(result);
      if (subdirOverride !== undefined) setGitSubdir(subdirOverride);
    } catch (err) {
      setScan(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  const handleInstall = async () => {
    if (!scan) return;
    setInstalling(true);
    setError(null);
    try {
      const acknowledgeHigh = scan.report.verdict === 'review';
      const request =
        mode === 'local'
          ? { source: 'local' as const, path: localPath.trim(), category: category.trim(), acknowledgeHigh }
          : { source: 'prepared' as const, preparedId: scan.preparedId as string, category: category.trim(), acknowledgeHigh };
      const result = await api.install(request);
      if (result.installed) {
        setScan(null);
        setLocalPath('');
        setGitUrl('');
        setGitSubdir('');
      } else {
        setScan({ ...scan, report: result.report });
        setError(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <div className="flex flex-col gap-3" data-testid="settings-skills">
      <h2 className={cn(SETTINGS_SECTION_TITLE_CLASS, 'flex items-center gap-2')}>
        <Puzzle size={16} aria-hidden="true" /> Hermes Skills
      </h2>
      <p className={SETTINGS_ROW_HINT_CLASS}>
        Skills under the Cindy Hermes home; Hermes sessions pick them up on the next turn. The toggle moves a skill
        out of the scanned folder (nothing is deleted). <strong>Built-in</strong> skills ship with Hermes and are
        managed by Hermes updates. New skills are installed only after the security-scan report below has been shown.
      </p>
      <SkillsListView
        skills={view?.skills ?? []}
        pending={pending}
        confirmingUninstall={confirmingUninstall}
        onToggle={(id, enabled) => void handleToggle(id, enabled)}
        onUninstall={(id) => void handleUninstall(id)}
      />

      <div className={cn(SETTINGS_CARD_CLASS, 'flex flex-col gap-2 p-3')} data-testid="skills-install-form">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={cn(BUTTON_CLASS, mode === 'local' ? 'border-[var(--accent)] text-[var(--text-primary)]' : undefined)}
            onClick={() => {
              setMode('local');
              setScan(null);
            }}
            data-testid="skills-mode-local"
          >
            <FolderOpen size={11} aria-hidden="true" /> Local folder
          </button>
          <button
            type="button"
            className={cn(BUTTON_CLASS, mode === 'git' ? 'border-[var(--accent)] text-[var(--text-primary)]' : undefined)}
            onClick={() => {
              setMode('git');
              setScan(null);
            }}
            data-testid="skills-mode-git"
          >
            <GitBranch size={11} aria-hidden="true" /> Git URL
          </button>
        </div>
        {mode === 'local' ? (
          <input
            className={INPUT_CLASS}
            placeholder="/path/to/skill-folder"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            data-testid="skills-local-path"
          />
        ) : (
          <>
            <input
              className={INPUT_CLASS}
              placeholder="https://github.com/user/repo.git"
              value={gitUrl}
              onChange={(e) => setGitUrl(e.target.value)}
              data-testid="skills-git-url"
            />
            <input
              className={INPUT_CLASS}
              placeholder="Subdirectory (optional, for repos with several skills)"
              value={gitSubdir}
              onChange={(e) => setGitSubdir(e.target.value)}
              data-testid="skills-git-subdir"
            />
          </>
        )}
        <div className="flex items-center gap-2">
          <input
            className={cn(INPUT_CLASS, 'w-40')}
            placeholder="community"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            aria-label="Install category"
            data-testid="skills-category"
          />
          <button
            type="button"
            className={BUTTON_CLASS}
            disabled={scanning || (mode === 'local' ? localPath.trim() === '' : gitUrl.trim() === '')}
            onClick={() => void handleScan()}
            data-testid="skills-scan-button"
          >
            <Search size={11} aria-hidden="true" />
            {scanning ? 'Scanning…' : 'Scan'}
          </button>
        </div>
      </div>

      {scan?.candidates && scan.candidates.length > 0 ? (
        <div className={cn(SETTINGS_CARD_CLASS, 'flex flex-col gap-1 p-3')} data-testid="skills-candidates">
          <span className={SETTINGS_ROW_HINT_CLASS}>This repo contains several skills. Pick one:</span>
          {scan.candidates.map((candidate) => (
            <button
              key={candidate}
              type="button"
              className={cn(BUTTON_CLASS, 'self-start font-mono')}
              onClick={() => void handleScan(candidate)}
              data-testid={`skills-candidate-${skillsTestIdSuffix(candidate)}`}
            >
              {candidate}/
            </button>
          ))}
        </div>
      ) : null}

      {scan && !scan.candidates ? (
        <ScanReportView report={scan.report} installing={installing} onInstall={() => void handleInstall()} />
      ) : null}

      {error ? (
        <div role="alert" className="rounded-lg border border-red-500/40 px-3 py-2 text-12 text-red-500">
          {error}
        </div>
      ) : null}
    </div>
  );
}
