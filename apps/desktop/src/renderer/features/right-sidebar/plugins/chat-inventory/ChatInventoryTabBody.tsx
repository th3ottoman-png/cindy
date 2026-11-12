import React, { useCallback, useEffect, useState } from 'react';
import {
  Boxes,
  Wrench,
  FileText,
  Sparkles,
  Cpu,
  RefreshCw,
  FolderOpen,
  CheckCircle2,
  AlertCircle,
  Hash,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { makerChatStore } from '@/lib/makerChatStore';
import {
  aggregateChatInventory,
  type ChatInventory,
} from '@cindy/maker-core/chat-inventory';
import type { TabKindBodyProps } from '../../types';
import { TurnAuditPanel } from './TurnAuditPanel';

function ChatInventoryOverview({ ctx }: TabKindBodyProps) {
  const { t } = useTranslation();
  const [inventory, setInventory] = useState<ChatInventory | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchInventory = useCallback(async () => {
    if (!ctx.sessionId) return;
    setLoading(true);
    setError(null);

    try {
      if (window.electronAPI?.maker?.chatInventory) {
        const res = await window.electronAPI.maker.chatInventory.get({ sessionId: ctx.sessionId });
        if (res.ok && res.inventory) {
          setInventory(res.inventory);
          setLoading(false);
          return;
        }
      }

      // Fallback to local snapshot from makerChatStore
      const snapshot = makerChatStore.getSnapshot(ctx.sessionId);
      const sessionInput = {
        id: ctx.sessionId,
        contextWindow: 200_000,
      };
      const inv = aggregateChatInventory(sessionInput, (snapshot?.messages || []) as any);
      setInventory(inv);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ctx.sessionId]);

  useEffect(() => {
    void fetchInventory();
  }, [fetchInventory]);

  // Subscribe to makerChatStore for live turn updates
  useEffect(() => {
    if (!ctx.sessionId) return undefined;
    return makerChatStore.subscribe(ctx.sessionId, () => {
      void fetchInventory();
    });
  }, [ctx.sessionId, fetchInventory]);

  const handleOpenFile = (filePath: string) => {
    if (window.electronAPI?.openPath) {
      void window.electronAPI.openPath(filePath);
    }
  };

  const handleRevealFile = (filePath: string) => {
    if (window.electronAPI?.showItemInFolder) {
      void window.electronAPI.showItemInFolder({ filePath });
    }
  };

  if (loading && !inventory) {
    return (
      <div className="flex h-full w-full items-center justify-center p-6 text-xs text-muted-foreground">
        <RefreshCw className="mr-2 h-4 w-4 animate-spin text-primary" />
        Auditing session resources...
      </div>
    );
  }

  if (error && !inventory) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center p-6 text-center text-xs text-destructive">
        <AlertCircle className="mb-2 h-6 w-6" />
        <span>Failed to load chat inventory: {error}</span>
      </div>
    );
  }

  const { tools, files, skills, connectors, tokens, summary } = inventory || {
    tools: [],
    files: [],
    skills: [],
    connectors: [],
    tokens: { promptTokens: 0, completionTokens: 0, totalTokens: 0, contextWindow: 200_000, utilizationPercent: 0 },
    summary: { totalToolCalls: 0, totalFilesTouched: 0, totalMessages: 0, turnCount: 0 },
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground text-xs" data-testid="chat-inventory-panel">
      {/* Top Header */}
      <div className="flex items-center justify-between border-b border-border/50 px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          <Boxes className="h-4 w-4 text-primary" />
          <span className="font-semibold text-sm">Chat Inventory</span>
        </div>
        <button
          type="button"
          onClick={() => void fetchInventory()}
          disabled={loading}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          title="Refresh inventory"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* Token & Context Breakdown Card */}
        <div className="rounded-lg border border-border/70 bg-card/60 p-3 shadow-xs">
          <div className="flex items-center justify-between text-[11px] font-medium text-muted-foreground mb-2">
            <span className="flex items-center gap-1.5">
              <Cpu className="h-3.5 w-3.5 text-primary" />
              Context & Token Utilization
            </span>
            <span className="font-mono text-foreground font-semibold">
              {tokens.utilizationPercent}%
            </span>
          </div>

          <div className="h-2 w-full overflow-hidden rounded-full bg-secondary/80 mb-2">
            <div
              className={cn(
                'h-full transition-all duration-300',
                tokens.utilizationPercent > 80
                  ? 'bg-amber-500'
                  : tokens.utilizationPercent > 95
                    ? 'bg-destructive'
                    : 'bg-primary',
              )}
              style={{ width: `${Math.min(100, tokens.utilizationPercent)}%` }}
            />
          </div>

          <div className="grid grid-cols-3 gap-2 text-center text-[10px] mt-2 pt-2 border-t border-border/40 font-mono">
            <div>
              <div className="text-muted-foreground">Prompt</div>
              <div className="font-semibold text-foreground">{tokens.promptTokens.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Completion</div>
              <div className="font-semibold text-foreground">{tokens.completionTokens.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-muted-foreground">Capacity</div>
              <div className="font-semibold text-foreground">{(tokens.contextWindow / 1000).toFixed(0)}k</div>
            </div>
          </div>
        </div>

        {/* Tools Invoked Section */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-muted-foreground px-1">
            <span className="flex items-center gap-1">
              <Wrench className="h-3 w-3 text-primary" />
              Tools Invoked ({summary.totalToolCalls})
            </span>
          </div>

          {tools.length === 0 ? (
            <div className="rounded border border-dashed border-border/60 p-3 text-center text-muted-foreground text-[11px]">
              No tools invoked in this session yet.
            </div>
          ) : (
            <div className="space-y-1">
              {tools.map((t) => (
                <div
                  key={t.name}
                  data-testid="inventory-tool-row"
                  className="flex items-center justify-between rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[9px] font-mono uppercase shrink-0',
                        t.category === 'file' && 'bg-blue-500/15 text-blue-400',
                        t.category === 'command' && 'bg-amber-500/15 text-amber-400',
                        t.category === 'mcp' && 'bg-purple-500/15 text-purple-400',
                        t.category === 'agent' && 'bg-emerald-500/15 text-emerald-400',
                        t.category === 'other' && 'bg-muted text-muted-foreground',
                      )}
                    >
                      {t.serverName || t.category}
                    </span>
                    <span className="font-mono text-foreground truncate text-[11px]" title={t.name}>
                      {t.name}
                    </span>
                  </div>
                  <span className="ml-2 rounded-full bg-secondary/80 px-2 py-0.5 text-[10px] font-mono text-muted-foreground shrink-0">
                    ×{t.count}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Files Touched Section */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-wider text-muted-foreground px-1">
            <span className="flex items-center gap-1">
              <FileText className="h-3 w-3 text-primary" />
              Files Touched ({files.length})
            </span>
          </div>

          {files.length === 0 ? (
            <div className="rounded border border-dashed border-border/60 p-3 text-center text-muted-foreground text-[11px]">
              No files read or modified in this session yet.
            </div>
          ) : (
            <div className="space-y-1">
              {files.map((f) => (
                <div
                  key={f.path}
                  data-testid="inventory-file-row"
                  className="group flex items-center justify-between rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5 hover:border-border transition-colors"
                >
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[9px] font-mono uppercase shrink-0',
                        f.action === 'created' && 'bg-emerald-500/20 text-emerald-400',
                        f.action === 'modified' && 'bg-blue-500/20 text-blue-400',
                        f.action === 'read' && 'bg-muted text-muted-foreground',
                      )}
                    >
                      {f.action}
                    </span>
                    <span className="font-mono text-foreground truncate text-[11px]" title={f.path}>
                      {f.name}
                    </span>
                  </div>

                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                    <button
                      type="button"
                      onClick={() => handleOpenFile(f.path)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      title="Open file"
                    >
                      <FileText className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRevealFile(f.path)}
                      className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                      title="Reveal in folder"
                    >
                      <FolderOpen className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Skills & Connectors Section */}
        <div className="space-y-1.5">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground px-1">
            <span className="flex items-center gap-1">
              <Sparkles className="h-3 w-3 text-primary" />
              Active Skills & Connectors
            </span>
          </div>

          <div className="rounded-lg border border-border/60 bg-card/40 p-2.5 space-y-2">
            <div>
              <div className="text-[10px] text-muted-foreground mb-1">Attached Skills</div>
              {skills.length === 0 ? (
                <div className="text-[11px] text-muted-foreground italic">None attached</div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {skills.map((s) => (
                    <span
                      key={s}
                      className="rounded bg-primary/10 border border-primary/20 px-2 py-0.5 font-mono text-[10px] text-primary"
                    >
                      {`@${s}`}
                    </span>
                  ))}
                </div>
              )}
            </div>

            <div className="pt-2 border-t border-border/40">
              <div className="text-[10px] text-muted-foreground mb-1">MCP Connectors</div>
              {connectors.length === 0 ? (
                <div className="text-[11px] text-muted-foreground italic">None active</div>
              ) : (
                <div className="flex flex-wrap gap-1">
                  {connectors.map((c) => (
                    <span
                      key={c}
                      className="rounded bg-secondary/80 border border-border/60 px-2 py-0.5 font-mono text-[10px] text-foreground"
                    >
                      {c}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

type InThisChatView = 'inventory' | 'audit';

/** ROADMAP 11.10: In This Chat = the 8.8 inventory plus the "Audit & Assumptions" view. */
export function ChatInventoryTabBody(props: TabKindBodyProps) {
  const [view, setView] = useState<InThisChatView>('inventory');
  const tabs: Array<{ id: InThisChatView; label: string }> = [
    { id: 'inventory', label: 'Inventory' },
    { id: 'audit', label: 'Audit & Assumptions' },
  ];
  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-background text-foreground text-xs">
      <div role="tablist" aria-label="In This Chat" className="flex gap-1 border-b border-border/50 px-2 pt-1.5">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={view === tab.id}
            onClick={() => setView(tab.id)}
            className={cn(
              'rounded-t px-2 py-1 text-[11px] font-medium',
              view === tab.id ? 'border-b-2 border-primary text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">
        {view === 'audit' && props.ctx.sessionId ? (
          <TurnAuditPanel sessionId={props.ctx.sessionId} />
        ) : (
          <ChatInventoryOverview {...props} />
        )}
      </div>
    </div>
  );
}
