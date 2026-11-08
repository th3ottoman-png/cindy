/**
 * vault-graph plugin —— Right sidebar Vault Graph & Tag Explorer tab.
 *
 * Provides a live view of vault tags, note connections, and backlinks.
 */

import { lazy } from 'react';
import { Network } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

const VaultGraphTabBody = lazy(() =>
  import('./VaultGraphTabBody').then((module) => ({ default: module.VaultGraphTabBody })),
);

export type VaultGraphState = Record<never, never>;

function VaultGraphTabPillTitle({ t }: { state: VaultGraphState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.vaultGraph') ?? 'Vault Graph'}</>;
}

function VaultGraphTabPillIcon() {
  return <Network size={13} />;
}

const plugin: TabKindPlugin<VaultGraphState> = {
  kind: 'vault-graph',
  menu: {
    kind: 'vault-graph',
    labelKey: 'rightSidebar.tabs.kinds.vaultGraph',
    descriptionKey: 'rightSidebar.tabs.descriptions.vaultGraph',
    icon: Network,
    order: 24,
    enabled: true,
    singleton: true,
  },
  TabPillTitle: VaultGraphTabPillTitle,
  TabPillIcon: VaultGraphTabPillIcon,
  TabBody: VaultGraphTabBody,
  defaultState: () => ({}),
  serializeState: () => ({}),
  hydrateState: () => ({}),
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
