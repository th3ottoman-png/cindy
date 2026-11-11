/**
 * SecurityGuardSection — Settings → Personalization: the injection guard's threshold and policy
 * (ROADMAP 10.1). The host owns `~/.cindy-harness/security.json`; this card only reads and submits.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { SETTINGS_ROW_CLASS, SETTINGS_ROW_HINT_CLASS, SETTINGS_ROW_LABEL_CLASS } from './settingsRowClasses';

type Policy = 'off' | 'log' | 'hold' | 'block';

const POLICIES: Policy[] = ['hold', 'block', 'log', 'off'];

export function SecurityGuardSection() {
  const { t } = useTranslation();
  const [policy, setPolicy] = useState<Policy>('hold');
  const [threshold, setThreshold] = useState(0.8);
  const [issue, setIssue] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.electronAPI.maker.securityGuard
      .getConfig()
      .then((res) => {
        if (cancelled) return;
        setPolicy(res.config.policy);
        setThreshold(res.config.threshold);
        setIssue(res.issue);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const save = useCallback(
    async (patch: { policy?: Policy; threshold?: number }) => {
      setSaving(true);
      try {
        const res = await window.electronAPI.maker.securityGuard.setConfig(patch);
        setPolicy(res.config.policy);
        setThreshold(res.config.threshold);
        setIssue(res.issue);
        toast.success(t('settings.securityGuard.saved'));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : t('settings.securityGuard.failed'));
      } finally {
        setSaving(false);
      }
    },
    [t],
  );

  return (
    <div className={`${SETTINGS_ROW_CLASS} flex-col items-start gap-3`} data-testid="security-guard-section">
      <div className="flex min-w-0 flex-col gap-1">
        <span className={SETTINGS_ROW_LABEL_CLASS}>{t('settings.securityGuard.title')}</span>
        <span className={SETTINGS_ROW_HINT_CLASS}>{t('settings.securityGuard.description')}</span>
      </div>

      <div className="flex w-full flex-wrap items-end gap-6">
        <label className="flex min-w-[220px] flex-col gap-1.5">
          <span className="text-12 text-[var(--text-secondary)]">{t('settings.securityGuard.policyLabel')}</span>
          <select
            className="h-8 rounded-md border border-[var(--border-default)] bg-[var(--surface-raised)] px-2 text-13 text-[var(--text-primary)]"
            value={policy}
            disabled={saving}
            onChange={(event) => void save({ policy: event.target.value as Policy })}
          >
            {POLICIES.map((value) => (
              <option key={value} value={value}>
                {t(`settings.securityGuard.policy.${value}`)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex w-[160px] flex-col gap-1.5">
          <span className="text-12 text-[var(--text-secondary)]">{t('settings.securityGuard.thresholdLabel')}</span>
          <input
            type="number"
            min={0.01}
            max={1}
            step={0.05}
            className="h-8 rounded-md border border-[var(--border-default)] bg-[var(--surface-raised)] px-2 text-13 text-[var(--text-primary)]"
            value={threshold}
            disabled={saving}
            onChange={(event) => setThreshold(Number(event.target.value))}
            onBlur={() => void save({ threshold })}
          />
        </label>
      </div>

      <span className={SETTINGS_ROW_HINT_CLASS}>{t('settings.securityGuard.thresholdHint')}</span>
      {issue ? <span className="text-12 text-[var(--status-warning)]">{issue}</span> : null}
    </div>
  );
}
