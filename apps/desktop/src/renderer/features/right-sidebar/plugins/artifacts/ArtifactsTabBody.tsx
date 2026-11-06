import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { Layers, FileText, ExternalLink, Copy, Check, Eye } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { makerChatStore } from '@/lib/makerChatStore';
import { collectGeneratedFiles, type GeneratedFileRef } from '@/lib/generatedFiles';
import type { TabKindBodyProps } from '../../types';

export function ArtifactsTabBody({ ctx }: TabKindBodyProps) {
  const { t } = useTranslation();
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const subscribe = useCallback(
    (cb: () => void) => makerChatStore.subscribe(ctx.sessionId, cb),
    [ctx.sessionId],
  );

  // Subscribe to makerChatStore for the session messages
  const messages = useSyncExternalStore(
    subscribe,
    () => makerChatStore.getSnapshot(ctx.sessionId).messages,
  );

  const artifacts: GeneratedFileRef[] = useMemo(() => {
    if (!messages || messages.length === 0) return [];
    return collectGeneratedFiles(messages, ctx.workdir);
  }, [messages, ctx.workdir]);

  const copyPath = (path: string) => {
    void navigator.clipboard.writeText(path);
    setCopiedPath(path);
    setTimeout(() => setCopiedPath(null), 2000);
  };

  const handleOpen = (path: string) => {
    if (window.electronAPI?.openPath) {
      void window.electronAPI.openPath(path);
    }
  };

  const handleReveal = (path: string) => {
    if (window.electronAPI?.showItemInFolder) {
      void window.electronAPI.showItemInFolder({ filePath: path });
    }
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground text-xs">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <Layers className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">Artifacts & Files</span>
          <span className="ml-1 rounded-full bg-secondary/70 px-2 py-0.5 text-[10px] text-muted-foreground font-mono">
            {artifacts.length}
          </span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {artifacts.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-border/80 p-8 text-center text-muted-foreground">
            <Layers className="mb-2 h-8 w-8 text-muted-foreground/50" />
            <div className="font-medium text-foreground">No artifacts generated yet</div>
            <p className="mt-1 text-[11px] leading-relaxed max-w-[260px]">
              Files, scripts, diagrams, and documents created by the agent during this conversation will appear here for fast inspection.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider px-1">
              Generated Files ({artifacts.length})
            </div>

            {artifacts.map((file) => {
              const fileName = file.name || file.path.split('/').pop() || file.path;
              const sourceLabel = file.source === 'tool' ? 'Tool generated' : 'Command generated';

              return (
                <div
                  key={file.path}
                  className="group relative rounded-lg border border-border/70 p-2.5 transition-all hover:border-border bg-card/50"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <FileText className="h-4 w-4 shrink-0 text-primary" />
                        <span className="font-semibold text-foreground truncate" title={fileName}>
                          {fileName}
                        </span>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="rounded bg-muted px-1.5 py-0.2 font-mono">
                          {sourceLabel}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        onClick={() => copyPath(file.path)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Copy file path"
                        aria-label="Copy file path"
                      >
                        {copiedPath === file.path ? <Check className="h-3.5 w-3.5 text-emerald-500" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleReveal(file.path)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Reveal in Finder / Explorer"
                        aria-label="Reveal in Finder / Explorer"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleOpen(file.path)}
                        className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                        title="Open file"
                        aria-label="Open file"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>

                  <div className="mt-2 border-t border-border/40 pt-1.5 text-[10px] text-muted-foreground font-mono truncate" title={file.path}>
                    {file.path}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
