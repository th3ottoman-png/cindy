/**
 * Pure YAML parser and types for `~/.cindy-harness/web-budget.yaml` (ROADMAP 13.5).
 *
 * Shared between `@cindy/maker-hermes-manager` and `@cindy/maker-core/doctor`.
 */

export const DEFAULT_WEB_BUDGET_MAX = 50;
export const DEFAULT_WEB_TOOL_NAMES: readonly string[] = ['web_search', 'web_extract'];
/** Upper bound for the cap so a typo cannot turn into an unbounded number. */
export const MAX_WEB_BUDGET = 10_000;

export interface WebBudgetConfig {
  maxSearchesPerSession: number;
  toolNames: string[];
}

export function defaultWebBudgetConfig(): WebBudgetConfig {
  return { maxSearchesPerSession: DEFAULT_WEB_BUDGET_MAX, toolNames: [...DEFAULT_WEB_TOOL_NAMES] };
}

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
  if (v.length >= 2 && ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"')))) {
    return v.slice(1, -1);
  }
  return v;
}

const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,128}$/;

function parseToolList(items: string[], errors: string[]): string[] | null {
  const names = items.map(unquote).filter((name) => name.length > 0);
  const bad = names.filter((name) => !TOOL_NAME.test(name));
  if (bad.length > 0) {
    errors.push(`tool_names: invalid tool name(s) ${bad.map((b) => JSON.stringify(b)).join(', ')}; using the default list`);
    return null;
  }
  if (names.length === 0) {
    errors.push('tool_names: the list is empty; using the default list');
    return null;
  }
  return [...new Set(names)];
}

/**
 * Narrow reader for the two documented keys (the guardrails.yaml approach: no YAML dependency
 * for one small file). Unknown keys and unreadable values are listed in `errors` and the
 * default for that key is used, so a broken file never turns the budget off.
 */
export function parseWebBudgetYaml(text: string): { config: WebBudgetConfig; errors: string[] } {
  const config = defaultWebBudgetConfig();
  const errors: string[] = [];
  let listFor: 'tool_names' | null = null;
  let listItems: string[] = [];
  const flushList = (): void => {
    if (listFor === 'tool_names') {
      const names = parseToolList(listItems, errors);
      if (names) config.toolNames = names;
    }
    listFor = null;
    listItems = [];
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw);
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    const body = line.trim();
    if (listFor && indented && body.startsWith('-')) {
      listItems.push(body.slice(1).trim());
      continue;
    }
    if (indented) {
      errors.push(`unexpected indented line: ${JSON.stringify(body)}`);
      continue;
    }
    flushList();
    const kv = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(body);
    if (!kv) {
      errors.push(`unreadable line: ${JSON.stringify(body)}`);
      continue;
    }
    const key = kv[1]!;
    const value = kv[2]!.trim();
    if (key === 'max_searches_per_session') {
      const n = Number(unquote(value));
      if (!/^\d+$/.test(unquote(value)) || !Number.isSafeInteger(n) || n > MAX_WEB_BUDGET) {
        errors.push(
          `max_searches_per_session: ${JSON.stringify(value)} is not a whole number from 0 to ${MAX_WEB_BUDGET}; using ${DEFAULT_WEB_BUDGET_MAX}`,
        );
      } else {
        config.maxSearchesPerSession = n;
      }
    } else if (key === 'tool_names') {
      if (!value) {
        listFor = 'tool_names';
      } else if (value.startsWith('[') && value.endsWith(']')) {
        const inner = value.slice(1, -1).trim();
        const names = parseToolList(inner ? inner.split(',') : [], errors);
        if (names) config.toolNames = names;
      } else {
        errors.push('tool_names: expected a list; using the default list');
      }
    } else {
      errors.push(`unknown key ${JSON.stringify(key)} (ignored)`);
    }
  }
  flushList();
  return { config, errors };
}
