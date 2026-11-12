/**
 * ROADMAP 8.2 Session manifest.
 *
 * A declarative, file-backed description of everything that affects what an
 * agent does in one session: expert, skills, tools, connectors, pinned notes,
 * model route and permission mode. Every capability carries the file it came
 * from and, where the source exposes it, the line number.
 *
 * Pure by design. No clock, no I/O, no network, no model call. The renderer
 * gathers plain facts over local IPC and hands them to `buildSessionManifest`.
 * The YAML is a deliberately small, strict subset so the same module can write
 * it and read it back without a YAML dependency.
 */

export const SESSION_MANIFEST_VERSION = 1;

export const MANIFEST_TRUSTS = ['local-file', 'builtin', 'session-state', 'remote'] as const;
export type ManifestTrust = (typeof MANIFEST_TRUSTS)[number];

/** Display order for known kinds. Unknown kinds are appended from the data. */
export const MANIFEST_KIND_ORDER = [
  'expert',
  'skill',
  'tool',
  'connector',
  'pinned-note',
  'model-route',
  'permission',
] as const;

export interface ManifestCapability {
  kind: string;
  id: string;
  label: string;
  value: string;
  enabled: boolean;
  /** Absolute or ~-relative path of the file that declared this capability. */
  file: string;
  /** 1-based line inside `file`, when the source exposes line numbers. */
  line?: number;
  /** Stable key inside `file`, for sources that do not expose line numbers. */
  locator?: string;
  /** Plain-English answer to "Why is this on?". */
  reason: string;
  trust: ManifestTrust;
  declaredInterface: string;
}

export interface SessionManifest {
  version: 1;
  session: {
    id: string;
    agentKind: string;
    model: string;
    providerId: string | null;
    permissionMode: string;
    /**
     * ROADMAP 10.3: chat-only sessions run Hermes without toolsets, MCP servers or plugins. It is
     * recorded here so a resumed session cannot silently regain tools.
     */
    chatOnly?: boolean;
  };
  capabilities: ManifestCapability[];
}

export interface SessionManifestInput {
  session: {
    id: string;
    agentKind: string;
    model?: string | null;
    providerId?: string | null;
    permissionMode?: string | null;
    chatOnly?: boolean;
  };
  expert?: {
    slug: string;
    name?: string;
    dir?: string;
    model?: string;
    tools?: string[];
    toolsets?: string[];
    skills?: string[];
    skillFiles?: string[];
    toolsFile?: string;
    /** Raw expert.md, used to find real frontmatter line numbers. */
    markdown?: string;
  } | null;
  skills?: Array<{
    id: string;
    name?: string;
    enabled: boolean;
    builtin?: boolean;
    file?: string;
  }>;
  mcpServers?: Array<{
    id: string;
    name?: string;
    source?: string;
    transport?: string;
    enabled: boolean;
    description?: string;
  }>;
  providers?: Array<{
    id: string;
    kind?: string;
    baseUrl?: string;
    local?: boolean;
  }>;
  routing?: {
    routes?: Record<string, { provider: string; model: string }>;
    rules?: Record<string, string>;
  };
  pinnedNotes?: string[];
  vaultDir?: string;
  /** ROADMAP 11.8: ADR titles matched against the first prompt and injected into that turn. */
  relevantAdrs?: Array<{ title: string; path: string; source: 'vault' | 'repo'; status?: string }>;
  /** Workspace the repo ADRs were read from, for their file paths. */
  adrWorkspaceDir?: string;
}

export interface SessionLaunchRecipe {
  expertSlug: string | null;
  agentKind: string;
  model: string;
  permissionMode: string;
  pinnedNotes: string[];
  skills: string[];
  tools: string[];
  connectors: string[];
  capabilityIds: string[];
}

export interface ManifestComparison {
  same: boolean;
  added: string[];
  removed: string[];
  fingerprintA: string;
  fingerprintB: string;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const DEFAULT_PERMISSION_MODE = 'default';
const HERMES_CONFIG_FILE = '~/.hermes-cindy/config.yaml';
const EXPERT_BINDINGS_FILE = '~/.cindy-harness/expert-sessions.json';
const PROVIDERS_FILE = '~/.cindy-harness/providers.yaml';
const ROUTING_FILE = '~/.cindy-harness/routing.yaml';
const PINNED_NOTES_FILE = '~/.cindy-harness/pinned-vault-notes.json';
const SESSION_ADRS_FILE = '~/.cindy-harness/session-adrs.json';
const SESSION_DB = 'Cindy SQLite DB (sessions table)';

const isNonEmpty = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

function str(value: string | null | undefined, fallback = ''): string {
  return isNonEmpty(value) ? value : fallback;
}

/** 1-based line of a top-level frontmatter key. Returns undefined when absent. */
export function frontmatterLine(markdown: string | undefined, key: string): number | undefined {
  if (!markdown) return undefined;
  const lines = markdown.split(/\r?\n/);
  const pattern = new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);
  for (let index = 0; index < lines.length; index += 1) {
    if (pattern.test(lines[index])) return index + 1;
  }
  return undefined;
}

function capability(fields: Omit<ManifestCapability, 'enabled'> & { enabled?: boolean }): ManifestCapability {
  const { enabled = true, ...rest } = fields;
  return { ...rest, enabled };
}

function sortedById(rows: ManifestCapability[]): ManifestCapability[] {
  return [...rows].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

/** Maps a route name to the provider id it points at, when the model matches. */
function matchedRoutes(
  routing: SessionManifestInput['routing'],
  model: string,
): Array<{ name: string; provider: string }> {
  const routes = routing?.routes ?? {};
  return Object.entries(routes)
    .filter(([, target]) => target && typeof target.model === 'string' && target.model === model)
    .map(([name, target]) => ({ name, provider: target.provider }));
}

/**
 * Builds the manifest. Capability kinds are plain strings derived from the
 * facts, so adding a new source never needs a central switch statement.
 */
export function buildSessionManifest(input: SessionManifestInput): SessionManifest {
  const session = {
    id: str(input.session.id),
    agentKind: str(input.session.agentKind),
    model: str(input.session.model),
    providerId: isNonEmpty(input.session.providerId) ? input.session.providerId : null,
    permissionMode: str(input.session.permissionMode, DEFAULT_PERMISSION_MODE),
    ...(input.session.chatOnly === true ? { chatOnly: true } : {}),
  };
  const rows: ManifestCapability[] = [];
  const expert = input.expert ?? null;
  const markdown = expert?.markdown;
  const expertFile = expert?.dir ? `${expert.dir}/expert.md` : `${expert?.slug ?? 'expert'}/expert.md`;

  if (expert) {
    rows.push(
      capability({
        kind: 'expert',
        id: `expert:${expert.slug}`,
        label: str(expert.name, expert.slug),
        value: expert.slug,
        file: expertFile,
        line: frontmatterLine(markdown, 'name') ?? frontmatterLine(markdown, 'agent'),
        locator: `sessions.${session.id}`,
        reason: `Bound to this session by ${EXPERT_BINDINGS_FILE}`,
        trust: 'local-file',
        declaredInterface: 'expert.md frontmatter',
      }),
    );
  }

  const skillsLine = frontmatterLine(markdown, 'skills');
  if (expert?.skills?.length) {
    for (const name of expert.skills) {
      const declaredFile = expert.skillFiles?.find((file) => file.endsWith(`/${name}/SKILL.md`));
      rows.push(
        capability({
          kind: 'skill',
          id: `skill:${name}`,
          label: name,
          value: name,
          file: declaredFile ?? `${expert.dir ?? expert.slug}/skills/${name}/SKILL.md`,
          line: skillsLine,
          locator: `skills[] -> ${name}`,
          reason: `Declared in ${expertFile} frontmatter`,
          trust: 'local-file',
          declaredInterface: 'SKILL.md',
        }),
      );
    }
  } else {
    for (const skill of input.skills ?? []) {
      if (!skill.enabled) continue;
      rows.push(
        capability({
          kind: 'skill',
          id: `skill:${skill.id}`,
          label: str(skill.name, skill.id),
          value: skill.id,
          file: skill.file ?? `~/.hermes-cindy/skills/${skill.id}/SKILL.md`,
          line: undefined,
          locator: `skills/${skill.id}`,
          reason: 'Enabled in the Hermes skills directory',
          trust: skill.builtin ? 'builtin' : 'local-file',
          declaredInterface: 'SKILL.md',
        }),
      );
    }
  }

  const toolsLine = frontmatterLine(markdown, 'tools');
  const toolsetsLine = frontmatterLine(markdown, 'toolsets');
  for (const tool of expert?.tools ?? []) {
    rows.push(
      capability({
        kind: 'tool',
        id: `tool:${tool}`,
        label: tool,
        value: tool,
        file: expert?.toolsFile ?? expertFile,
        line: toolsLine,
        locator: `tools[] -> ${tool}`,
        reason: `Declared in ${expert?.toolsFile ?? expertFile}`,
        trust: 'local-file',
        declaredInterface: 'Hermes built-in tool',
      }),
    );
  }
  for (const toolset of expert?.toolsets ?? []) {
    rows.push(
      capability({
        kind: 'tool',
        id: `tool:toolset:${toolset}`,
        label: `toolset ${toolset}`,
        value: toolset,
        file: expertFile,
        line: toolsetsLine,
        locator: `toolsets[] -> ${toolset}`,
        reason: `Toolset lock declared in ${expertFile} (hermes chat -t)`,
        trust: 'local-file',
        declaredInterface: 'Hermes built-in toolset',
      }),
    );
  }
  for (const server of input.mcpServers ?? []) {
    if (!server.enabled) continue;
    const fromHermesConfig = server.source === 'hermes';
    rows.push(
      capability({
        kind: 'tool',
        id: `tool:mcp:${server.id}`,
        label: str(server.name, server.id),
        value: server.id,
        file: fromHermesConfig ? HERMES_CONFIG_FILE : `in-process:${server.source ?? 'host'}`,
        locator: `mcp_servers.${server.name ?? server.id}`,
        reason: fromHermesConfig
          ? `Enabled MCP server in ${HERMES_CONFIG_FILE}`
          : 'Enabled in-process MCP provider registered by the host',
        trust: fromHermesConfig ? 'local-file' : 'builtin',
        declaredInterface: `MCP ${server.transport ?? 'server'}`,
      }),
    );
  }

  const routeMatches = matchedRoutes(input.routing, session.model);
  const activeProviders = new Set<string>(routeMatches.map((match) => match.provider));
  if (session.providerId) activeProviders.add(session.providerId);
  for (const provider of input.providers ?? []) {
    const inUse = activeProviders.has(provider.id);
    if (!inUse && provider.local !== true) continue;
    rows.push(
      capability({
        kind: 'connector',
        id: `connector:${provider.id}`,
        label: provider.id,
        // Identity is the stable providers.yaml id. The endpoint belongs in
        // the locator, so a changed base URL does not change the recipe.
        value: provider.id,
        file: PROVIDERS_FILE,
        locator: `providers[] -> ${provider.id} (${provider.baseUrl ?? 'no baseUrl'})`,
        reason: inUse
          ? 'Provider endpoint used by the active model route'
          : 'Local endpoint available to this session, not cloud',
        trust: provider.local === false ? 'remote' : 'local-file',
        declaredInterface: `${provider.kind ?? 'provider'} endpoint`,
      }),
    );
  }

  for (const [index, notePath] of (input.pinnedNotes ?? []).entries()) {
    rows.push(
      capability({
        kind: 'pinned-note',
        id: `pinned-note:${notePath}`,
        label: notePath.split('/').pop() ?? notePath,
        value: notePath,
        file: input.vaultDir ? `${input.vaultDir}/${notePath}` : PINNED_NOTES_FILE,
        locator: `sessions.${session.id}[${index}]`,
        reason: `Pinned to this session in ${PINNED_NOTES_FILE}`,
        trust: 'local-file',
        declaredInterface: 'Markdown note',
      }),
    );
  }

  for (const adr of input.relevantAdrs ?? []) {
    const root = adr.source === 'repo' ? input.adrWorkspaceDir : input.vaultDir;
    rows.push(
      capability({
        kind: 'adr',
        id: `adr:${adr.source}:${adr.path}`,
        label: adr.title,
        value: adr.path,
        file: root ? `${root}/${adr.path}` : adr.path,
        locator: `sessions.${session.id}.adrs (${SESSION_ADRS_FILE})`,
        reason: 'Past decision matched by keyword against the first prompt; its title was injected into that turn',
        trust: 'local-file',
        declaredInterface: adr.status ? `ADR (${adr.status})` : 'ADR',
      }),
    );
  }

  rows.push(
    capability({
      kind: 'model-route',
      id: 'model-route:session-model',
      label: session.model || '(no model)',
      value: session.model,
      enabled: Boolean(session.model),
      file: ROUTING_FILE,
      locator: routeMatches.length
        ? `routes.${routeMatches.map((match) => match.name).join(',')}`
        : 'session row',
      reason: routeMatches.length
        ? `Session model resolves to routing.yaml route ${routeMatches[0].name}`
        : 'Model recorded on the session row, no matching routing.yaml route',
      trust: 'session-state',
      declaredInterface: 'session.model',
    }),
  );
  if (expert?.model) {
    rows.push(
      capability({
        kind: 'model-route',
        id: `model-route:expert:${expert.slug}`,
        label: `expert route ${expert.model}`,
        value: expert.model,
        file: expertFile,
        line: frontmatterLine(markdown, 'model'),
        locator: 'model',
        reason: `Route declared in ${expertFile} frontmatter`,
        trust: 'local-file',
        declaredInterface: 'expert.md frontmatter',
      }),
    );
  }
  for (const [name, target] of Object.entries(input.routing?.routes ?? {})) {
    if (name === 'chat.default' || (input.routing?.rules?.['chat.default'] ?? '') === name) {
      rows.push(
        capability({
          kind: 'model-route',
          id: `model-route:default:${name}`,
          label: `default ${name}`,
          value: `${target.provider}/${target.model}`,
          file: ROUTING_FILE,
          locator: `rules.chat.default -> ${name}`,
          reason: `Default chat route declared in ${ROUTING_FILE}`,
          trust: 'local-file',
          declaredInterface: 'routing.yaml rule',
        }),
      );
    }
  }

  rows.push(
    capability({
      kind: 'permission',
      id: `permission:${session.permissionMode}`,
      label: session.permissionMode,
      value: session.permissionMode,
      file: SESSION_DB,
      locator: `sessions.${session.id}.permission_mode`,
      reason: 'Access level recorded on the session row',
      trust: 'session-state',
      declaredInterface: 'session row',
    }),
  );

  if (session.chatOnly) {
    rows.push(
      capability({
        kind: 'permission',
        id: 'permission:chat-only',
        label: 'Chat only',
        value: 'no tools, no MCP',
        file: SESSION_DB,
        locator: `sessions.${session.id}.chat_only`,
        reason: 'Session runs Hermes with --safe-mode: toolsets, MCP servers and plugins are off',
        trust: 'session-state',
        declaredInterface: 'session row',
      }),
    );
  }

  return { version: SESSION_MANIFEST_VERSION, session, capabilities: sortedById(rows) };
}

/** Groups capabilities by kind. Unknown kinds are appended, never dropped. */
export function groupSessionManifest(
  manifest: SessionManifest,
): Array<{ kind: string; items: ManifestCapability[] }> {
  const groups = new Map<string, ManifestCapability[]>();
  for (const row of manifest.capabilities) {
    const bucket = groups.get(row.kind) ?? [];
    bucket.push(row);
    groups.set(row.kind, bucket);
  }
  const order = new Map<string, number>(MANIFEST_KIND_ORDER.map((kind, index) => [kind, index]));
  return [...groups.entries()]
    .sort(([a], [b]) => {
      const left = order.get(a) ?? MANIFEST_KIND_ORDER.length;
      const right = order.get(b) ?? MANIFEST_KIND_ORDER.length;
      return left - right || a.localeCompare(b);
    })
    .map(([kind, items]) => ({ kind, items }));
}

/**
 * Chip counts for the strip. The seven known kinds are always present, even at
 * zero, so an empty group is visible rather than silently hidden. Unknown kinds
 * from a new source are appended from the data.
 */
export function sessionManifestKindSummary(
  manifest: SessionManifest,
): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>();
  for (const row of manifest.capabilities) {
    counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
  }
  const known = new Set<string>(MANIFEST_KIND_ORDER);
  const extras = [...counts.keys()]
    .filter((kind) => !known.has(kind))
    .sort()
    .map((kind) => ({ kind, count: counts.get(kind) ?? 0 }));
  return [
    ...MANIFEST_KIND_ORDER.map((kind) => ({ kind, count: counts.get(kind) ?? 0 })),
    ...extras,
  ];
}

/** Stable identity of the capability set. Provenance is deliberately excluded. */
export function sessionManifestFingerprint(manifest: SessionManifest): string {
  const identity = manifest.capabilities
    .map((row) => `${row.kind}|${row.id}|${row.value}|${row.enabled ? '1' : '0'}`)
    .sort()
    .join('\n');
  let hash = 0x811c9dc5;
  for (let index = 0; index < identity.length; index += 1) {
    hash ^= identity.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function compareSessionManifests(
  a: SessionManifest,
  b: SessionManifest,
): ManifestComparison {
  const idsA = new Set(a.capabilities.map((row) => row.id));
  const idsB = new Set(b.capabilities.map((row) => row.id));
  const fingerprintA = sessionManifestFingerprint(a);
  const fingerprintB = sessionManifestFingerprint(b);
  return {
    same: fingerprintA === fingerprintB,
    added: [...idsB].filter((id) => !idsA.has(id)).sort(),
    removed: [...idsA].filter((id) => !idsB.has(id)).sort(),
    fingerprintA,
    fingerprintB,
  };
}

/** Clones a manifest into a fresh session id. This is the YAML round-trip target. */
export function reproduceSessionManifest(
  source: SessionManifest,
  freshSessionId: string,
): SessionManifest {
  return {
    version: SESSION_MANIFEST_VERSION,
    session: { ...source.session, id: freshSessionId },
    capabilities: source.capabilities.map((row) => ({ ...row })),
  };
}

/** The plain recipe a fresh draft needs to reproduce the same capability set. */
export function toSessionLaunchRecipe(manifest: SessionManifest): SessionLaunchRecipe {
  const values = (kind: string): string[] =>
    manifest.capabilities.filter((row) => row.kind === kind).map((row) => row.value);
  const expert = values('expert')[0] ?? null;
  return {
    expertSlug: expert,
    agentKind: manifest.session.agentKind,
    model: manifest.session.model,
    permissionMode: manifest.session.permissionMode,
    pinnedNotes: values('pinned-note'),
    skills: values('skill'),
    tools: values('tool'),
    connectors: values('connector'),
    capabilityIds: manifest.capabilities.map((row) => row.id).sort(),
  };
}

// ---------------------------------------------------------------------------
// Strict, dependency-free YAML subset
// ---------------------------------------------------------------------------

/** JSON string quoting is valid YAML double-quoted scalar syntax. */
function emitScalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

function emitField(
  lines: string[],
  indent: number,
  key: string,
  value: string | number | boolean | null | undefined,
): void {
  if (value === undefined) return;
  lines.push(`${' '.repeat(indent)}${key}: ${emitScalar(value)}`);
}

export function serializeSessionManifest(manifest: SessionManifest): string {
  const lines: string[] = [
    '# Cindy session manifest',
    '# Every capability names the local file that declared it.',
    `version: ${SESSION_MANIFEST_VERSION}`,
    'session:',
  ];
  emitField(lines, 2, 'id', manifest.session.id);
  emitField(lines, 2, 'agentKind', manifest.session.agentKind);
  emitField(lines, 2, 'model', manifest.session.model);
  emitField(lines, 2, 'providerId', manifest.session.providerId);
  emitField(lines, 2, 'permissionMode', manifest.session.permissionMode);
  emitField(lines, 2, 'chatOnly', manifest.session.chatOnly);
  lines.push('capabilities:');
  for (const row of manifest.capabilities) {
    const entries: Array<[string, string | number | boolean | null | undefined]> = [
      ['kind', row.kind],
      ['id', row.id],
      ['label', row.label],
      ['value', row.value],
      ['enabled', row.enabled],
      ['file', row.file],
      ['line', row.line],
      ['locator', row.locator],
      ['reason', row.reason],
      ['trust', row.trust],
      ['declaredInterface', row.declaredInterface],
    ];
    const [firstKey, firstValue] = entries[0];
    lines.push(`  - ${firstKey}: ${emitScalar(firstValue as string)}`);
    for (const [key, value] of entries.slice(1)) emitField(lines, 4, key, value);
  }
  return `${lines.join('\n')}\n`;
}

function parseScalar(raw: string): string | number | boolean | null {
  const value = raw.trim();
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('"')) return JSON.parse(value) as string;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

const TOP_LEVEL_KEYS = new Set(['version', 'session', 'capabilities']);

export type ParseSessionManifestResult =
  | { ok: true; manifest: SessionManifest }
  | { ok: false; error: string };

export function parseSessionManifest(text: string): ParseSessionManifestResult {
  const lines = String(text ?? '').split(/\r?\n/);
  let version: unknown;
  const session: Record<string, unknown> = {};
  const capabilities: Array<Record<string, unknown>> = [];
  let section: 'root' | 'session' | 'capabilities' = 'root';
  let current: Record<string, unknown> | null = null;

  for (const [index, rawLine] of lines.entries()) {
    const lineNumber = index + 1;
    const line = rawLine.replace(/\s+$/, '');
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - trimmed.length;

    if (indent === 0) {
      current = null;
      const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(trimmed);
      if (!match) return { ok: false, error: `line ${lineNumber}: expected "key: value"` };
      const [, key, rawValue] = match;
      if (!TOP_LEVEL_KEYS.has(key)) {
        return { ok: false, error: `line ${lineNumber}: unknown top-level key "${key}"` };
      }
      if (key === 'version') {
        version = parseScalar(rawValue);
        section = 'root';
      } else {
        if (rawValue.trim() !== '') {
          return { ok: false, error: `line ${lineNumber}: "${key}" must be a block` };
        }
        section = key === 'session' ? 'session' : 'capabilities';
      }
      continue;
    }

    let content = trimmed;
    if (section === 'capabilities' && indent === 2 && content.startsWith('- ')) {
      content = content.slice(2);
      current = {};
      capabilities.push(current);
    }
    const match = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(content);
    if (!match) return { ok: false, error: `line ${lineNumber}: expected "key: value"` };
    const [, key, rawValue] = match;
    let value: unknown;
    try {
      value = parseScalar(rawValue);
    } catch {
      return { ok: false, error: `line ${lineNumber}: invalid quoted value for "${key}"` };
    }
    if (section === 'session') {
      session[key] = value;
    } else if (section === 'capabilities' && current) {
      current[key] = value;
    } else {
      return { ok: false, error: `line ${lineNumber}: unexpected indented key "${key}"` };
    }
  }

  if (version !== SESSION_MANIFEST_VERSION) {
    return { ok: false, error: `unsupported manifest version ${String(version)}` };
  }
  for (const key of ['id', 'agentKind', 'model', 'permissionMode']) {
    if (typeof session[key] !== 'string') {
      return { ok: false, error: `session.${key} must be a string` };
    }
  }
  if (session.providerId !== undefined && session.providerId !== null && typeof session.providerId !== 'string') {
    return { ok: false, error: 'session.providerId must be a string or null' };
  }
  if (session.chatOnly !== undefined && typeof session.chatOnly !== 'boolean') {
    return { ok: false, error: 'session.chatOnly must be a boolean' };
  }

  const parsedCapabilities: ManifestCapability[] = [];
  const seen = new Set<string>();
  for (const [index, row] of capabilities.entries()) {
    const prefix = `capabilities[${index}]`;
    for (const key of ['kind', 'id', 'label', 'value', 'file', 'reason', 'trust', 'declaredInterface']) {
      if (typeof row[key] !== 'string') return { ok: false, error: `${prefix}.${key} must be a string` };
    }
    if (typeof row.enabled !== 'boolean') return { ok: false, error: `${prefix}.enabled must be a boolean` };
    if (!MANIFEST_TRUSTS.includes(row.trust as ManifestTrust)) {
      return { ok: false, error: `${prefix}.trust is not a known trust level` };
    }
    if (row.line !== undefined && typeof row.line !== 'number') {
      return { ok: false, error: `${prefix}.line must be a number` };
    }
    if (row.locator !== undefined && typeof row.locator !== 'string') {
      return { ok: false, error: `${prefix}.locator must be a string` };
    }
    const id = row.id as string;
    if (seen.has(id)) return { ok: false, error: `${prefix} duplicate capability id "${id}"` };
    seen.add(id);
    parsedCapabilities.push({
      kind: row.kind as string,
      id,
      label: row.label as string,
      value: row.value as string,
      enabled: row.enabled,
      file: row.file as string,
      ...(typeof row.line === 'number' ? { line: row.line } : {}),
      ...(typeof row.locator === 'string' ? { locator: row.locator } : {}),
      reason: row.reason as string,
      trust: row.trust as ManifestTrust,
      declaredInterface: row.declaredInterface as string,
    });
  }

  return {
    ok: true,
    manifest: {
      version: SESSION_MANIFEST_VERSION,
      session: {
        id: session.id as string,
        agentKind: session.agentKind as string,
        model: session.model as string,
        providerId: (session.providerId as string | null | undefined) ?? null,
        permissionMode: session.permissionMode as string,
        ...(session.chatOnly === true ? { chatOnly: true } : {}),
      },
      capabilities: parsedCapabilities,
    },
  };
}
