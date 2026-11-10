/**
 * Capability Packs IPC Host and Handlers (ROADMAP 8.7).
 *
 * Local-first, file-backed management of `pack.yaml` bundles under `~/.cindy-harness/packs/`.
 * Supports session manifest export, offline recipe import, Phase 4.4 security scan preview,
 * capability graph dependency tracing, and context token budget estimation.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  exportSessionToPack,
  importPackToLaunchRecipe,
  parseCapabilityPack,
  previewPackSecurity,
  serializeCapabilityPack,
  suggestCapabilityPack,
  type CapabilityPack,
  type PackSecurityPreview,
  type PackSuggestion,
} from '@cindy/maker-core/capability-pack';
import {
  buildCapabilityGraph,
  explainCapability as graphExplainCapability,
  type CapabilityGraph,
} from '@cindy/maker-core/capability-graph';
import {
  estimateCapabilityBudget,
  type CapabilityBudgetReport,
} from '@cindy/maker-core/capability-budget';
import type { SessionLaunchRecipe, SessionManifest } from '@cindy/maker-core/session-manifest';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';

export function defaultPacksDir(): string {
  return path.join(os.homedir(), '.cindy-harness', 'packs');
}

export interface CapabilityPacksHostDeps {
  packsDir?: string;
  manifestProvider?: (sessionId: string) => Promise<SessionManifest | null>;
  noteBodiesProvider?: (paths: string[]) => Promise<Record<string, string>>;
  skillFindingsProvider?: () => Promise<Record<string, { level: 'low' | 'medium' | 'high'; message: string }[]>>;
  broadcast?: (channel: string, payload?: unknown) => void;
}

export class CapabilityPacksHost {
  private readonly packsDir: string;
  private readonly manifestProvider?: (sessionId: string) => Promise<SessionManifest | null>;
  private readonly noteBodiesProvider?: (paths: string[]) => Promise<Record<string, string>>;
  private readonly skillFindingsProvider?: () => Promise<Record<string, { level: 'low' | 'medium' | 'high'; message: string }[]>>;
  private readonly broadcast?: (channel: string, payload?: unknown) => void;

  constructor(deps: CapabilityPacksHostDeps = {}) {
    this.packsDir = deps.packsDir || defaultPacksDir();
    this.manifestProvider = deps.manifestProvider;
    this.noteBodiesProvider = deps.noteBodiesProvider;
    this.skillFindingsProvider = deps.skillFindingsProvider;
    this.broadcast = deps.broadcast;

    try {
      if (!fs.existsSync(this.packsDir)) {
        fs.mkdirSync(this.packsDir, { recursive: true });
      }
    } catch {
      // Ephemeral or read-only guard
    }
  }

  getPacksDir(): string {
    return this.packsDir;
  }

  async listPacks(): Promise<CapabilityPack[]> {
    if (!fs.existsSync(this.packsDir)) {
      return [];
    }

    const entries = fs.readdirSync(this.packsDir);
    const packs: CapabilityPack[] = [];

    for (const entry of entries) {
      if (entry.endsWith('.yaml') || entry.endsWith('.yml')) {
        const fullPath = path.join(this.packsDir, entry);
        try {
          const raw = fs.readFileSync(fullPath, 'utf8');
          const pack = parseCapabilityPack(raw);
          packs.push(pack);
        } catch (err) {
          console.warn(`[CapabilityPacksHost] Skipping malformed pack "${entry}":`, err);
        }
      }
    }

    return packs.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getPack(name: string): Promise<CapabilityPack | null> {
    const filePath = path.join(this.packsDir, `${name}.yaml`);
    if (!fs.existsSync(filePath)) {
      const altPath = path.join(this.packsDir, `${name}.yml`);
      if (!fs.existsSync(altPath)) {
        return null;
      }
      const raw = fs.readFileSync(altPath, 'utf8');
      return parseCapabilityPack(raw);
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return parseCapabilityPack(raw);
  }

  async savePack(packInput: CapabilityPack | string): Promise<{ ok: boolean; name: string; file: string }> {
    const pack = typeof packInput === 'string' ? parseCapabilityPack(packInput) : packInput;
    if (!fs.existsSync(this.packsDir)) {
      fs.mkdirSync(this.packsDir, { recursive: true });
    }

    const content = serializeCapabilityPack(pack);
    const targetFile = path.join(this.packsDir, `${pack.name}.yaml`);
    const tempFile = path.join(this.packsDir, `${pack.name}.yaml.tmp-${Date.now()}`);

    fs.writeFileSync(tempFile, content, 'utf8');
    fs.renameSync(tempFile, targetFile);

    this.broadcast?.(MAKER_PUSH.CAPABILITY_PACKS_CHANGED, { name: pack.name, action: 'saved' });
    return { ok: true, name: pack.name, file: targetFile };
  }

  async exportSession(
    sessionId: string,
    meta: { name?: string; description?: string } = {},
  ): Promise<{ ok: boolean; pack: CapabilityPack; file: string }> {
    if (!this.manifestProvider) {
      throw new Error('Manifest provider is not configured for session export');
    }

    const manifest = await this.manifestProvider(sessionId);
    if (!manifest) {
      throw new Error(`Session ${sessionId} manifest could not be retrieved`);
    }

    const pack = exportSessionToPack(manifest, meta);
    const saveRes = await this.savePack(pack);
    return { ok: true, pack, file: saveRes.file };
  }

  async importToLaunchRecipe(nameOrPack: string | CapabilityPack): Promise<SessionLaunchRecipe> {
    const pack = typeof nameOrPack === 'string' ? await this.getPack(nameOrPack) : nameOrPack;
    if (!pack) {
      throw new Error(`Capability pack "${nameOrPack}" not found`);
    }
    return importPackToLaunchRecipe(pack);
  }

  async previewSecurity(nameOrPack: string | CapabilityPack): Promise<PackSecurityPreview> {
    const pack = typeof nameOrPack === 'string' ? await this.getPack(nameOrPack) : nameOrPack;
    if (!pack) {
      throw new Error(`Capability pack "${nameOrPack}" not found`);
    }

    const findings = this.skillFindingsProvider ? await this.skillFindingsProvider() : undefined;
    return previewPackSecurity(pack, findings);
  }

  async estimateBudget(params: {
    name?: string;
    pack?: CapabilityPack;
    sessionId?: string;
    maxContextTokens?: number;
  }): Promise<CapabilityBudgetReport> {
    let packOrManifest: CapabilityPack | SessionManifest | null = params.pack ?? null;

    if (!packOrManifest && params.name) {
      packOrManifest = await this.getPack(params.name);
    }

    if (!packOrManifest && params.sessionId && this.manifestProvider) {
      packOrManifest = await this.manifestProvider(params.sessionId);
    }

    if (!packOrManifest) {
      throw new Error('Must provide pack, name, or valid sessionId to estimate budget');
    }

    let noteBodies: Record<string, string> | undefined;
    if (this.noteBodiesProvider && 'pinnedNotes' in packOrManifest) {
      noteBodies = await this.noteBodiesProvider(packOrManifest.pinnedNotes);
    }

    return estimateCapabilityBudget({
      packOrManifest,
      noteBodies,
      maxContextTokens: params.maxContextTokens,
    });
  }

  async explain(params: {
    name?: string;
    pack?: CapabilityPack;
    sessionId?: string;
    capabilityId: string;
  }): Promise<{ explanation: string; graph: CapabilityGraph }> {
    let packOrManifest: CapabilityPack | SessionManifest | null = params.pack ?? null;

    if (!packOrManifest && params.name) {
      packOrManifest = await this.getPack(params.name);
    }

    if (!packOrManifest && params.sessionId && this.manifestProvider) {
      packOrManifest = await this.manifestProvider(params.sessionId);
    }

    if (!packOrManifest) {
      throw new Error('Must provide pack, name, or valid sessionId to explain capability');
    }

    const graph = buildCapabilityGraph(packOrManifest);
    const explanation = graphExplainCapability(graph, params.capabilityId);
    return { explanation, graph };
  }

  async suggest(prompt: string): Promise<PackSuggestion | null> {
    const packs = await this.listPacks();
    return suggestCapabilityPack(prompt, packs);
  }
}

let desktopCapabilityPacksHost: CapabilityPacksHost | undefined;

export function getDesktopCapabilityPacksHost(deps?: CapabilityPacksHostDeps): CapabilityPacksHost {
  if (!desktopCapabilityPacksHost) {
    desktopCapabilityPacksHost = new CapabilityPacksHost(deps);
  }
  return desktopCapabilityPacksHost;
}

export interface CapabilityPacksHandlerDeps {
  host: CapabilityPacksHost;
  assertTrusted(event: unknown): void;
}

export function registerCapabilityPacksHandlers(
  registry: IpcHandlerRegistry,
  deps: CapabilityPacksHandlerDeps,
): void {
  registry.handle(MAKER_INVOKE.CAPABILITY_PACKS_LIST, async (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.listPacks();
  });

  registry.handle(
    MAKER_INVOKE.CAPABILITY_PACKS_EXPORT,
    async (event: unknown, request: unknown) => {
      deps.assertTrusted(event);
      const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
      const sessionId = typeof r.sessionId === 'string' ? r.sessionId : '';
      const name = typeof r.name === 'string' ? r.name : undefined;
      const description = typeof r.description === 'string' ? r.description : undefined;
      return deps.host.exportSession(sessionId, { name, description });
    },
  );

  registry.handle(
    MAKER_INVOKE.CAPABILITY_PACKS_IMPORT,
    async (event: unknown, request: unknown) => {
      deps.assertTrusted(event);
      const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name : '';
      const pack = r.pack as CapabilityPack | undefined;
      return deps.host.importToLaunchRecipe(pack || name);
    },
  );

  registry.handle(
    MAKER_INVOKE.CAPABILITY_PACKS_PREVIEW,
    async (event: unknown, request: unknown) => {
      deps.assertTrusted(event);
      const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
      const name = typeof r.name === 'string' ? r.name : '';
      const pack = r.pack as CapabilityPack | undefined;
      return deps.host.previewSecurity(pack || name);
    },
  );

  registry.handle(
    MAKER_INVOKE.CAPABILITY_PACKS_BUDGET,
    async (event: unknown, request: unknown) => {
      deps.assertTrusted(event);
      const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
      return deps.host.estimateBudget(r as any);
    },
  );

  registry.handle(
    MAKER_INVOKE.CAPABILITY_PACKS_EXPLAIN,
    async (event: unknown, request: unknown) => {
      deps.assertTrusted(event);
      const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
      const capabilityId = typeof r.capabilityId === 'string' ? r.capabilityId : '';
      return deps.host.explain({ ...(r as any), capabilityId });
    },
  );
}
