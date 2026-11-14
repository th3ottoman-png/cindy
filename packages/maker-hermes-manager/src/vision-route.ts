/**
 * Write the auxiliary.vision block into a session home's config.yaml (ROADMAP 13.1, ADR 0013
 * Design A). Keep-formatting like the pre_tool_call hook writer in auto-review-gate.ts: every
 * other byte of the owner's config survives; only the vision block (and, when missing, the
 * provider's custom_providers entry) is added or replaced. The key is referenced by env var NAME
 * (key_env), never written as a value.
 *
 * Hermes' vision_analyze tool reads auxiliary.vision and resolves provider against the config's
 * custom_providers (probed in 13.1a), so the provider is registered there when absent.
 */

export interface VisionAuxRoute {
  provider: string;
  model: string;
  baseUrl: string;
  keyEnv?: string;
}

function yamlDoubleQuote(value: string): string {
  return '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** Hermes' OpenAI-compatible clients use the /v1 prefix (probed in 13.1a). */
export function visionBaseUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  return /\/v1$/.test(base) ? base : base + '/v1';
}

function visionEntryLines(route: VisionAuxRoute, baseUrl: string): string[] {
  const lines = [
    '  vision:',
    '    provider: ' + yamlDoubleQuote(route.provider),
    '    model: ' + yamlDoubleQuote(route.model),
    '    base_url: ' + yamlDoubleQuote(baseUrl),
  ];
  if (route.keyEnv) lines.push('    key_env: ' + yamlDoubleQuote(route.keyEnv));
  return lines;
}

/** End of a top-level block: the next top-level key after at, or EOF. Blank/comment lines skip. */
function blockExtent(lines: string[], at: number): number {
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.length - line.trimStart().length === 0) return i;
  }
  return lines.length;
}

function ensureCustomProvider(lines: string[], provider: string, baseUrl: string): string[] {
  const at = lines.findIndex((line) => /^custom_providers\s*:/.test(line));
  const entry = ['  - name: ' + yamlDoubleQuote(provider), '    base_url: ' + yamlDoubleQuote(baseUrl)];
  if (at === -1) {
    return [...lines, 'custom_providers:', ...entry];
  }
  const rest = lines[at].replace(/^custom_providers\s*:/, '').trim();
  if (rest && !rest.startsWith('#')) {
    throw new Error('config.yaml has an inline custom_providers value; Cindy cannot register the vision provider');
  }
  const end = blockExtent(lines, at);
  for (let i = at + 1; i < end; i++) {
    const m = lines[i].match(/^\s*-\s*name:\s*(.+?)\s*$/);
    if (m && m[1].replace(/^["']|["']$/g, '') === provider) return lines;
  }
  return [...lines.slice(0, end), ...entry, ...lines.slice(end)];
}

function setAuxiliaryVision(lines: string[], route: VisionAuxRoute, baseUrl: string): string[] {
  const entry = visionEntryLines(route, baseUrl);
  const at = lines.findIndex((line) => /^auxiliary\s*:/.test(line));
  if (at === -1) {
    return [...lines, 'auxiliary:', ...entry];
  }
  const rest = lines[at].replace(/^auxiliary\s*:/, '').trim();
  if (rest && !rest.startsWith('#')) {
    throw new Error('config.yaml has an inline auxiliary value; Cindy cannot set the vision route');
  }
  const end = blockExtent(lines, at);
  const visionAt = lines.findIndex((line, i) => i > at && i < end && /^\s{2}vision\s*:/.test(line));
  if (visionAt === -1) {
    return [...lines.slice(0, at + 1), ...entry, ...lines.slice(at + 1)];
  }
  let visionEnd = end;
  for (let i = visionAt + 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (line.length - line.trimStart().length <= 2) { visionEnd = i; break; }
  }
  return [...lines.slice(0, visionAt), ...entry, ...lines.slice(visionEnd)];
}

/** Add or replace auxiliary.vision (and the provider registration) keeping every other byte. */
export function injectVisionRoute(configYaml: string, route: VisionAuxRoute): string {
  const eol = configYaml.includes('\r\n') ? '\r\n' : '\n';
  const baseUrl = visionBaseUrl(route.baseUrl);
  let lines = configYaml.length > 0 ? configYaml.split(/\r?\n/) : [];
  lines = ensureCustomProvider(lines, route.provider, baseUrl);
  lines = setAuxiliaryVision(lines, route, baseUrl);
  const text = lines.join(eol).replace(/(\r?\n)+$/, '');
  return text + eol;
}
