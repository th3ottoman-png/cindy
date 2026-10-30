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

export const TASK_CLASSES = ['title', 'predict', 'summary', 'chat.default'] as const;

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
      } else if (!(route.trim() in result.routes)) {
        result.issues.push({ where, message: `unknown route "${route.trim()}"` });
      } else {
        result.rules[taskClass] = route.trim();
      }
    }
  }
  return result;
}

/**
 * Resolve a task class (e.g. "title", "chat.default"). Exact rule first, then `<group>.default`
 * for a dotted class like "chat.code". No rule means an error, never a default model.
 */
export function resolveTaskRoute(config: RoutingFile, taskClass: string): RouteResolution {
  const group = taskClass.includes('.') ? taskClass.slice(0, taskClass.indexOf('.')) : undefined;
  const key = [taskClass, group ? `${group}.default` : undefined].find((k) => k !== undefined && k in config.rules);
  if (key === undefined) {
    return { ok: false, taskClass, error: `no routing rule for "${taskClass}"; add one to routing.yaml (nothing is chosen for you)` };
  }
  const routeName = config.rules[key];
  const target = config.routes[routeName];
  if (!target) return { ok: false, taskClass, error: `rule "${key}" names unknown route "${routeName}"` };
  return { ok: true, taskClass, routeName, target };
}
