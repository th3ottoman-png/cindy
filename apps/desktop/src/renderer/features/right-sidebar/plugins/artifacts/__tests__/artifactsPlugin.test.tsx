// @vitest-environment jsdom
import React from 'react';
import { cleanup, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TabKindHostContext } from '../../../types';
import { getTabKind } from '../../../registry';
import '../index';
import { ArtifactsTabBody } from '../ArtifactsTabBody';
import { openArtifactsTab } from '../../../lib/openArtifactsTab';
import { makerChatStore } from '@/lib/makerChatStore';
import * as store from '../../../store';
import * as sidebarCommands from '../../../lib/sidebarCommands';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return {
    ...actual,
    useTranslation: () => ({ t: (key: string) => key }),
  };
});

function makeContext(overrides: Partial<TabKindHostContext> = {}): TabKindHostContext {
  return {
    tabId: 'art-tab-1',
    sessionId: 'session-art-1',
    workdir: '/repo',
    remoteHostId: null,
    deviceLinkDeviceId: null,
    patchState: vi.fn(),
    onVisibilityChange: vi.fn(),
    setCloseInterceptor: vi.fn(() => vi.fn()),
    ...overrides,
  };
}

describe('artifacts plugin', () => {
  beforeEach(() => {
    vi.stubGlobal('electronAPI', {
      openPath: vi.fn(async () => undefined),
      showItemInFolder: vi.fn(async () => undefined),
    });
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => undefined),
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('registers in registry with expected metadata', () => {
    const plugin = getTabKind('artifacts');
    expect(plugin).not.toBeNull();
    expect(plugin?.kind).toBe('artifacts');
    expect(plugin?.menu.singleton).toBe(true);
    expect(plugin?.menu.enabled).toBe(true);
  });

  it('renders artifacts list from session messages', async () => {
    vi.spyOn(makerChatStore, 'getSnapshot').mockReturnValue({
      messages: [
        {
          id: 'msg-1',
          sessionId: 'session-art-1',
          role: 'tool_use',
          toolName: 'Write',
          toolInput: { file_path: 'report.pdf', content: 'hello' },
        } as any,
      ],
    } as any);

    const ctx = makeContext({ sessionId: 'session-art-1' });
    render(<ArtifactsTabBody ctx={ctx} state={{}} />);

    await waitFor(() => {
      expect(screen.getByText('Artifacts & Files')).toBeDefined();
    });

    expect(screen.getByText('report.pdf')).toBeDefined();
  });

  it('handles reveal and open actions', async () => {
    vi.spyOn(makerChatStore, 'getSnapshot').mockReturnValue({
      messages: [
        {
          id: 'msg-1',
          sessionId: 'session-art-1',
          role: 'tool_use',
          toolName: 'Write',
          toolInput: { file_path: 'report.pdf', content: 'hello' },
        } as any,
      ],
    } as any);

    const ctx = makeContext({ sessionId: 'session-art-1' });
    render(<ArtifactsTabBody ctx={ctx} state={{}} />);

    await waitFor(() => {
      expect(screen.getByText('report.pdf')).toBeDefined();
    });

    const revealBtn = screen.getByLabelText('Reveal in Finder / Explorer');
    fireEvent.click(revealBtn);
    expect(window.electronAPI.showItemInFolder).toHaveBeenCalledWith({ filePath: '/repo/report.pdf' });

    const openBtn = screen.getByLabelText('Open file');
    fireEvent.click(openBtn);
    expect(window.electronAPI.openPath).toHaveBeenCalledWith('/repo/report.pdf');
  });

  it('shows empty state when no artifacts exist', async () => {
    vi.spyOn(makerChatStore, 'getSnapshot').mockReturnValue({
      messages: [],
    } as any);

    const ctx = makeContext({ sessionId: 'session-art-1' });
    render(<ArtifactsTabBody ctx={ctx} state={{}} />);

    await waitFor(() => {
      expect(screen.getByText('No artifacts generated yet')).toBeDefined();
    });
  });

  it('openArtifactsTab opens tab and requests sidebar visibility', async () => {
    const ensureSpy = vi.spyOn(store, 'ensureHydrated').mockResolvedValue(undefined);
    const addSpy = vi.spyOn(store, 'addOrFocusSingletonTab').mockResolvedValue({ id: 't2', kind: 'artifacts', state: {} });
    const visSpy = vi.spyOn(sidebarCommands, 'requestRightSidebarVisibility').mockImplementation(() => undefined);

    await openArtifactsTab('session-art-1');

    expect(ensureSpy).toHaveBeenCalledWith('session-art-1');
    expect(addSpy).toHaveBeenCalledWith('session-art-1', 'artifacts');
    expect(visSpy).toHaveBeenCalledWith('open', { sessionId: 'session-art-1' });
  });
});
