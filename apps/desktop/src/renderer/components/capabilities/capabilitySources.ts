import type {
  CapabilityDescriptor,
  CapabilitySource,
} from '@cindy/maker-core/extensions';

/**
 * Renderer adapters for the Capabilities hub (ROADMAP 8.1). Each source reads
 * one local IPC backing store and maps it to plain CapabilityDescriptor rows.
 * A source may reject when its optional plugin is absent: the registry
 * isolates that failure, hides the rows and keeps the rest of the app running.
 *
 * Adding a kind means adding one source here. There is no switch over kinds
 * anywhere in the hub, the matcher or the registry.
 */

const EXPERT_SETTINGS = '/settings?tab=general&section=settings-experts';
const HERMES_SETTINGS = '/settings?tab=general&section=settings-hermes';
const VAULT_SETTINGS = '/settings?tab=general&section=settings-vault';
const PROVIDERS_SETTINGS = '/settings?tab=providers';

/** The vault graph can hold thousands of notes. The hub is a browser, not a file manager. */
const MAX_VAULT_NOTE_ROWS = 80;

type RowFields = Omit<CapabilityDescriptor, 'kind' | 'id'>;

function row(kind: string, id: string, fields: RowFields): CapabilityDescriptor {
  return { kind, id: `${kind}:${id}`, ...fields };
}

export function buildCapabilitySources(): CapabilitySource[] {
  return [
    {
      kind: 'plugin',
      id: 'plugins',
      declaredInterface: 'local extension plugin',
      read: async () => {
        const view = await window.electronAPI.maker.extPlugins.list();
        return view.plugins.map((plugin) =>
          row('plugin', plugin.name, {
            title: plugin.name,
            source: `~/.cindy-harness/plugins/${plugin.name}`,
            trust: 'local-file',
            declaredInterface: 'extension plugin',
            enabled: plugin.enabled,
            // A disabled or failed plugin disappears instead of leaving a dead row.
            visible: plugin.enabled && plugin.status === 'active',
            provides: plugin.enabled && plugin.status === 'active' ? plugin.name : undefined,
            subtitle: [plugin.status, plugin.version].filter(Boolean).join(' '),
            detail: plugin.error,
            tags: ['plugin', plugin.status],
            openPath: HERMES_SETTINGS,
          }),
        );
      },
    },
    {
      kind: 'expert',
      id: 'experts',
      declaredInterface: 'expert.md frontmatter',
      read: async () => {
        const entries = await window.electronAPI.maker.experts.list();
        return entries.map((entry) =>
          row('expert', entry.slug, {
            title: entry.expert?.name ?? entry.slug,
            source: `${entry.dir}/expert.md`,
            trust: 'local-file',
            declaredInterface: 'expert.md frontmatter',
            enabled: !entry.error,
            subtitle: entry.error ?? entry.expert?.description ?? '',
            tags: ['expert', ...(entry.expert?.tags ?? [])],
            detail: entry.expert?.tools.length
              ? `Tools: ${entry.expert.tools.join(', ')}`
              : undefined,
            openPath: EXPERT_SETTINGS,
          }),
        );
      },
    },
    {
      // ROADMAP 12.1: read-only foreign agent definitions. User-level sources only here;
      // project-scoped agents appear in the new-task picker, which knows the working dir.
      kind: 'imported-agent',
      id: 'imported-agents',
      declaredInterface: 'agent markdown frontmatter',
      read: async () => {
        const view = await window.electronAPI.maker.importedAgents.list();
        return view.agents.map((agent) =>
          row('imported-agent', agent.id, {
            title: agent.name,
            source: agent.absolutePath,
            trust: 'local-file',
            declaredInterface: 'agent markdown frontmatter',
            enabled: !agent.error && agent.runsOn.length > 0,
            subtitle: agent.error ?? agent.description,
            detail: agent.blockedTools?.length
              ? `Not runnable on Hermes: ${agent.blockedTools.join(', ')}`
              : undefined,
            tags: ['imported-agent', agent.source, ...agent.runsOn],
          }),
        );
      },
    },
    {
      kind: 'skill',
      id: 'skills',
      declaredInterface: 'SKILL.md',
      read: async () => {
        const view = await window.electronAPI.maker.skills.list();
        return view.skills.map((skill) =>
          row('skill', skill.id, {
            title: skill.name,
            source: `${skill.enabled ? view.skillsRoot : view.disabledRoot}/${skill.id}/SKILL.md`,
            trust: skill.builtin ? 'builtin' : 'local-file',
            declaredInterface: 'SKILL.md',
            enabled: skill.enabled,
            subtitle: [skill.category, skill.description].filter(Boolean).join(' - '),
            tags: ['skill', skill.category],
            openPath: HERMES_SETTINGS,
          }),
        );
      },
    },
    {
      kind: 'mcp-server',
      id: 'mcp-servers',
      declaredInterface: 'MCP server catalog',
      read: async () => {
        const view = await window.electronAPI.maker.mcpCatalog.list();
        return view.entries.map((entry) =>
          row('mcp-server', entry.id, {
            title: entry.name,
            source:
              entry.source === 'hermes'
                ? '~/.hermes-cindy/config.yaml'
                : `in-process:${entry.source}`,
            trust: entry.source === 'hermes' ? 'local-file' : 'builtin',
            declaredInterface: `MCP ${entry.transport}`,
            enabled: entry.enabled && entry.transport !== 'invalid',
            subtitle: entry.target || entry.description || '',
            detail: entry.problem,
            tags: [
              'mcp',
              entry.transport,
              entry.source,
              ...(entry.description ? [entry.description] : []),
            ],
            openPath: HERMES_SETTINGS,
          }),
        );
      },
    },
    {
      kind: 'vault-source',
      id: 'vault-source',
      declaredInterface: 'vault.json / VaultGraph',
      read: async () => {
        const config = await window.electronAPI.maker.vault.getConfig();
        return [
          row('vault-source', config.vaultDir, {
            title: 'Notes vault',
            source: config.vaultDir,
            trust: 'local-file',
            declaredInterface: 'vault.json / VaultGraph',
            enabled: !config.issue,
            subtitle: `${config.noteCount ?? 0} notes${config.issue ? ` - ${config.issue}` : ''}`,
            tags: ['vault', 'notes', 'local'],
            openPath: VAULT_SETTINGS,
          }),
        ];
      },
    },
    {
      kind: 'vault-note',
      id: 'vault-notes',
      declaredInterface: 'Markdown note',
      read: async () => {
        const [config, result] = await Promise.all([
          window.electronAPI.maker.vault.getConfig(),
          window.electronAPI.maker.vault.getGraph(false),
        ]);
        if (!result.ok || !result.graph) return [];
        return Object.values(result.graph.nodes)
          .slice(0, MAX_VAULT_NOTE_ROWS)
          .map((node) =>
            row('vault-note', node.path, {
              title: node.title || node.path,
              source: `${config.vaultDir}/${node.path}`,
              trust: 'local-file',
              declaredInterface: 'Markdown note',
              enabled: true,
              subtitle: `${node.outgoingLinks.length} links`,
              tags: ['vault', 'note', ...node.tags],
              openPath: VAULT_SETTINGS,
            }),
          );
      },
    },
    {
      // This fork has no cloud connector API. A connector is a provider endpoint
      // the agent can talk to, declared in providers.yaml. No credentials are read.
      kind: 'connector',
      id: 'connectors',
      declaredInterface: 'providers.yaml endpoint',
      read: async () => {
        const view = await window.electronAPI.maker.providers.list();
        return view.providers.map((provider) =>
          row('connector', provider.id, {
            title: provider.id,
            source: '~/.cindy-harness/providers.yaml',
            trust: provider.local ? 'local-file' : 'remote',
            declaredInterface: `${provider.kind} endpoint`,
            enabled: true,
            subtitle: provider.baseUrl,
            tags: ['connector', provider.local ? 'local' : 'remote', provider.kind],
            openPath: PROVIDERS_SETTINGS,
          }),
        );
      },
    },
    {
      kind: 'model-route',
      id: 'model-routes',
      declaredInterface: 'routing.yaml',
      read: async () => {
        const routing = await window.electronAPI.maker.providers.getRouting();
        const routes = Object.entries(routing.routes).map(([name, target]) =>
          row('model-route', `route:${name}`, {
            title: name,
            source: '~/.cindy-harness/routing.yaml',
            trust: 'local-file',
            declaredInterface: 'routing.yaml route',
            enabled: true,
            subtitle: `${target.provider} / ${target.model}`,
            tags: ['model', 'route', target.provider],
            openPath: PROVIDERS_SETTINGS,
          }),
        );
        const rules = Object.entries(routing.rules).map(([taskClass, routeName]) =>
          row('model-route', `rule:${taskClass}`, {
            title: taskClass,
            source: '~/.cindy-harness/routing.yaml',
            trust: 'local-file',
            declaredInterface: 'routing.yaml rule',
            enabled: true,
            subtitle: `Task class routed to ${routeName}`,
            tags: ['model', 'rule', routeName],
            openPath: PROVIDERS_SETTINGS,
          }),
        );
        return [...routes, ...rules];
      },
    },
  ];
}
