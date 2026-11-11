import type { ExpertEntry } from '@cindy/maker-core/experts';
import type { ExpertSourceResult } from '@cindy/maker-core/expert-draft';
import type { ProviderFileResult } from '@cindy/maker-core/providers-file';
import type { RoutingParseResult } from '@cindy/maker-core/routing-file';
import {
  buildSessionManifest,
  type SessionManifest,
  type SessionManifestInput,
} from '@cindy/maker-core/session-manifest';

import type { ExpertSessionBindingView } from '../../../main/maker-ipc/expertSessions';
import type { McpCatalogView } from '../../../main/maker-ipc/mcpCatalog';
import type { SkillsView } from '../../../main/maker-ipc/skills';
import type { VaultConfigView } from '../../../main/maker-ipc/vaultNotes';

/**
 * Renderer side of ROADMAP 8.2. Reads only local IPC backed by plain files or
 * the session row. No credentials, no network, no model call.
 *
 * Every source is optional. A missing optional plugin hides its own rows and
 * the strip still renders, so this never becomes a hard dependency of the chat
 * view.
 */

export interface SessionManifestSessionFacts {
  id: string;
  agentKind: string;
  model: string | null;
  providerId: string | null;
  permissionMode: string | null;
  /** ROADMAP 10.3: filled from the host when absent, so the strip never claims tools it lacks. */
  chatOnly?: boolean;
}

async function maybe<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call();
  } catch {
    return fallback;
  }
}

export async function collectSessionManifest(
  session: SessionManifestSessionFacts,
): Promise<SessionManifest> {
  const maker = window.electronAPI?.maker;
  if (!maker) return buildSessionManifest({ session });

  const emptySkills: SkillsView = { skills: [], skillsRoot: '', disabledRoot: '' };
  const emptyMcp: McpCatalogView = { entries: [] };
  const emptyProviders: ProviderFileResult = { providers: [], issues: [] };
  const emptyRouting: RoutingParseResult = { routes: {}, rules: {}, issues: [] };
  const emptyVault: VaultConfigView = { vaultDir: '', noteCount: 0 };

  const [binding, expertEntries, skillsView, mcpView, providersView, routingView, pinnedNotes, vaultConfig] =
    await Promise.all([
      maybe<ExpertSessionBindingView | null>(() => maker.experts.getSessionBinding(session.id), null),
      maybe<ExpertEntry[]>(() => maker.experts.list(), []),
      maybe<SkillsView>(() => maker.skills.list(), emptySkills),
      maybe<McpCatalogView>(() => maker.mcpCatalog.list(), emptyMcp),
      maybe<ProviderFileResult>(() => maker.providers.list(), emptyProviders),
      maybe<RoutingParseResult>(() => maker.providers.getRouting(), emptyRouting),
      maybe<string[]>(() => maker.vault.getPinnedNotes(session.id), []),
      maybe<VaultConfigView>(() => maker.vault.getConfig(), emptyVault),
    ]);

  const entry = binding ? expertEntries.find((item) => item.slug === binding.slug) : undefined;
  const loaded = entry?.expert;
  const source = binding
    ? await maybe<ExpertSourceResult | null>(() => maker.experts.read(binding.slug), null)
    : null;
  const markdown = source && 'ok' in source && source.ok ? source.markdown : undefined;

  // ROADMAP 10.3: the flag lives with the host (it is what builds Hermes's argv), not in the
  // session row, so ask for it unless the caller already knows.
  const chatOnly = session.chatOnly
    ?? (await maybe<boolean>(() => maker.chatOnly.get({ sessionId: session.id }).then((view) => view.chatOnly), false));

  const input: SessionManifestInput = {
    session: { ...session, chatOnly },
    expert: binding
      ? {
          slug: binding.slug,
          name: binding.name ?? loaded?.name,
          dir: binding.dir || loaded?.dir,
          model: binding.model ?? loaded?.model,
          tools: loaded?.tools,
          toolsets: binding.toolsets ?? loaded?.toolsets,
          skills: loaded?.skills,
          skillFiles: loaded?.skillFiles,
          toolsFile: loaded?.toolsFile,
          markdown,
        }
      : null,
    skills: skillsView.skills.map((skill) => ({
      id: skill.id,
      name: skill.name,
      enabled: skill.enabled,
      builtin: skill.builtin,
      file: `${skill.enabled ? skillsView.skillsRoot : skillsView.disabledRoot}/${skill.id}/SKILL.md`,
    })),
    mcpServers: mcpView.entries.map((item) => ({
      id: item.id,
      name: item.name,
      source: item.source,
      transport: item.transport,
      enabled: item.enabled && item.transport !== 'invalid',
      description: item.description,
    })),
    providers: providersView.providers.map((provider) => ({
      id: provider.id,
      kind: provider.kind,
      baseUrl: provider.baseUrl,
      local: provider.local,
    })),
    routing: { routes: routingView.routes, rules: routingView.rules },
    pinnedNotes,
    vaultDir: vaultConfig.vaultDir,
  };

  return buildSessionManifest(input);
}
