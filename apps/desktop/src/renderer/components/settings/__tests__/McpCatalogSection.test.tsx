// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';

import type { McpCatalogViewEntry } from '../../../../main/maker-ipc/mcpCatalog';
import { McpCatalogListView, McpCatalogSection, mcpCatalogTestIdSuffix } from '../McpCatalogSection';

const row = (id: string, extra: Partial<McpCatalogViewEntry> = {}): McpCatalogViewEntry => {
  const slash = id.indexOf('/');
  return {
    id,
    source: id.slice(0, slash),
    name: id.slice(slash + 1),
    transport: 'stdio',
    enabled: true,
    target: 'node shim.mjs',
    envKeys: [],
    headerKeys: [],
    hasAuth: false,
    health: 'ok',
    ...extra,
  };
};

const render = (entries: McpCatalogViewEntry[], extra: Partial<Parameters<typeof McpCatalogListView>[0]> = {}) =>
  renderToStaticMarkup(
    <McpCatalogListView entries={entries} pending={null} checking={null} onToggle={() => undefined} onCheck={() => undefined} {...extra} />,
  );

describe('Settings MCP catalog (ROADMAP 4.3b)', () => {
  it('lists entries with source badge, transport, health, target and a toggle per row', () => {
    const html = render([
      row('hermes/shim', { description: 'bridge shim', envKeys: ['TOKEN'] }),
      row('lizi/docs', { transport: 'in-process', target: '', description: 'Document Toolkit' }),
    ]);
    expect(html).toContain('shim');
    expect(html).toContain('Hermes');
    expect(html).toContain('Built-in');
    expect(html).toContain('in-process');
    expect(html).toContain('node shim.mjs');
    expect(html).toContain('Document Toolkit');
    expect(html).toContain('data-testid="mcp-catalog-toggle-hermes-shim"');
    expect(html).toContain('data-testid="mcp-catalog-health-lizi-docs"');
    expect(html).toMatch(/aria-checked="true"[^>]*data-testid="mcp-catalog-toggle-hermes-shim"/);
  });

  it('health chips reflect the status; a detail line shows only for non-ok rows', () => {
    const html = render([
      row('hermes/gone', { health: 'missing-command', healthDetail: '"gone" is not an executable file or on PATH' }),
      row('hermes/off', { enabled: false, health: 'disabled' }),
    ]);
    expect(html).toContain('Missing command');
    expect(html).toContain('not an executable file');
    expect(html).toContain('Disabled');
  });

  it('the Check button is offered only on enabled http rows', () => {
    const html = render([
      row('hermes/remote', { transport: 'http', target: 'https://mcp.example.com/v1/sse', health: 'unchecked' }),
      row('hermes/remote-off', { transport: 'http', enabled: false, health: 'disabled' }),
      row('hermes/shim'),
    ]);
    expect(html).toContain('data-testid="mcp-catalog-check-hermes-remote"');
    expect(html).not.toContain('mcp-catalog-check-hermes-remote-off');
    expect(html).not.toContain('mcp-catalog-check-hermes-shim');
    expect(html).toContain('Unchecked');
  });

  it('the in-flight toggle and probe are disabled so they cannot be double-fired', () => {
    const html = render(
      [
        row('hermes/shim'),
        row('hermes/remote', { transport: 'http', health: 'unchecked' }),
        row('lizi/docs', { transport: 'in-process', target: '' }),
      ],
      { pending: 'hermes/shim', checking: 'hermes/remote' },
    );
    expect(html).toMatch(/data-disabled=""[^>]*data-testid="mcp-catalog-toggle-hermes-shim"/);
    expect(html).not.toMatch(/data-disabled=""[^>]*data-testid="mcp-catalog-toggle-lizi-docs"/);
    expect(html).toContain('Checking…');
  });

  it('the empty state is explicit', () => {
    expect(render([])).toContain('No MCP servers configured');
  });

  it('testid suffixes are sanitized', () => {
    expect(mcpCatalogTestIdSuffix('hermes/a b/c_d')).toBe('hermes-a-b-c-d');
  });

  it('renders "Add to expert" dropdown when onAddToExpert is provided', () => {
    const html = render([row('hermes/shim')], {
      onAddToExpert: () => undefined,
      expertOptions: [
        { slug: 'reviewer', name: 'Code Reviewer' },
        { slug: 'researcher', name: 'Deep Researcher' },
      ],
    });
    expect(html).toContain('data-testid="mcp-catalog-add-expert-hermes-shim"');
    expect(html).toContain('Add to expert…');
    expect(html).toContain('Code Reviewer');
    expect(html).toContain('Deep Researcher');
  });

  it('"Add to expert" dropdown is disabled with "No experts" when options are empty', () => {
    const html = render([row('hermes/shim')], {
      onAddToExpert: () => undefined,
      expertOptions: [],
    });
    expect(html).toContain('data-testid="mcp-catalog-add-expert-hermes-shim"');
    expect(html).toContain('No experts');
    expect(html).toContain('disabled=""');
  });

  it('"Add to expert" dropdown is disabled when addingToExpert matches entry id', () => {
    const html = render([row('hermes/shim')], {
      onAddToExpert: () => undefined,
      addingToExpert: 'hermes/shim',
      expertOptions: [{ slug: 'reviewer', name: 'Code Reviewer' }],
    });
    expect(html).toMatch(/disabled=""[^>]*data-testid="mcp-catalog-add-expert-hermes-shim"/);
  });

  describe('Collapsible McpCatalogSection', () => {
    beforeEach(() => {
      (window as unknown as { electronAPI: unknown }).electronAPI = {
        maker: {
          mcpCatalog: {
            list: async () => ({
              entries: [row('hermes/shim')],
            }),
            onChanged: () => () => undefined,
            setEnabled: async () => ({ entries: [] }),
            checkHealth: async () => undefined,
            addToExpert: async () => ({ expertSlug: 'test', serverName: 'shim' }),
          },
          experts: {
            list: async () => [],
            onChanged: () => () => undefined,
          },
        },
      };
    });

    it('renders expanded with aria-expanded="true" when collapsed is false', () => {
      const html = renderToStaticMarkup(<McpCatalogSection collapsed={false} />);
      expect(html).toContain('data-testid="mcp-catalog-collapse-toggle"');
      expect(html).toContain('aria-expanded="true"');
      expect(html).toContain('Every MCP server Cindy can hand an agent');
    });

    it('hides description and list with aria-expanded="false" when collapsed is true', () => {
      const html = renderToStaticMarkup(<McpCatalogSection collapsed={true} />);
      expect(html).toContain('data-testid="mcp-catalog-collapse-toggle"');
      expect(html).toContain('aria-expanded="false"');
      expect(html).not.toContain('Every MCP server Cindy can hand an agent');
    });
  });
});
