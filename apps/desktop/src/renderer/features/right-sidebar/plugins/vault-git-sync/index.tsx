/**
 * vault-git-sync plugin —— Right sidebar Git Workspace ↔ Vault Project Note Auto-Sync tab (ROADMAP 7.4).
 *
 * Inspects active workspace git status (branch, recent commits, dirty files) and offers
 * a 1-click sync to append a formatted progress section to the matching project note in the vault.
 */

import { lazy } from 'react';
import { GitBranch } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

const VaultGitSyncTabBody = lazy(() =>
  import('./VaultGitSyncTabBody').then((module) => ({ default: module.VaultGitSyncTabBody })),
);

export type VaultGitSyncState = Record<never, never>;

function VaultGitSyncTabPillTitle({ t }: { state: VaultGitSyncState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.vaultGitSync') ?? 'Git Sync'}</>;
}

function VaultGitSyncTabPillIcon() {
  return <GitBranch size={13} />;
}

const plugin: TabKindPlugin<VaultGitSyncState> = {
  kind: 'vault-git-sync',
  menu: {
    kind: 'vault-git-sync',
    labelKey: 'rightSidebar.tabs.kinds.vaultGitSync',
    descriptionKey: 'rightSidebar.tabs.descriptions.vaultGitSync',
    icon: GitBranch,
    order: 25,
    enabled: true,
    singleton: true,
  },
  TabPillTitle: VaultGitSyncTabPillTitle,
  TabPillIcon: VaultGitSyncTabPillIcon,
  TabBody: VaultGitSyncTabBody,
  defaultState: () => ({}),
  serializeState: () => ({}),
  hydrateState: () => ({}),
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
