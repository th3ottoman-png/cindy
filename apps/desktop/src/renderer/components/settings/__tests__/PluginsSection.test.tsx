import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { PluginListView, type PluginRow } from '../PluginsSection';

const row = (name: string, extra: Partial<PluginRow> = {}): PluginRow => ({
  name,
  enabled: true,
  status: 'active',
  registered: 1,
  ...extra,
});

describe('Settings plugin toggle (ROADMAP 4.2b)', () => {
  it('lists plugins with version, description, status and a toggle per row', () => {
    const html = renderToStaticMarkup(
      <PluginListView
        plugins={[
          row('hello', { version: '1.2', description: 'says hi', registered: 2 }),
          row('off-one', { enabled: false, status: 'disabled', registered: 0 }),
        ]}
        pending={null}
        onToggle={() => undefined}
      />,
    );
    expect(html).toContain('hello');
    expect(html).toContain('v1.2');
    expect(html).toContain('says hi');
    expect(html).toContain('2 extensions');
    expect(html).toContain('data-testid="plugin-toggle-hello"');
    expect(html).toContain('data-testid="plugin-status-off-one"');
    expect(html).toContain('Disabled');
    // The toggle reflects the persisted enabled flag, not the load status.
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="plugin-toggle-hello"/);
    expect(html).toMatch(/aria-checked="false"[^>]*data-testid="plugin-toggle-off-one"/);
  });

  it('a broken plugin shows its error instead of the description, with the toggle still offered', () => {
    const html = renderToStaticMarkup(
      <PluginListView
        plugins={[
          row('bad', { status: 'failed', error: 'boom', registered: 0, description: 'should not show' }),
        ]}
        pending={null}
        onToggle={() => undefined}
      />,
    );
    expect(html).toContain('boom');
    expect(html).toContain('Failed');
    expect(html).not.toContain('should not show');
    expect(html).toContain('data-testid="plugin-toggle-bad"');
  });

  it('the empty state explains the plugin folder shape', () => {
    const html = renderToStaticMarkup(
      <PluginListView plugins={[]} pending={null} onToggle={() => undefined} />,
    );
    expect(html).toContain('No plugins yet');
    expect(html).toContain('manifest.yaml');
  });

  it('a corrupt plugins.json notice is shown above the list', () => {
    const html = renderToStaticMarkup(
      <PluginListView
        plugins={[row('hello')]}
        stateIssue="not valid JSON: unexpected token"
        pending={null}
        onToggle={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="plugin-state-issue"');
    expect(html).toContain('not valid JSON');
    expect(html).toContain('every plugin is enabled');
  });

  it('the in-flight toggle is disabled so it cannot be double-fired', () => {
    const html = renderToStaticMarkup(
      <PluginListView plugins={[row('hello'), row('other')]} pending="hello" onToggle={() => undefined} />,
    );
    expect(html).toMatch(/data-disabled=""[^>]*data-testid="plugin-toggle-hello"/);
    expect(html).not.toMatch(/data-disabled=""[^>]*data-testid="plugin-toggle-other"/);
  });
});
