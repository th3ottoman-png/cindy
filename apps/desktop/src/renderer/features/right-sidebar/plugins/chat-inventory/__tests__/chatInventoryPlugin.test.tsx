// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatInventory } from '@cindy/maker-core/chat-inventory';

import { ChatInventoryTabBody } from '../ChatInventoryTabBody';
import { openChatInventoryTab } from '../../../lib/openChatInventoryTab';

const MOCK_INVENTORY: ChatInventory = {
  sessionId: 'test-session-1',
  tools: [
    { name: 'read_file', count: 3, category: 'file' },
    { name: 'bash', count: 2, category: 'command' },
    { name: 'mcp__cindy_vault_notes__search_notes', count: 1, category: 'mcp', serverName: 'cindy' },
  ],
  files: [
    { path: 'src/main.ts', name: 'main.ts', action: 'modified', count: 2 },
    { path: 'src/new-feature.ts', name: 'new-feature.ts', action: 'created', count: 1 },
    { path: 'README.md', name: 'README.md', action: 'read', count: 1 },
  ],
  skills: ['code-review', 'git-workflow'],
  connectors: ['cindy', 'github'],
  tokens: {
    promptTokens: 12500,
    completionTokens: 3200,
    totalTokens: 15700,
    contextWindow: 128000,
    utilizationPercent: 12,
  },
  summary: {
    totalToolCalls: 6,
    totalFilesTouched: 3,
    totalMessages: 8,
    turnCount: 4,
  },
};

describe('ChatInventoryTabBody', () => {
  let openPath: ReturnType<typeof vi.fn>;
  let showItemInFolder: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openPath = vi.fn();
    showItemInFolder = vi.fn();

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      openPath,
      showItemInFolder,
      maker: {
        chatInventory: {
          get: vi.fn(async () => ({ ok: true, inventory: MOCK_INVENTORY })),
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  const mockCtx = {
    sessionId: 'test-session-1',
    tabId: 'tab-1',
    workdir: '/repo',
    remoteHostId: null,
    patchState: vi.fn(),
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => vi.fn()),
  };

  it('renders chat inventory panel with token metrics and utilization', async () => {
    render(<ChatInventoryTabBody ctx={mockCtx} state={{}} />);

    await waitFor(() => {
      expect(screen.getByTestId('chat-inventory-panel')).toBeDefined();
    });

    expect(screen.getByText('12%')).toBeDefined();
    expect(screen.getByText('12,500')).toBeDefined();
    expect(screen.getByText('3,200')).toBeDefined();
    expect(screen.getByText('128k')).toBeDefined();
  });

  it('renders tools invoked with counts and categories', async () => {
    render(<ChatInventoryTabBody ctx={mockCtx} state={{}} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('inventory-tool-row')).toHaveLength(3);
    });

    expect(screen.getByText('read_file')).toBeDefined();
    expect(screen.getByText('×3')).toBeDefined();
    expect(screen.getByText('bash')).toBeDefined();
    expect(screen.getByText('×2')).toBeDefined();
  });

  it('renders files touched with action chips and permits file actions', async () => {
    render(<ChatInventoryTabBody ctx={mockCtx} state={{}} />);

    await waitFor(() => {
      expect(screen.getAllByTestId('inventory-file-row')).toHaveLength(3);
    });

    expect(screen.getByText('main.ts')).toBeDefined();
    expect(screen.getByText('modified')).toBeDefined();
    expect(screen.getByText('new-feature.ts')).toBeDefined();
    expect(screen.getByText('created')).toBeDefined();
  });

  it('renders attached skills and active MCP connectors', async () => {
    render(<ChatInventoryTabBody ctx={mockCtx} state={{}} />);

    await waitFor(() => {
      expect(screen.getByText('@code-review')).toBeDefined();
      expect(screen.getByText('@git-workflow')).toBeDefined();
      expect(screen.getAllByText('cindy').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('github')).toBeDefined();
    });
  });
});
