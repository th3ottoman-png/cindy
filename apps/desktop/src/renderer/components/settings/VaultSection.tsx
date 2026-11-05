import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, Check, FolderOpen } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { VaultConfigView } from '../../../main/maker-ipc/vaultNotes';

import {
  SETTINGS_CARD_CLASS,
  SETTINGS_ROW_CLASS,
  SETTINGS_ROW_HINT_CLASS,
  SETTINGS_ROW_LABEL_CLASS,
  SETTINGS_SECTION_TITLE_CLASS,
} from './settingsRowClasses';

export function VaultView({
  config,
  saving,
  onSave,
  onPickFolder,
}: {
  config: VaultConfigView;
  saving: boolean;
  onSave: (vaultDir: string) => void;
  onPickFolder: () => void;
}) {
  const [draftDir, setDraftDir] = useState(config.vaultDir ?? '');

  useEffect(() => {
    setDraftDir(config.vaultDir ?? '');
  }, [config.vaultDir]);

  const hasChanged = draftDir.trim() !== (config.vaultDir ?? '').trim();

  return (
    <div className="flex flex-col gap-3" data-testid="settings-vault">
      <div className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <BookOpen size={18} className="text-[var(--text-secondary)]" aria-hidden="true" />
          <h2 className={SETTINGS_SECTION_TITLE_CLASS}>Notes Vault</h2>
        </div>
        <p className={SETTINGS_ROW_HINT_CLASS}>
          Point the harness at a local folder of Markdown notes (Obsidian vault). Experts with notes tools in tools.yaml can read, search, and append notes.
        </p>
      </div>

      {config.issue && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-12 text-amber-200"
        >
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-400" aria-hidden="true" />
          <div className="flex flex-col gap-0.5">
            <span className="font-medium text-amber-300">Vault Configuration Issue</span>
            <span>{config.issue}</span>
          </div>
        </div>
      )}

      <div className={SETTINGS_CARD_CLASS}>
        <div className={SETTINGS_ROW_CLASS}>
          <div className="flex flex-col gap-1.5 flex-1 min-w-0 pr-4">
            <span className={SETTINGS_ROW_LABEL_CLASS}>Vault Folder</span>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={draftDir}
                onChange={(e) => setDraftDir(e.target.value)}
                placeholder="/path/to/notes/vault"
                className={cn(
                  'w-full rounded-md border px-3 py-1.5 text-12',
                  'bg-[var(--input-bg)] border-[var(--input-border)] text-[var(--text-primary)]',
                  'focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)]',
                )}
                data-testid="vault-dir-input"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={onPickFolder}
                disabled={saving}
                className="shrink-0 flex items-center gap-1.5"
                title="Browse folder"
              >
                <FolderOpen size={14} aria-hidden="true" />
                <span>Browse…</span>
              </Button>
            </div>
            {config.vaultDir && !config.issue && (
              <span className="text-11 text-emerald-400 flex items-center gap-1 mt-0.5">
                <Check size={12} aria-hidden="true" />
                <span>Connected {config.noteCount !== undefined ? `(${config.noteCount} note${config.noteCount === 1 ? '' : 's'})` : ''}</span>
              </span>
            )}
          </div>
          <div className="shrink-0 flex items-center">
            <Button
              size="sm"
              onClick={() => onSave(draftDir)}
              disabled={!hasChanged || saving}
              data-testid="vault-save-button"
            >
              {saving ? <Spinner size="sm" /> : 'Save'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function VaultSection() {
  const [config, setConfig] = useState<VaultConfigView | null>(null);
  const [saving, setSaving] = useState(false);

  const fetchConfig = useCallback(async () => {
    if (!window.electronAPI?.maker?.vault?.getConfig) return;
    try {
      const res = await window.electronAPI.maker.vault.getConfig();
      setConfig(res);
    } catch {
      // Ignore initial read failure
    }
  }, []);

  useEffect(() => {
    void fetchConfig();
    return window.electronAPI?.maker?.vault?.onChanged?.((fresh) => {
      setConfig(fresh);
    });
  }, [fetchConfig]);

  const handleSave = useCallback(
    async (vaultDir: string) => {
      if (!window.electronAPI?.maker?.vault?.setConfig) return;
      setSaving(true);
      try {
        const fresh = await window.electronAPI.maker.vault.setConfig(vaultDir);
        setConfig(fresh);
        toast.success('Vault path saved');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to save vault path');
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  const handlePickFolder = useCallback(async () => {
    if (!window.electronAPI?.maker?.vault?.pickFolder) return;
    try {
      const picked = await window.electronAPI.maker.vault.pickFolder();
      if (picked) {
        await handleSave(picked);
      }
    } catch {
      // User cancelled or picker failed
    }
  }, [handleSave]);

  if (!config) {
    return (
      <div className="flex items-center justify-center p-6 text-[var(--text-tertiary)]">
        <Spinner size="md" />
      </div>
    );
  }

  return (
    <VaultView
      config={config}
      saving={saving}
      onSave={handleSave}
      onPickFolder={handlePickFolder}
    />
  );
}
