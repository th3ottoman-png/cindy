import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { VaultView } from '../VaultSection';

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
});
