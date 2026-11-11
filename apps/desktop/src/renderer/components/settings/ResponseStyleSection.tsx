/**
 * ResponseStyleSection — Settings → Personalization: how a transcript renders (ROADMAP 10.2).
 *
 * Nothing here is stored in the session: the preference only decides how tool rows and thinking
 * blocks are drawn, and a change reaches every open chat through `useResponsePreferences`.
 */

import { useTranslation } from 'react-i18next';

import {
  useResponsePreferences,
  writeResponsePreferences,
  type ResponseStyle,
  type ThinkingDisplay,
} from '@/lib/responsePreferences';
import { SETTINGS_ROW_CLASS, SETTINGS_ROW_HINT_CLASS, SETTINGS_ROW_LABEL_CLASS } from './settingsRowClasses';

const STYLES: ResponseStyle[] = ['concise', 'detailed'];
const DISPLAYS: ThinkingDisplay[] = ['collapsed', 'expanded', 'hidden'];

export function ResponseStyleSection() {
  const { t } = useTranslation();
  const preferences = useResponsePreferences();

  return (
    <div className={`${SETTINGS_ROW_CLASS} flex-col items-start gap-3`} data-testid="response-style-section">
      <div className="flex min-w-0 flex-col gap-1">
        <span className={SETTINGS_ROW_LABEL_CLASS}>{t('settings.responseStyle.title')}</span>
        <span className={SETTINGS_ROW_HINT_CLASS}>{t('settings.responseStyle.description')}</span>
      </div>

      <div className="flex w-full flex-wrap items-end gap-6">
        <label className="flex min-w-[220px] flex-col gap-1.5">
          <span className="text-12 text-[var(--text-secondary)]">{t('settings.responseStyle.styleLabel')}</span>
          <select
            className="h-8 rounded-md border border-[var(--border-default)] bg-[var(--surface-raised)] px-2 text-13 text-[var(--text-primary)]"
            value={preferences.responseStyle}
            onChange={(event) => writeResponsePreferences({ responseStyle: event.target.value as ResponseStyle })}
          >
            {STYLES.map((value) => (
              <option key={value} value={value}>
                {t(`settings.responseStyle.styles.${value}`)}
              </option>
            ))}
          </select>
          <span className={SETTINGS_ROW_HINT_CLASS}>{t(`settings.responseStyle.styleHint.${preferences.responseStyle}`)}</span>
        </label>

        <label className="flex min-w-[220px] flex-col gap-1.5">
          <span className="text-12 text-[var(--text-secondary)]">{t('settings.responseStyle.thinkingLabel')}</span>
          <select
            className="h-8 rounded-md border border-[var(--border-default)] bg-[var(--surface-raised)] px-2 text-13 text-[var(--text-primary)]"
            value={preferences.thinkingDisplay}
            onChange={(event) => writeResponsePreferences({ thinkingDisplay: event.target.value as ThinkingDisplay })}
          >
            {DISPLAYS.map((value) => (
              <option key={value} value={value}>
                {t(`settings.responseStyle.thinking.${value}`)}
              </option>
            ))}
          </select>
          <span className={SETTINGS_ROW_HINT_CLASS}>{t('settings.responseStyle.thinkingHint')}</span>
        </label>
      </div>
    </div>
  );
}
