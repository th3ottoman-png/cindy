/**
 * Secret and path redaction for Cindy Doctor reports and incident bundles
 * (ROADMAP 14.1, blueprint §9).
 */

export interface RedactOptions {
  homeDir?: string;
  knownSecrets?: readonly string[];
}

export const REDACTED_VALUE = '«redacted»';

export const SECRET_CONFIG_KEY_PATTERN = /key|token|secret|password|auth|bearer|cookie/i;

const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const OPENAI_STYLE_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{12,}\b/g;
const GITHUB_TOKEN_PATTERN = /\b(?:gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{16,})\b/g;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g;
const URL_PATTERN = /\b(?:https?|wss?|socks5?):\/\/[^\s"'`<>]+/gi;
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripUrlSensitiveParts(rawUrl: string): string {
  const trailingMatch = rawUrl.match(/([.,);:\]]+)$/);
  const trailing = trailingMatch ? trailingMatch[1] : '';
  const core = trailing ? rawUrl.slice(0, -trailing.length) : rawUrl;

  try {
    const parsed = new URL(core);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    let rendered = parsed.toString();
    // Avoid adding an extra trailing slash if the original URL had no path slash.
    if (parsed.pathname === '/' && !core.replace(/\?.*$/, '').endsWith('/') && rendered.endsWith('/')) {
      rendered = rendered.slice(0, -1);
    }
    return `${rendered}${trailing}`;
  } catch {
    const cleaned = core
      .replace(/^((?:https?|wss?|socks5?):\/\/)[^/@\s]+@/i, '$1')
      .replace(/\?[^\s#"'`<>]*/, '');
    return `${cleaned}${trailing}`;
  }
}

export function redactText(text: string, options: RedactOptions = {}): string {
  if (typeof text !== 'string' || text.length === 0) return text;

  let out = text;

  if (options.knownSecrets && options.knownSecrets.length > 0) {
    const uniqueSecrets = [...new Set(options.knownSecrets)]
      .filter((secret) => typeof secret === 'string' && secret.length >= 4)
      .sort((a, b) => b.length - a.length);
    for (const secret of uniqueSecrets) {
      out = out.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED_VALUE);
    }
  }

  out = out.replace(BEARER_PATTERN, `Bearer ${REDACTED_VALUE}`);
  out = out.replace(OPENAI_STYLE_KEY_PATTERN, REDACTED_VALUE);
  out = out.replace(GITHUB_TOKEN_PATTERN, REDACTED_VALUE);
  out = out.replace(JWT_PATTERN, REDACTED_VALUE);
  // Strip URL userinfo & query before email matching so user:pass@host is not treated as an email.
  out = out.replace(URL_PATTERN, stripUrlSensitiveParts);
  out = out.replace(EMAIL_PATTERN, REDACTED_VALUE);

  const rawHome = options.homeDir?.replace(/[\\/]+$/, '');
  if (rawHome && rawHome.length > 1) {
    out = out.replace(new RegExp(escapeRegExp(rawHome), 'g'), '~');
  }

  return out;
}

function redactAllLeaves(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((item) => redactAllLeaves(item));
  if (typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      copy[k] = redactAllLeaves(v);
    }
    return copy;
  }
  return REDACTED_VALUE;
}

function redactConfigTextLine(line: string, options: RedactOptions): string {
  if (/^\s*#/.test(line)) {
    return redactText(line, options);
  }

  // JSON-style `"key": value`
  const jsonMatch = line.match(/^(\s*"([^"]+)"\s*:\s*)(.+?)(,?\s*)$/);
  if (jsonMatch) {
    const [, prefix, key, rawVal, suffix] = jsonMatch;
    if (SECRET_CONFIG_KEY_PATTERN.test(key) && rawVal !== '{' && rawVal !== '[' && rawVal !== 'null') {
      const replacement = rawVal.startsWith('"') ? `"${REDACTED_VALUE}"` : REDACTED_VALUE;
      return `${prefix}${replacement}${suffix}`;
    }
    return `${prefix}${redactText(rawVal, options)}${suffix}`;
  }

  // YAML-style `key: value` (including list items `- key: value`)
  const yamlMatch = line.match(/^(\s*(?:-\s+)?)([A-Za-z0-9_.-]+)(\s*:\s+)(.+?)(\s*)$/);
  if (yamlMatch) {
    const [, indent, key, sep, rawVal, trailing] = yamlMatch;
    const isContainerOrEmpty = rawVal === '{' || rawVal === '[' || rawVal === '{}' || rawVal === '[]' || rawVal === '|' || rawVal === '>';
    if (SECRET_CONFIG_KEY_PATTERN.test(key) && !isContainerOrEmpty) {
      return `${indent}${key}${sep}${REDACTED_VALUE}${trailing}`;
    }
    return `${indent}${key}${sep}${redactText(rawVal, options)}${trailing}`;
  }

  return redactText(line, options);
}

function redactConfigValue(value: unknown, options: RedactOptions): unknown {
  if (typeof value === 'string') {
    return redactText(value, options);
  }
  if (value === null || value === undefined || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactConfigValue(item, options));
  }

  const copy: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_CONFIG_KEY_PATTERN.test(key) && entryValue !== null && entryValue !== undefined) {
      copy[key] = redactAllLeaves(entryValue);
    } else {
      copy[key] = redactConfigValue(entryValue, options);
    }
  }
  return copy;
}

export function redactConfig<T = unknown>(input: T, options: RedactOptions = {}): T {
  if (typeof input === 'string') {
    return input
      .split('\n')
      .map((line) => redactConfigTextLine(line, options))
      .join('\n') as T;
  }
  return redactConfigValue(input, options) as T;
}
