/**
 * operations-rail plugin —— Right sidebar Operations Rail Panel (ROADMAP 8.6b).
 *
 * Ordered runtime control over Hermes turns, Orca workers, bots, and scheduled sessions.
 * Provides one-click handoff, replay, cancel, and sandboxed schedule dry-runs.
 */

import { lazy } from 'react';
import { Activity } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

const OperationsRailTabBody = lazy(() =>
  import('./OperationsRailTabBody').then((module) => ({ default: module.OperationsRailTabBody })),
);

export type OperationsRailState = Record<never, never>;

function OperationsRailTabPillTitle({ t }: { state: OperationsRailState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.operationsRail') ?? 'Operations'}</>;
}

function OperationsRailTabPillIcon() {
  return <Activity size={13} />;
}

const plugin: TabKindPlugin<OperationsRailState> = {
  kind: 'operations-rail',
  menu: {
    kind: 'operations-rail',
    labelKey: 'rightSidebar.tabs.kinds.operationsRail',
    descriptionKey: 'rightSidebar.tabs.descriptions.operationsRail',
    icon: Activity,
    order: 19,
    enabled: true,
    singleton: true,
  },
  TabPillTitle: OperationsRailTabPillTitle,
  TabPillIcon: OperationsRailTabPillIcon,
  TabBody: OperationsRailTabBody,
  defaultState: () => ({}),
  serializeState: () => ({}),
  hydrateState: () => ({}),
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
