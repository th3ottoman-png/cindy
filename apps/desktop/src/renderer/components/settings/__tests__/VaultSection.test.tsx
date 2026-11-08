import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ChatAutosaveCard, ChatSummaryCard, VaultSynthesisCard, VaultView } from '../VaultSection';

describe('Settings VaultSection (ROADMAP 5.1)', () => {
  it('renders configured vault directory with note count badge', () => {
    const html = renderToStaticMarkup(
      <VaultView
        config={{ vaultDir: '/Users/turko/Bishi-memory', noteCount: 42 }}
        saving={false}
        onSave={() => undefined}
        onPickFolder={() => undefined}
      />,
    );

    expect(html).toContain('Notes Vault');
    expect(html).toContain('value="/Users/turko/Bishi-memory"');
    expect(html).toContain('Connected (42 notes)');
    expect(html).toContain('Browse…');
    expect(html).toContain('Save');
  });

  it('renders singular note count badge', () => {
    const html = renderToStaticMarkup(
      <VaultView
        config={{ vaultDir: '/Users/turko/Bishi-memory', noteCount: 1 }}
        saving={false}
        onSave={() => undefined}
        onPickFolder={() => undefined}
      />,
    );

    expect(html).toContain('Connected (1 note)');
  });

  it('renders unconfigured placeholder state when vaultDir is empty', () => {
    const html = renderToStaticMarkup(
      <VaultView
        config={{ vaultDir: '' }}
        saving={false}
        onSave={() => undefined}
        onPickFolder={() => undefined}
      />,
    );

    expect(html).toContain('placeholder="/path/to/notes/vault"');
    expect(html).not.toContain('Connected');
  });

  it('renders alert banner when issue is present', () => {
    const html = renderToStaticMarkup(
      <VaultView
        config={{ vaultDir: '/missing/folder', issue: 'folder does not exist' }}
        saving={false}
        onSave={() => undefined}
        onPickFolder={() => undefined}
      />,
    );

    expect(html).toContain('Vault Configuration Issue');
    expect(html).toContain('folder does not exist');
    expect(html).not.toContain('Connected');
  });

  it('renders vault search in standard chats switch', () => {
    const html = renderToStaticMarkup(
      <VaultView
        config={{ vaultDir: '/Users/turko/Bishi-memory', allSessionsSearch: true }}
        saving={false}
        onSave={() => undefined}
        onToggleSearch={() => undefined}
        onPickFolder={() => undefined}
      />,
    );

    expect(html).toContain('Vault search in standard chats');
    expect(html).toContain('aria-label="Toggle vault search in standard chats"');
    expect(html).toContain('aria-checked="true"');
  });
});

describe('Settings ChatAutosaveCard (ROADMAP 5.5)', () => {
  const noop = () => undefined;

  it('renders the switch, the folder and the last saved path', () => {
    const html = renderToStaticMarkup(
      <ChatAutosaveCard
        view={{
          enabled: true,
          folder: 'Cindy/Chats',
          vaultDir: '/v',
          lastSavedPath: '/v/Cindy/Chats/a.md',
        }}
        saving={false}
        onToggle={noop}
        onSaveFolder={noop}
      />,
    );
    expect(html).toContain('Auto-save chats');
    expect(html).toContain('value="Cindy/Chats"');
    expect(html).toContain('aria-label="Turn chat auto-save off"');
    expect(html).toContain('Last saved: /v/Cindy/Chats/a.md');
    expect(html).toContain('copy a note before');
  });

  it('warns when on with no vault, and shows the last error instead of the last path', () => {
    const noVault = renderToStaticMarkup(
      <ChatAutosaveCard
        view={{ enabled: true, folder: 'C', vaultDir: '' }}
        saving={false}
        onToggle={noop}
        onSaveFolder={noop}
      />,
    );
    expect(noVault).toContain('No vault folder is set above');
    const failed = renderToStaticMarkup(
      <ChatAutosaveCard
        view={{
          enabled: true,
          folder: 'C',
          vaultDir: '/v',
          lastSavedPath: '/v/C/a.md',
          lastError: 'EACCES',
        }}
        saving={false}
        onToggle={noop}
        onSaveFolder={noop}
      />,
    );
    expect(failed).toContain('Last save failed: EACCES');
    expect(failed).not.toContain('Last saved:');
  });

  it('is labelled to turn on when off and shows no vault warning', () => {
    const html = renderToStaticMarkup(
      <ChatAutosaveCard
        view={{ enabled: false, folder: 'C', vaultDir: '' }}
        saving={false}
        onToggle={noop}
        onSaveFolder={noop}
      />,
    );
    expect(html).toContain('aria-label="Turn chat auto-save on"');
    expect(html).not.toContain('No vault folder is set above');
  });
});

describe('ChatSummaryCard (ROADMAP 5.6)', () => {
  const noop = () => undefined;

  it('renders switch, folder input, idle duration input, and last summary line', () => {
    const html = renderToStaticMarkup(
      <ChatSummaryCard
        view={{
          enabled: true,
          folder: 'Cindy/Memory',
          idleMinutes: 10,
          vaultDir: '/v',
          lastSummaryPath: '/v/Cindy/Memory/s.md',
          lastSummaryModel: 'summary-route',
        }}
        saving={false}
        onToggle={noop}
        onSaveConfig={noop}
      />,
    );
    expect(html).toContain('Auto-summary');
    expect(html).toContain('value="Cindy/Memory"');
    expect(html).toContain('value="10"');
    expect(html).toContain('aria-label="Turn auto-summary off"');
    expect(html).toContain('Last summary: /v/Cindy/Memory/s.md (summary-route)');
  });

  it('warns when on with no vault, and shows the last error instead of last summary path', () => {
    const noVault = renderToStaticMarkup(
      <ChatSummaryCard
        view={{ enabled: true, folder: 'M', idleMinutes: 5, vaultDir: '' }}
        saving={false}
        onToggle={noop}
        onSaveConfig={noop}
      />,
    );
    expect(noVault).toContain('No vault folder is set above');

    const failed = renderToStaticMarkup(
      <ChatSummaryCard
        view={{
          enabled: true,
          folder: 'M',
          idleMinutes: 5,
          vaultDir: '/v',
          lastSummaryPath: '/v/M/s.md',
          lastError: 'HTTP 500',
        }}
        saving={false}
        onToggle={noop}
        onSaveConfig={noop}
      />,
    );
    expect(failed).toContain('Last summary failed: HTTP 500');
    expect(failed).not.toContain('Last summary:');
  });

  it('is labelled to turn on when off', () => {
    const html = renderToStaticMarkup(
      <ChatSummaryCard
        view={{ enabled: false, folder: 'M', idleMinutes: 10, vaultDir: '' }}
        saving={false}
        onToggle={noop}
        onSaveConfig={noop}
      />,
    );
    expect(html).toContain('aria-label="Turn auto-summary on"');
  });
});

describe('Settings VaultSynthesisCard (ROADMAP 6.3)', () => {
  it('renders cross-session memory synthesis card with action button', () => {
    const html = renderToStaticMarkup(
      <VaultSynthesisCard hasVault={true} />,
    );
    expect(html).toContain('Cross-Session Memory Synthesis');
    expect(html).toContain('Cindy/Memory/Synthesis.md');
    expect(html).toContain('Synthesize Memory Now');
    expect(html).not.toContain('disabled=""');
  });

  it('disables synthesis button when vault is not configured', () => {
    const html = renderToStaticMarkup(
      <VaultSynthesisCard hasVault={false} />,
    );
    expect(html).toContain('Cross-Session Memory Synthesis');
    expect(html).toContain('disabled=""');
  });
});
