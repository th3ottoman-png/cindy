import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BookOpen, Check, FolderOpen } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import type { ChatAutosaveView } from '../../../main/maker-ipc/chatAutosave';
import type { ChatSummaryView } from '../../../main/maker-ipc/chatSummary';
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
  onToggleSearch,
  onPickFolder,
}: {
  config: VaultConfigView;
  saving: boolean;
  onSave: (vaultDir: string) => void;
  onToggleSearch?: (enabled: boolean) => void;
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
        <div className={SETTINGS_ROW_CLASS}>
          <div className="flex flex-col gap-1 flex-1 min-w-0 pr-4">
            <span className={SETTINGS_ROW_LABEL_CLASS}>Vault search in standard chats</span>
            <span className={SETTINGS_ROW_HINT_CLASS}>
              Allow Hermes to search and read notes from the vault in all chats, not only expert sessions. Append and edit operations remain strictly restricted to experts.
            </span>
          </div>
          <Switch
            checked={Boolean(config.allSessionsSearch)}
            disabled={saving || !config.vaultDir}
            onCheckedChange={(checked) => onToggleSearch?.(checked)}
            aria-label="Toggle vault search in standard chats"
          />
        </div>
      </div>
    </div>
  );
}

/** ROADMAP 5.5: "Auto-save chats" card under the vault settings. Pure props for tests. */
export function ChatAutosaveCard({
  view,
  saving,
  onToggle,
  onSaveFolder,
}: {
  view: ChatAutosaveView;
  saving: boolean;
  onToggle: (enabled: boolean) => void;
  onSaveFolder: (folder: string) => void;
}) {
  const [draftFolder, setDraftFolder] = useState(view.folder);

  useEffect(() => {
    setDraftFolder(view.folder);
  }, [view.folder]);

  const folderChanged = draftFolder.trim() !== view.folder.trim();
  const noVault = !view.vaultDir;

  return (
    <div className={SETTINGS_CARD_CLASS} data-testid="settings-chat-autosave">
      <div className={SETTINGS_ROW_CLASS}>
        <div className="flex flex-col gap-1 flex-1 min-w-0 pr-4">
          <span className={SETTINGS_ROW_LABEL_CLASS}>Auto-save chats</span>
          <span className={SETTINGS_ROW_HINT_CLASS}>
            After each turn, every conversation is written as one Markdown file in this folder of
            the vault and rewritten as it grows. Edits to those files are overwritten: copy a note
            before editing it.
          </span>
        </div>
        <Switch
          checked={view.enabled}
          disabled={saving}
          onCheckedChange={(v) => onToggle(v)}
          aria-label={view.enabled ? 'Turn chat auto-save off' : 'Turn chat auto-save on'}
        />
      </div>
      <div className={SETTINGS_ROW_CLASS}>
        <div className="flex flex-col gap-1.5 flex-1 min-w-0 pr-4">
          <span className={SETTINGS_ROW_LABEL_CLASS}>Folder in the vault</span>
          <input
            type="text"
            value={draftFolder}
            onChange={(e) => setDraftFolder(e.target.value)}
            placeholder="Cindy/Chats"
            className={cn(
              'w-full rounded-md border px-3 py-1.5 text-12',
              'bg-[var(--input-bg)] border-[var(--input-border)] text-[var(--text-primary)]',
              'focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)]',
            )}
            data-testid="chat-autosave-folder-input"
          />
          {view.issue && <span className="text-11 text-amber-400">{view.issue}</span>}
          {view.enabled && noVault && (
            <span className="text-11 text-amber-400">
              No vault folder is set above, so nothing is saved yet.
            </span>
          )}
          {view.lastError && (
            <span className="text-11 text-red-400">Last save failed: {view.lastError}</span>
          )}
          {view.lastSavedPath && !view.lastError && (
            <span className="text-11 text-emerald-400 flex items-center gap-1">
              <Check size={12} aria-hidden="true" />
              <span>Last saved: {view.lastSavedPath}</span>
            </span>
          )}
        </div>
        <div className="shrink-0 flex items-center">
          <Button
            size="sm"
            onClick={() => onSaveFolder(draftFolder)}
            disabled={!folderChanged || saving}
            data-testid="chat-autosave-folder-save"
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChatAutosaveSettings() {
  const [view, setView] = useState<ChatAutosaveView | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.maker?.chatAutosave?.getConfig) return;
    try {
      setView(await window.electronAPI.maker.chatAutosave.getConfig());
    } catch {
      // Ignore read failure; the card stays hidden.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const offVault = window.electronAPI?.maker?.vault?.onChanged?.(() => void refresh());
    const offFailed = window.electronAPI?.maker?.chatAutosave?.onFailed?.(() => void refresh());
    return () => {
      offVault?.();
      offFailed?.();
    };
  }, [refresh]);

  const save = useCallback(async (patch: { enabled?: boolean; folder?: string }) => {
    if (!window.electronAPI?.maker?.chatAutosave?.setConfig) return;
    setSaving(true);
    try {
      setView(await window.electronAPI.maker.chatAutosave.setConfig(patch));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save auto-save settings');
    } finally {
      setSaving(false);
    }
  }, []);

  if (!view) return null;
  return (
    <ChatAutosaveCard
      view={view}
      saving={saving}
      onToggle={(enabled) => void save({ enabled })}
      onSaveFolder={(folder) => void save({ folder })}
    />
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

  const handleToggleSearch = useCallback(
    async (allSessionsSearch: boolean) => {
      if (!window.electronAPI?.maker?.vault?.setConfig) return;
      setSaving(true);
      try {
        const fresh = await window.electronAPI.maker.vault.setConfig({ allSessionsSearch });
        setConfig(fresh);
        toast.success(allSessionsSearch ? 'Vault search enabled for all chats' : 'Vault search restricted to experts');
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to update vault setting');
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
    <div className="flex flex-col gap-3">
      <VaultView
        config={config}
        saving={saving}
        onSave={handleSave}
        onToggleSearch={handleToggleSearch}
        onPickFolder={handlePickFolder}
      />
      <ChatAutosaveSettings />
      <ChatSummarySettings />
    </div>
  );
}

export function ChatSummaryCard({
  view,
  saving,
  onToggle,
  onSaveConfig,
}: {
  view: ChatSummaryView;
  saving: boolean;
  onToggle: (enabled: boolean) => void;
  onSaveConfig: (patch: { folder?: string; idleMinutes?: number }) => void;
}) {
  const [draftFolder, setDraftFolder] = useState(view.folder);
  const [draftIdle, setDraftIdle] = useState(String(view.idleMinutes ?? 10));

  useEffect(() => {
    setDraftFolder(view.folder);
    setDraftIdle(String(view.idleMinutes ?? 10));
  }, [view.folder, view.idleMinutes]);

  const changed =
    draftFolder.trim() !== view.folder.trim() ||
    parseInt(draftIdle, 10) !== view.idleMinutes;
  const noVault = !view.vaultDir;

  const handleSave = () => {
    const idleNum = parseInt(draftIdle, 10);
    onSaveConfig({
      folder: draftFolder,
      idleMinutes: Number.isInteger(idleNum) ? idleNum : view.idleMinutes,
    });
  };

  return (
    <div className={SETTINGS_CARD_CLASS} data-testid="settings-chat-summary">
      <div className={SETTINGS_ROW_CLASS}>
        <div className="flex flex-col gap-1 flex-1 min-w-0 pr-4">
          <span className={SETTINGS_ROW_LABEL_CLASS}>Auto-summary</span>
          <span className={SETTINGS_ROW_HINT_CLASS}>
            After a conversation is idle or closed, the routed summary model writes a short Markdown note
            of decisions, facts learned, open questions, and next steps to this folder in the vault.
          </span>
        </div>
        <Switch
          checked={view.enabled}
          disabled={saving}
          onCheckedChange={(v) => onToggle(v)}
          aria-label={view.enabled ? 'Turn auto-summary off' : 'Turn auto-summary on'}
        />
      </div>
      <div className={SETTINGS_ROW_CLASS}>
        <div className="flex flex-col gap-2 flex-1 min-w-0 pr-4">
          <div className="flex gap-3">
            <div className="flex-1">
              <span className={SETTINGS_ROW_LABEL_CLASS}>Folder in the vault</span>
              <input
                type="text"
                value={draftFolder}
                onChange={(e) => setDraftFolder(e.target.value)}
                placeholder="Cindy/Memory"
                className={cn(
                  'w-full rounded-md border px-3 py-1.5 text-12 mt-1',
                  'bg-[var(--input-bg)] border-[var(--input-border)] text-[var(--text-primary)]',
                  'focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)]',
                )}
                data-testid="chat-summary-folder-input"
              />
            </div>
            <div className="w-28">
              <span className={SETTINGS_ROW_LABEL_CLASS}>Idle (minutes)</span>
              <input
                type="number"
                min={1}
                max={1440}
                value={draftIdle}
                onChange={(e) => setDraftIdle(e.target.value)}
                className={cn(
                  'w-full rounded-md border px-3 py-1.5 text-12 mt-1',
                  'bg-[var(--input-bg)] border-[var(--input-border)] text-[var(--text-primary)]',
                  'focus:outline-none focus:ring-1 focus:ring-[var(--focus-ring)]',
                )}
                data-testid="chat-summary-idle-input"
              />
            </div>
          </div>
          {view.issue && <span className="text-11 text-amber-400">{view.issue}</span>}
          {view.enabled && noVault && (
            <span className="text-11 text-amber-400">
              No vault folder is set above, so nothing is saved yet.
            </span>
          )}
          {view.lastError && (
            <span className="text-11 text-red-400">Last summary failed: {view.lastError}</span>
          )}
          {view.lastSummaryPath && !view.lastError && (
            <span className="text-11 text-emerald-400 flex items-center gap-1">
              <Check size={12} aria-hidden="true" />
              <span>
                Last summary: {view.lastSummaryPath}
                {view.lastSummaryModel ? ` (${view.lastSummaryModel})` : ''}
              </span>
            </span>
          )}
        </div>
        <div className="shrink-0 flex items-center">
          <Button
            size="sm"
            onClick={handleSave}
            disabled={!changed || saving}
            data-testid="chat-summary-save"
          >
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

function ChatSummarySettings() {
  const [view, setView] = useState<ChatSummaryView | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!window.electronAPI?.maker?.chatSummary?.getConfig) return;
    try {
      setView(await window.electronAPI.maker.chatSummary.getConfig());
    } catch {
      // Ignore read failure; the card stays hidden.
    }
  }, []);

  useEffect(() => {
    void refresh();
    const offVault = window.electronAPI?.maker?.vault?.onChanged?.(() => void refresh());
    const offWritten = window.electronAPI?.maker?.chatSummary?.onWritten?.(() => void refresh());
    const offFailed = window.electronAPI?.maker?.chatSummary?.onFailed?.(() => void refresh());
    return () => {
      offVault?.();
      offWritten?.();
      offFailed?.();
    };
  }, [refresh]);

  const save = useCallback(async (patch: { enabled?: boolean; folder?: string; idleMinutes?: number }) => {
    if (!window.electronAPI?.maker?.chatSummary?.setConfig) return;
    setSaving(true);
    try {
      setView(await window.electronAPI.maker.chatSummary.setConfig(patch));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save auto-summary settings');
    } finally {
      setSaving(false);
    }
  }, []);

  if (!view) return null;
  return (
    <ChatSummaryCard
      view={view}
      saving={saving}
      onToggle={(enabled) => void save({ enabled })}
      onSaveConfig={(patch) => void save(patch)}
    />
  );
}
