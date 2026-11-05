// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionMarkdownExportDialog } from '../SessionMarkdownExportDialog';

describe('SessionMarkdownExportDialog (ROADMAP 5.2b)', () => {
  const getConfigMock = vi.fn();
  const exportMarkdownMock = vi.fn();
  const pickFolderMock = vi.fn();
  const onOpenChange = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: {
        vault: {
          getConfig: getConfigMock,
        },
        sessionExport: {
          exportMarkdown: exportMarkdownMock,
          pickFolder: pickFolderMock,
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
  });

  it('renders vault option pre-selected when vault is configured', async () => {
    getConfigMock.mockResolvedValue({ vaultDir: '/my/obsidian/vault' });

    render(
      <SessionMarkdownExportDialog
        open={true}
        sessionId="sess-1"
        onOpenChange={onOpenChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Export to Markdown')).toBeTruthy();
      expect(screen.getByText('/my/obsidian/vault')).toBeTruthy();
    });

    const exportBtn = screen.getByRole('button', { name: 'Export' });
    expect(exportBtn).toBeTruthy();
    expect(exportBtn.getAttribute('disabled')).toBeNull();
  });

  it('defaults to custom folder when vault is not configured', async () => {
    getConfigMock.mockResolvedValue({ vaultDir: '' });

    render(
      <SessionMarkdownExportDialog
        open={true}
        sessionId="sess-1"
        onOpenChange={onOpenChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('No vault configured (Settings → General → Notes Vault)')).toBeTruthy();
    });

    // Custom folder is selected, but customDir is empty -> Export button disabled
    const exportBtn = screen.getByRole('button', { name: 'Export' });
    expect(exportBtn.getAttribute('disabled')).not.toBeNull();
  });

  it('allows picking a custom folder and exports to it', async () => {
    getConfigMock.mockResolvedValue({ vaultDir: '/vault' });
    pickFolderMock.mockResolvedValue('/custom/folder');
    exportMarkdownMock.mockResolvedValue({ ok: true, fileName: '2026-11-05-test.md' });

    render(
      <SessionMarkdownExportDialog
        open={true}
        sessionId="sess-1"
        onOpenChange={onOpenChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('/vault')).toBeTruthy();
    });

    // Click Browse
    const browseBtn = screen.getByRole('button', { name: 'Browse...' });
    fireEvent.click(browseBtn);

    await waitFor(() => {
      expect(screen.getByText('/custom/folder')).toBeTruthy();
    });

    // Click Export
    const exportBtn = screen.getByRole('button', { name: 'Export' });
    expect(exportBtn.getAttribute('disabled')).toBeNull();
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(exportMarkdownMock).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        targetDir: '/custom/folder',
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  it('displays error when export fails', async () => {
    getConfigMock.mockResolvedValue({ vaultDir: '/vault' });
    exportMarkdownMock.mockResolvedValue({ ok: false, message: 'Disk is full' });

    render(
      <SessionMarkdownExportDialog
        open={true}
        sessionId="sess-1"
        onOpenChange={onOpenChange}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('/vault')).toBeTruthy();
    });

    const exportBtn = screen.getByRole('button', { name: 'Export' });
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(screen.getByText('Disk is full')).toBeTruthy();
      expect(onOpenChange).not.toHaveBeenCalled();
    });
  });
});
