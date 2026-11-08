import { useEffect, useState, useMemo } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { QuickSwitcherItem } from './quickSwitcherTypes';
import { openVaultGraphTab } from '@/features/right-sidebar/lib/openVaultGraphTab';
import { openWorktreeManagerTab } from '@/features/right-sidebar/lib/openWorktreeManagerTab';
import { openArtifactsTab } from '@/features/right-sidebar/lib/openArtifactsTab';
import { openTerminalTab } from '@/features/right-sidebar/lib/openTerminalTab';

export function formatRelativeTime(dateInput: number | string | undefined): string {
  if (!dateInput) return '';
  const ms = typeof dateInput === 'number' ? dateInput : new Date(dateInput).getTime();
  if (isNaN(ms)) return '';
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 30) return `${diffDays}d ago`;
  return new Date(ms).toLocaleDateString();
}

export interface UseQuickSwitcherDataOptions {
  isOpen: boolean;
  onClose: () => void;
  activeSessionId: string | null;
  navigate: NavigateFunction;
}

export function useQuickSwitcherData({
  isOpen,
  onClose,
  activeSessionId,
  navigate,
}: UseQuickSwitcherDataOptions): {
  items: QuickSwitcherItem[];
  loading: boolean;
} {
  const [sessions, setSessions] = useState<any[]>([]);
  const [experts, setExperts] = useState<any[]>([]);
  const [vaultNodes, setVaultNodes] = useState<any[]>([]);
  const [vaultDir, setVaultDir] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  useEffect(() => {
    if (!isOpen) return;

    let cancelled = false;
    setLoading(true);

    async function loadData() {
      try {
        const [sessionsRes, expertsRes, graphRes, vaultConfigRes] = await Promise.allSettled([
          window.electronAPI?.localDb?.sessions?.list
            ? window.electronAPI.localDb.sessions.list(100, 'all')
            : Promise.resolve([]),
          window.electronAPI?.maker?.experts?.list
            ? window.electronAPI.maker.experts.list()
            : Promise.resolve([]),
          window.electronAPI?.maker?.vault?.getGraph
            ? window.electronAPI.maker.vault.getGraph(false)
            : Promise.resolve({ ok: false }),
          window.electronAPI?.maker?.vault?.getConfig
            ? window.electronAPI.maker.vault.getConfig()
            : Promise.resolve({ vaultDir: null }),
        ]);

        if (cancelled) return;

        if (sessionsRes.status === 'fulfilled' && Array.isArray(sessionsRes.value)) {
          setSessions(sessionsRes.value);
        }
        if (expertsRes.status === 'fulfilled' && Array.isArray(expertsRes.value)) {
          setExperts(expertsRes.value);
        }
        const graphVal = graphRes.status === 'fulfilled' ? graphRes.value : null;
        if (graphVal && 'graph' in graphVal && graphVal.ok && (graphVal as any).graph?.nodes) {
          const rawNodes = (graphVal as any).graph.nodes;
          setVaultNodes(Array.isArray(rawNodes) ? rawNodes : Object.values(rawNodes));
        } else {
          setVaultNodes([]);
        }
        if (vaultConfigRes.status === 'fulfilled' && vaultConfigRes.value?.vaultDir) {
          setVaultDir(vaultConfigRes.value.vaultDir);
        } else {
          setVaultDir(null);
        }
      } catch (err) {
        console.error('Failed to load QuickSwitcher data', err);
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void loadData();

    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const items = useMemo<QuickSwitcherItem[]>(() => {
    const list: QuickSwitcherItem[] = [];

    // 1. Actions / Commands (prefix >)
    list.push({
      id: 'action-new-task',
      category: 'action',
      title: 'New Task',
      subtitle: 'Start a new AI session',
      badge: 'Action',
      onSelect: () => {
        onClose();
        void window.electronAPI?.maker?.experts?.setPending(null);
        navigate('/cc-agent/new');
      },
    });

    list.push({
      id: 'action-vault-graph',
      category: 'action',
      title: 'Open Notes Vault Graph',
      subtitle: 'Explore notes, tags and backlinks in right sidebar',
      badge: 'Vault',
      onSelect: () => {
        onClose();
        const targetSessionId = activeSessionId || sessions[0]?.id;
        if (targetSessionId) {
          void openVaultGraphTab(targetSessionId);
        } else {
          navigate('/cc-agent/new');
        }
      },
    });

    list.push({
      id: 'action-quick-capture',
      category: 'action',
      title: 'Quick Capture Note',
      subtitle: 'Open Vault Graph quick-capture drawer',
      badge: 'Vault',
      onSelect: () => {
        onClose();
        const targetSessionId = activeSessionId || sessions[0]?.id;
        if (targetSessionId) {
          void openVaultGraphTab(targetSessionId);
        } else {
          navigate('/cc-agent/new');
        }
      },
    });

    list.push({
      id: 'action-synthesize-memory',
      category: 'action',
      title: 'Synthesize Vault Memory',
      subtitle: 'Compile cross-session insights to Synthesis.md',
      badge: 'Memory',
      onSelect: async () => {
        onClose();
        try {
          await window.electronAPI?.maker?.vault?.synthesizeMemory?.();
        } catch (e) {
          console.error('QuickSwitcher synthesize failed', e);
        }
      },
    });

    list.push({
      id: 'action-worktrees',
      category: 'action',
      title: 'Open Git Worktree Manager',
      subtitle: 'Inspect and switch workspace worktrees',
      badge: 'Git',
      onSelect: () => {
        onClose();
        const targetSessionId = activeSessionId || sessions[0]?.id;
        if (targetSessionId) {
          void openWorktreeManagerTab(targetSessionId);
        }
      },
    });

    list.push({
      id: 'action-artifacts',
      category: 'action',
      title: 'Open Artifacts Viewer',
      subtitle: 'Inspect generated documents and deliverables',
      badge: 'Artifacts',
      onSelect: () => {
        onClose();
        const targetSessionId = activeSessionId || sessions[0]?.id;
        if (targetSessionId) {
          void openArtifactsTab(targetSessionId);
        }
      },
    });

    list.push({
      id: 'action-terminal',
      category: 'action',
      title: 'Open Terminal',
      subtitle: 'Focus or open embedded terminal in right sidebar',
      badge: 'Terminal',
      onSelect: () => {
        onClose();
        const targetSessionId = activeSessionId || sessions[0]?.id;
        if (targetSessionId) {
          void openTerminalTab(targetSessionId);
        }
      },
    });

    list.push({
      id: 'action-settings-shortcuts',
      category: 'action',
      title: 'Keyboard Shortcuts Settings',
      subtitle: 'Customize keybindings and modifiers',
      badge: 'Settings',
      onSelect: () => {
        onClose();
        navigate('/settings?tab=shortcuts');
      },
    });

    list.push({
      id: 'action-settings-vault',
      category: 'action',
      title: 'Notes Vault Settings',
      subtitle: 'Configure vault directory, auto-save and memory',
      badge: 'Settings',
      onSelect: () => {
        onClose();
        navigate('/settings?tab=general');
      },
    });

    list.push({
      id: 'action-settings-tools',
      category: 'action',
      title: 'Hermes Skills & Tools Settings',
      subtitle: 'Manage local skills, MCP servers and permissions',
      badge: 'Settings',
      onSelect: () => {
        onClose();
        navigate('/settings?tab=tools');
      },
    });

    // 2. Active & Recent Sessions (prefix /)
    for (const s of sessions) {
      const timeStr = formatRelativeTime(s.updatedAt || s.createdAt);
      const subtitleParts: string[] = [];
      if (timeStr) subtitleParts.push(`Updated ${timeStr}`);
      if (s.model) subtitleParts.push(s.model);
      else if (s.agentKind) subtitleParts.push(s.agentKind);

      list.push({
        id: `session-${s.id}`,
        category: 'session',
        title: s.title || 'Untitled Session',
        subtitle: subtitleParts.join(' · '),
        badge: s.agentKind || 'Session',
        onSelect: () => {
          onClose();
          navigate(`/cc-agent/s/${s.id}`);
        },
      });
    }

    // 3. Installed Experts (prefix @)
    for (const exp of experts) {
      list.push({
        id: `expert-${exp.slug}`,
        category: 'expert',
        title: exp.name || exp.slug,
        subtitle: exp.description || `Expert (${exp.agent || 'hermes'})`,
        tags: exp.tags || [],
        badge: exp.agent || 'Expert',
        onSelect: () => {
          onClose();
          void window.electronAPI?.maker?.experts?.setPending(exp.slug);
          navigate('/cc-agent/new');
        },
      });
    }

    // 4. Vault Notes (prefix #)
    const safeVaultNodes = Array.isArray(vaultNodes) ? vaultNodes : Object.values(vaultNodes || {});
    for (const node of safeVaultNodes) {
      list.push({
        id: `note-${node.path}`,
        category: 'note',
        title: node.title || node.path,
        subtitle: node.path,
        tags: node.tags || [],
        badge: node.backlinks?.length ? `${node.backlinks.length} backlinks` : undefined,
        onSelect: () => {
          onClose();
          const targetSessionId = activeSessionId || sessions[0]?.id;
          if (targetSessionId) {
            void openVaultGraphTab(targetSessionId);
          }
          if (vaultDir && window.electronAPI?.openPath) {
            const separator = vaultDir.endsWith('/') || vaultDir.endsWith('\\') ? '' : '/';
            const fullPath = `${vaultDir}${separator}${node.path}`;
            void window.electronAPI.openPath(fullPath);
          }
        },
      });
    }

    return list;
  }, [sessions, experts, vaultNodes, vaultDir, activeSessionId, navigate, onClose]);

  return { items, loading };
}
