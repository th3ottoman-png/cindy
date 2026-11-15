/**
 * Pure YAML parser and types for `~/.cindy-harness/guardrails.yaml` (ROADMAP 11.3).
 *
 * Shared between `@cindy/maker-hermes-manager` and `@cindy/maker-core/doctor`
 * without circular workspace dependencies.
 */

export type GuardrailCategory =
  | 'filesystem'
  | 'git'
  | 'database'
  | 'credentials'
  | 'remote-exec'
  | 'system'
  | 'process';

export type GuardrailScope = 'segment' | 'whole';

export interface GuardrailRule {
  id: string;
  category: GuardrailCategory;
  /** `segment` tests each command after splitting on `;`, `&&`, `|`, `$(`, backticks, brackets. */
  scope: GuardrailScope;
  /** Regex source, tested case-insensitively. */
  pattern: string;
  reason: string;
}

export interface GuardrailsConfig {
  policy: 'enforce' | 'off';
  disabled: string[];
  extraRules: GuardrailRule[];
}

export interface GuardrailVerdict {
  blocked: boolean;
  ruleId?: string;
  category?: GuardrailCategory;
  reason?: string;
}

export const DEFAULT_GUARDRAILS_CONFIG: GuardrailsConfig = {
  policy: 'enforce',
  disabled: [],
  extraRules: [],
};

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  return v;
}

/**
 * Narrow YAML reader for the documented shape (top-level `policy`, `disabled` list, `rules` list of
 * `id` / `category` / `scope` / `pattern` / `reason`). A full YAML parser would add a dependency for
 * one small file; anything this cannot read is ignored and the defaults stay armed.
 */
export function parseGuardrailsYaml(text: string): GuardrailsConfig {
  const config: GuardrailsConfig = { policy: 'enforce', disabled: [], extraRules: [] };
  let section: 'none' | 'disabled' | 'rules' = 'none';
  let current: Partial<GuardrailRule> | null = null;

  const commit = (): void => {
    if (
      current &&
      typeof current.id === 'string' &&
      typeof current.pattern === 'string' &&
      typeof current.reason === 'string'
    ) {
      try {
        new RegExp(current.pattern);
        config.extraRules.push({
          id: current.id,
          category: (current.category ?? 'filesystem') as GuardrailCategory,
          scope: current.scope === 'whole' ? 'whole' : 'segment',
          pattern: current.pattern,
          reason: current.reason,
        });
      } catch {
        /* invalid regex: ignore the rule, keep the defaults */
      }
    }
    current = null;
  };

  const assign = (target: Partial<GuardrailRule>, key: string, value: string): void => {
    if (key === 'id') target.id = unquote(value);
    else if (key === 'category') target.category = unquote(value) as GuardrailCategory;
    else if (key === 'scope') target.scope = unquote(value) as GuardrailScope;
    else if (key === 'pattern') target.pattern = unquote(value);
    else if (key === 'reason') target.reason = unquote(value);
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();

    if (indent === 0) {
      commit();
      if (body === 'disabled:') {
        section = 'disabled';
        continue;
      }
      if (body === 'rules:') {
        section = 'rules';
        continue;
      }
      section = 'none';
      const top = /^([a-z-]+):\s*(.*)$/.exec(body);
      if (top && top[1] === 'policy') config.policy = unquote(top[2]!) === 'off' ? 'off' : 'enforce';
      continue;
    }

    if (section === 'disabled') {
      const item = /^-\s*(.+)$/.exec(body);
      if (item) config.disabled.push(unquote(item[1]!));
      continue;
    }

    if (section === 'rules') {
      if (body.startsWith('- ')) {
        commit();
        current = {};
        const first = /^([a-z-]+):\s*(.*)$/.exec(body.slice(2).trim());
        if (first) assign(current, first[1]!, first[2]!);
      } else if (current) {
        const field = /^([a-z-]+):\s*(.*)$/.exec(body);
        if (field) assign(current, field[1]!, field[2]!);
      }
    }
  }
  commit();
  return config;
}
