/**
 * artifacts plugin —— Right sidebar Artifacts side-drawer tab.
 *
 * Provides a live view and inspector of all deliverables, files, and artifacts
 * produced during the conversation turns.
 */

import { lazy } from 'react';
import { Layers } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

const ArtifactsTabBody = lazy(() =>
  import('./ArtifactsTabBody').then((module) => ({ default: module.ArtifactsTabBody })),
);

export type ArtifactsState = Record<never, never>;

function ArtifactsTabPillTitle({ t }: { state: ArtifactsState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.artifacts')}</>;
}

function ArtifactsTabPillIcon() {
  return <Layers size={13} />;
}

const plugin: TabKindPlugin<ArtifactsState> = {
  kind: 'artifacts',
  menu: {
    kind: 'artifacts',
    labelKey: 'rightSidebar.tabs.kinds.artifacts',
    descriptionKey: 'rightSidebar.tabs.descriptions.artifacts',
    icon: Layers,
    order: 23,
    enabled: true,
    singleton: true,
  },
  TabPillTitle: ArtifactsTabPillTitle,
  TabPillIcon: ArtifactsTabPillIcon,
  TabBody: ArtifactsTabBody,
  defaultState: () => ({}),
  serializeState: () => ({}),
  hydrateState: () => ({}),
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
