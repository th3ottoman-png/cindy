import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Folder, FolderOpen } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

export interface SessionMarkdownExportDialogProps {
  open: boolean;
  sessionId: string;
  onOpenChange: (open: boolean) => void;
}

export function SessionMarkdownExportDialog({
  open,
  sessionId,
  onOpenChange,
}: SessionMarkdownExportDialogProps) {
  const [vaultDir, setVaultDir] = useState<string | null>(null);
  const [vaultIssue, setVaultIssue] = useState<string | null>(null);
  const [mode, setMode] = useState<'vault' | 'custom'>('vault');
  const [customDir, setCustomDir] = useState<string>('');
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    window.electronAPI.maker.vault
      .getConfig()
      .then((cfg) => {
        if (cfg?.vaultDir) {
          setVaultDir(cfg.vaultDir);
          setVaultIssue(cfg.issue ?? null);
          setMode(cfg.issue ? 'custom' : 'vault');
        } else {
          setVaultDir(null);
          setVaultIssue(null);
          setMode('custom');
        }
      })
      .catch(() => {
        setVaultDir(null);
        setMode('custom');
      });
  }, [open]);

  const handlePickFolder = useCallback(async () => {
    try {
      const picked = await window.electronAPI.maker.sessionExport.pickFolder();
      if (picked) {
        setCustomDir(picked);
        setMode('custom');
        setError(null);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const handleExport = useCallback(async () => {
    const targetDir = mode === 'vault' ? vaultDir : customDir;
    if (!targetDir) {
      setError('Please select a destination directory.');
      return;
    }

    setExporting(true);
    setError(null);

    try {
      const result = await window.electronAPI.maker.sessionExport.exportMarkdown({
        sessionId,
        targetDir,
      });

      if (!result.ok) {
        setError(result.message || 'Export failed.');
        setExporting(false);
        return;
      }

      toast.success(`Exported ${result.fileName}`);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(false);
    }
  }, [customDir, mode, onOpenChange, sessionId, vaultDir]);

  const activeTarget = mode === 'vault' ? vaultDir : customDir;
  const canSubmit = !exporting && Boolean(activeTarget);

  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay
          className={cn('modal-scrim fixed inset-0 z-[10000]')}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
        />
        <AlertDialog.Content
          className={cn(
            'modal-panel fixed left-1/2 top-1/2 z-[10000] -translate-x-1/2 -translate-y-1/2',
            'w-full max-w-[460px] p-5 rounded-lg border border-[var(--border-default)] shadow-lg',
          )}
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onEscapeKeyDown={(e) => {
            if (exporting) e.preventDefault();
          }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <AlertDialog.Title className="text-base font-semibold text-[var(--confirm-title)]">
            Export to Markdown
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-sm text-[var(--confirm-desc)]">
            Export this conversation to Markdown with tool calls collapsed. Choose a destination folder.
          </AlertDialog.Description>

          <div className="mt-4 flex flex-col gap-3">
            {/* Notes Vault Option */}
            <label
              className={cn(
                'flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors',
                mode === 'vault'
                  ? 'border-[var(--brand-primary,#3b82f6)] bg-[var(--surface-active,#f8fafc)]'
                  : 'border-[var(--border-default)] hover:bg-[var(--surface-hover,#f1f5f9)]',
                !vaultDir && 'opacity-60 cursor-not-allowed',
              )}
            >
              <input
                type="radio"
                name="export-destination"
                value="vault"
                checked={mode === 'vault'}
                onChange={() => vaultDir && setMode('vault')}
                disabled={exporting || !vaultDir}
                className="mt-1"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Folder size={15} className="text-[var(--text-secondary)]" />
                  <span className="text-sm font-medium text-[var(--confirm-title)]">
                    Notes Vault
                  </span>
                </div>
                {vaultDir ? (
                  <p className="mt-0.5 truncate text-xs text-[var(--text-secondary)] font-mono">
                    {vaultDir}
                  </p>
                ) : (
                  <p className="mt-0.5 text-xs text-[var(--text-tertiary)] italic">
                    No vault configured (Settings → General → Notes Vault)
                  </p>
                )}
                {vaultIssue && (
                  <p className="mt-1 text-xs text-[var(--error-fg)]">
                    Vault issue: {vaultIssue}
                  </p>
                )}
              </div>
            </label>

            {/* Custom Folder Option */}
            <label
              className={cn(
                'flex items-start gap-3 p-3 rounded-md border cursor-pointer transition-colors',
                mode === 'custom'
                  ? 'border-[var(--brand-primary,#3b82f6)] bg-[var(--surface-active,#f8fafc)]'
                  : 'border-[var(--border-default)] hover:bg-[var(--surface-hover,#f1f5f9)]',
              )}
            >
              <input
                type="radio"
                name="export-destination"
                value="custom"
                checked={mode === 'custom'}
                onChange={() => setMode('custom')}
                disabled={exporting}
                className="mt-1"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <FolderOpen size={15} className="text-[var(--text-secondary)]" />
                    <span className="text-sm font-medium text-[var(--confirm-title)]">
                      Custom folder
                    </span>
                  </div>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    compact
                    onClick={(e) => {
                      e.preventDefault();
                      void handlePickFolder();
                    }}
                    disabled={exporting}
                  >
                    Browse...
                  </Button>
                </div>
                {customDir ? (
                  <p className="mt-1.5 truncate text-xs text-[var(--text-secondary)] font-mono">
                    {customDir}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-[var(--text-tertiary)] italic">
                    Click Browse to select a destination directory
                  </p>
                )}
              </div>
            </label>
          </div>

          {error && (
            <p className="mt-3 text-xs text-[var(--error-fg,#ef4444)]">
              {error}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button
                variant="secondary"
                size="md"
                compact
                palette="confirmation"
                type="button"
                disabled={exporting}
              >
                Cancel
              </Button>
            </AlertDialog.Cancel>
            <Button
              variant="primary"
              size="md"
              compact
              palette="confirmation"
              type="button"
              disabled={!canSubmit}
              onClick={() => void handleExport()}
            >
              {exporting ? (
                <span className="flex items-center gap-1.5">
                  <Spinner size={14} /> Exporting...
                </span>
              ) : (
                'Export'
              )}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
