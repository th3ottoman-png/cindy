/**
 * chat-inventory plugin —— Right sidebar Chat Inventory & Session Audit Panel (ROADMAP 8.8).
 *
 * Inspects all live session resources: tools invoked, files read/created/modified,
 * active skills attached, MCP connectors, and token usage breakdown.
 */

import { lazy } from 'react';
import { Boxes } from 'lucide-react';
import type { TFunction } from 'i18next';

import { registerTabKind } from '../../registry';
import type { TabKindPlugin } from '../../types';

const ChatInventoryTabBody = lazy(() =>
  import('./ChatInventoryTabBody').then((module) => ({ default: module.ChatInventoryTabBody })),
);

export type ChatInventoryState = Record<never, never>;

function ChatInventoryTabPillTitle({ t }: { state: ChatInventoryState; t: TFunction }) {
  return <>{t('rightSidebar.tabs.kinds.chatInventory') ?? 'In This Chat'}</>;
}

function ChatInventoryTabPillIcon() {
  return <Boxes size={13} />;
}

const plugin: TabKindPlugin<ChatInventoryState> = {
  kind: 'chat-inventory',
  menu: {
    kind: 'chat-inventory',
    labelKey: 'rightSidebar.tabs.kinds.chatInventory',
    descriptionKey: 'rightSidebar.tabs.descriptions.chatInventory',
    icon: Boxes,
    order: 18,
    enabled: true,
    singleton: true,
  },
  TabPillTitle: ChatInventoryTabPillTitle,
  TabPillIcon: ChatInventoryTabPillIcon,
  TabBody: ChatInventoryTabBody,
  defaultState: () => ({}),
  serializeState: () => ({}),
  hydrateState: () => ({}),
};

registerTabKind(plugin as unknown as TabKindPlugin, import.meta.hot);
