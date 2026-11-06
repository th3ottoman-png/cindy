/**
 * worktree-manager plugin —— Right sidebar Worktree Manager dock tab.
 *
 * Provides a live view and control center for all active Git worktrees across tasks.
 */

import { lazy } from 'react';
import { FolderGit2 } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

const WorktreeManagerBody = lazy(() =>
  import('./WorktreeManagerBody').then((module) => ({ default: module.WorktreeManagerBody })),
);

export type WorktreeManagerState = Record<never, never>;

function WorktreeManagerTabPillTitle({ t }: { state: WorktreeManagerState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.worktreeManager')}</>;
}

function WorktreeManagerTabPillIcon() {
  return <FolderGit2 size={13} />;
}

const plugin: TabKindPlugin<WorktreeManagerState> = {
  kind: 'worktree-manager',
  menu: {
    kind: 'worktree-manager',
    labelKey: 'rightSidebar.tabs.kinds.worktreeManager',
    descriptionKey: 'rightSidebar.tabs.descriptions.worktreeManager',
    icon: FolderGit2,
    order: 22,
    enabled: true,
    singleton: true,
  },
  TabPillTitle: WorktreeManagerTabPillTitle,
  TabPillIcon: WorktreeManagerTabPillIcon,
  TabBody: WorktreeManagerBody,
  defaultState: () => ({}),
  serializeState: () => ({}),
  hydrateState: () => ({}),
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
