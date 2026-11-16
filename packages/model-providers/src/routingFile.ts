/**
 * `~/.cindy-harness/routing.yaml` validation and lookup (ROADMAP 2.3a). Pure logic.
 *
 *   routes:                       # named routes: which endpoint (providers.yaml id) and model
 *     local-small: { provider: ollama-local, model: "qwen3:8b" }
 *     flash:       { provider: deepseek, model: deepseek-flash }
 *   rules:                        # task class -> route name
 *     title: local-small
 *     predict: local-small
 *     summary: local-small
 *     chat.default: flash
 *
 * Fail closed: a task class with no rule, a rule naming an unknown route, or a route naming an
 * unknown provider is an explicit error. Nothing here picks a "next best" model, so a missing or
 * broken local route can never turn into a silent call to a paid provider (ROADMAP 2.4).
 */

export const TASK_CLASSES = ['title', 'predict', 'summary', 'chat.default', 'vision', 'recap', 'tool-label'] as const;

export interface RouteTarget {
  /** providers.yaml id. */
  provider: string;
  model: string;
}

export interface RoutingFile {
  routes: Record<string, RouteTarget>;
  /** Task class -> route name. */
  rules: Record<string, string>;
}

export interface RoutingIssue {
  where: string;
  message: string;
}

export interface RoutingParseResult extends RoutingFile {
  issues: RoutingIssue[];
  /** ROADMAP 13.8: present only when the file has a `workers:` block. */
  workers?: WorkersConfig | null;
}

export type RouteResolution =
  | { ok: true; taskClass: string; routeName: string; target: RouteTarget }
  | { ok: false; taskClass: string; error: string };

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate a parsed `routing.yaml` against the provider ids that exist. Never throws. */
export function parseRoutingFile(doc: unknown, knownProviderIds: Iterable<string>): RoutingParseResult {
  const result: RoutingParseResult = { routes: {}, rules: {}, issues: [] };
  if (doc === undefined || doc === null) return result;
  if (!isRecord(doc)) {
    result.issues.push({ where: '(file)', message: 'top level must be a mapping with "routes" and "rules"' });
    return result;
  }
  const providers = new Set(knownProviderIds);

  if (doc.routes !== undefined && !isRecord(doc.routes)) {
    result.issues.push({ where: 'routes', message: 'must be a mapping of route name to {provider, model}' });
  } else {
    for (const [name, raw] of Object.entries(doc.routes ?? {})) {
      const where = `routes.${name}`;
      if (!NAME_PATTERN.test(name)) {
        result.issues.push({ where, message: 'route names are lowercase letters, digits, ".", "_" or "-"' });
      } else if (!isRecord(raw) || typeof raw.provider !== 'string' || typeof raw.model !== 'string' || !raw.provider.trim() || !raw.model.trim()) {
        result.issues.push({ where, message: 'needs a "provider" (providers.yaml id) and a "model"' });
      } else if (!providers.has(raw.provider.trim())) {
        result.issues.push({ where, message: `unknown provider "${raw.provider.trim()}" (not in providers.yaml)` });
      } else {
        result.routes[name] = { provider: raw.provider.trim(), model: raw.model.trim() };
      }
    }
  }

  if (doc.rules !== undefined && !isRecord(doc.rules)) {
    result.issues.push({ where: 'rules', message: 'must be a mapping of task class to route name' });
  } else {
    for (const [taskClass, route] of Object.entries(doc.rules ?? {})) {
      const where = `rules.${taskClass}`;
      if (typeof route !== 'string' || !route.trim()) {
        result.issues.push({ where, message: 'must be a route name' });
      } else if (!Object.prototype.hasOwnProperty.call(result.routes, route.trim())) {
        result.issues.push({ where, message: `unknown route "${route.trim()}"` });
      } else {
        result.rules[taskClass] = route.trim();
      }
    }
  }
  if (doc.workers !== undefined) {
    const rawRoutes = isRecord(doc.routes) ? Object.keys(doc.routes) : [];
    const workers = parseWorkersBlock(doc, rawRoutes);
    result.workers = workers.config;
    for (const issue of workers.issues) result.issues.push(issue);
  }
  return result;
}

/**
 * Resolve a task class (e.g. "title", "chat.default"). Exact rule first, then `<group>.default`
 * for a dotted class like "chat.code". No rule means an error, never a default model.
 */

/* ------------------------------------------------------------------------- *
 * ROADMAP 13.8 - approved models for helper agents (worker model allowlist).
 *
 * The owner writes a `workers:` block in ~/.cindy-harness/routing.yaml, inside
 * BEGIN/END markers, exactly like the managed `cindy-council` block. Cindy is
 * the only writer of that block; hand edits outside it survive byte for byte.
 *
 * Fail closed: a broken or unknown block disables model choice. A missing block
 * is today's behaviour (any lead-chosen model allowed). No fallback model is
 * ever invented here.
 * ------------------------------------------------------------------------- */

export const WORKERS_BLOCK_BEGIN = '# BEGIN cindy-workers (managed by Cindy; this block is rewritten)';
export const WORKERS_BLOCK_END = '# END cindy-workers';

export interface WorkersConfig {
  /** false = a lead can never pass `model`, whatever the list says. */
  allowModelChoice: boolean;
  /** Route names from the file's `routes:` mapping. */
  allowedRoutes: string[];
}

export interface WorkersParseResult {
  /** null = no managed block at all (today's behaviour). */
  config: WorkersConfig | null;
  issues: RoutingIssue[];
}

/** A present-but-unusable block is ignored and choice is disabled. */
export const WORKERS_FAIL_CLOSED: WorkersConfig = { allowModelChoice: false, allowedRoutes: [] };

/** Parse a `workers:` mapping out of a parsed routing.yaml document. Never throws. */
export function parseWorkersBlock(doc: unknown, knownRouteNames: Iterable<string>): WorkersParseResult {
  if (!isRecord(doc) || doc.workers === undefined) return { config: null, issues: [] };
  const raw = doc.workers;
  if (!isRecord(raw)) {
    return {
      config: WORKERS_FAIL_CLOSED,
      issues: [{ where: 'workers', message: 'must be a mapping with "allow_model_choice" and "allowed_routes"' }],
    };
  }
  const issues: RoutingIssue[] = [];
  let allowModelChoice = true;
  if (raw.allow_model_choice !== undefined) {
    if (typeof raw.allow_model_choice !== 'boolean') {
      issues.push({ where: 'workers.allow_model_choice', message: 'must be true or false' });
    } else {
      allowModelChoice = raw.allow_model_choice;
    }
  }
  const known = new Set(knownRouteNames);
  const allowedRoutes: string[] = [];
  if (!Array.isArray(raw.allowed_routes)) {
    issues.push({ where: 'workers.allowed_routes', message: 'workers.allowed_routes must be a list of route names from "routes:"' });
  } else {
    for (const entry of raw.allowed_routes) {
      if (typeof entry !== 'string' || !entry.trim() || !NAME_PATTERN.test(entry.trim())) {
        issues.push({ where: 'workers.allowed_routes', message: 'entries must be route names (lowercase letters, digits, ".", "_" or "-")' });
        continue;
      }
      const name = entry.trim();
      if (!known.has(name)) {
        issues.push({ where: `workers.allowed_routes.${name}`, message: `unknown route "${name}" (not in routes:)` });
      } else if (!allowedRoutes.includes(name)) {
        allowedRoutes.push(name);
      }
    }
  }
  if (issues.length > 0) return { config: WORKERS_FAIL_CLOSED, issues };
  return { config: { allowModelChoice, allowedRoutes }, issues: [] };
}

/** Render the managed block. Text-level, so the owner's comments survive. */
export function renderWorkersBlock(config: WorkersConfig): string {
  const formatRouteScalar = (r: string): string =>
    /^(?:\d+(?:\.\d+)?|true|false|null|yes|no|on|off|~)$/i.test(r) ? JSON.stringify(r) : r;
  return [
    WORKERS_BLOCK_BEGIN,
    'workers:',
    `  allow_model_choice: ${config.allowModelChoice}`,
    `  allowed_routes: [${config.allowedRoutes.map(formatRouteScalar).join(', ')}]`,
    WORKERS_BLOCK_END,
  ].join('\n');
}

/**
 * Replace the managed block in place, append it, or remove it (config null).
 * Nothing outside the block is rewritten. The blank separator lines the writer
 * owns are absorbed on replacement so repeated saves cannot pile them up.
 */
export function applyWorkersBlock(text: string, config: WorkersConfig | null): string {
  const lines = text.split('\n');
  const begin = lines.findIndex((line) => line.trim() === WORKERS_BLOCK_BEGIN);
  const end = begin === -1 ? -1 : lines.findIndex((line, i) => i > begin && line.trim() === WORKERS_BLOCK_END);
  if (begin === -1 || end <= begin) {
    if (config === null) return text;
    const base = text.replace(/\s+$/, '');
    const block = renderWorkersBlock(config);
    return base ? `${base}\n\n${block}\n` : `${block}\n`;
  }
  let from = begin;
  let to = end;
  if (from > 0 && lines[from - 1].trim() === '') from -= 1;
  // Only absorb a blank line AFTER the block when real content follows it. The last
  // element of a split on a file ending in '\n' is that newline, not a blank line.
  if (to + 1 < lines.length - 1 && lines[to + 1].trim() === '') to += 1;
  const before = lines.slice(0, from);
  const after = lines.slice(to + 1);
  if (config === null) return [...before, ...after].join('\n');
  return [...before, '', ...renderWorkersBlock(config).split('\n'), '', ...after].join('\n');
}

export type WorkerModelSource = 'lead' | 'expert' | 'default';

export interface WorkerModelDecision {
  allowed: boolean;
  /** Refusal text the lead model can act on; names every allowed route. */
  message?: string;
}

/**
 * Decide whether a helper agent may start on `model`. Only a lead-chosen model
 * is checked: the expert's own route and `hermes-default` are owner-written and
 * always allowed (AGENTS.md 6.3, blueprint 10).
 */
export function decideWorkerModel(input: {
  model: string;
  source: WorkerModelSource;
  config: WorkersConfig | null;
  expertModel?: string;
  defaultModel?: string;
}): WorkerModelDecision {
  const { model, source, config, expertModel, defaultModel } = input;
  if (config === null) return { allowed: true };
  if (source !== 'lead') return { allowed: true };
  if ((defaultModel && model === defaultModel) || (expertModel && model === expertModel)) return { allowed: true };
  if (config.allowModelChoice && config.allowedRoutes.includes(model)) return { allowed: true };
  const list = config.allowedRoutes.length ? config.allowedRoutes.join(', ') : '(none)';
  const reason = config.allowModelChoice
    ? `model "${model}" is not in the owner's worker allowlist`
    : `model "${model}" was chosen by the lead, but the owner has disabled model choice for helper agents`;
  return {
    allowed: false,
    message: `${reason}. Allowed routes: ${list}. Omit model to use the expert's route or the Hermes default. No Worker was started.`,
  };
}

export function resolveTaskRoute(
  config: RoutingFile & { issues?: readonly RoutingIssue[] },
  taskClass: string,
): RouteResolution {
  const hasOwn = (obj: object, k: string): boolean => Object.prototype.hasOwnProperty.call(obj, k);
  if (!hasOwn(config.rules, taskClass) && config.issues) {
    const exactIssue = config.issues.find((i) => i.where === `rules.${taskClass}`);
    if (exactIssue) {
      return { ok: false, taskClass, error: `rule "${taskClass}" is invalid: ${exactIssue.message}` };
    }
  }
  const group = taskClass.includes('.') ? taskClass.slice(0, taskClass.indexOf('.')) : undefined;
  const key = [taskClass, group ? `${group}.default` : undefined].find(
    (k) => k !== undefined && hasOwn(config.rules, k),
  );
  if (key === undefined) {
    return { ok: false, taskClass, error: `no routing rule for "${taskClass}"; add one to routing.yaml (nothing is chosen for you)` };
  }
  const routeName = config.rules[key];
  const target = hasOwn(config.routes, routeName) ? config.routes[routeName] : undefined;
  if (!target) return { ok: false, taskClass, error: `rule "${key}" names unknown route "${routeName}"` };
  return { ok: true, taskClass, routeName, target };
}
