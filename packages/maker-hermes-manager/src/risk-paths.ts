/**
 * High-blast-radius pre-check (ROADMAP 11.9).
 *
 * Some edits are not dangerous because of the command, but because of the file. A one-line change
 * to `providers.yaml`, an auth module, a migration or a pricing table can break every later turn,
 * lock the owner out, or charge the wrong amount. The deterministic guardrails (11.3) look at the
 * command; this layer looks at the target path and opens an owner card with an explicit blast
 * radius before the edit runs, even in Full access.
 *
 * Pure and synchronous: no disk, no model, no network. It only reads the tool call.
 */

export type RiskCategory =
  | 'auth'
  | 'database'
  | 'payment'
  | 'harness-config'
  | 'ci'
  | 'dependencies';

export interface RiskCategoryRule {
  id: RiskCategory;
  label: string;
  /** Path regex, case-insensitive, tested against the POSIX form of the path. */
  pattern: RegExp;
  /** 0..1. The verdict's score is the highest matching weight. */
  weight: number;
  checklist: string[];
}

export interface RiskMatch {
  category: RiskCategory;
  label: string;
  weight: number;
  checklist: string[];
  path: string;
}

export interface RiskVerdict {
  highRisk: boolean;
  /** Highest matching weight, 0 when nothing matched. */
  score: number;
  matches: RiskMatch[];
  paths: string[];
}

export const RISK_THRESHOLD = 0.8;

const RULES: readonly RiskCategoryRule[] = [
  {
    id: 'harness-config',
    label: 'Harness configuration',
    pattern:
      /(?:^|\/)(?:providers\.ya?ml|routing\.ya?ml|guardrails\.ya?ml|security\.json|settings\.json|mcp\.json|config\.yaml|SOUL\.md)$|(?:^|\/)(?:\.hermes-cindy|\.cindy-harness)\//i,
    weight: 0.95,
    checklist: [
      'This file drives every later turn, including the model route and MCP servers.',
      'Confirm you are not editing the live session home instead of the base config.',
      'Keep the previous contents so the change can be undone.',
    ],
  },
  {
    id: 'auth',
    label: 'Authentication or crypto',
    pattern:
      /(?:^|\/)(?:auth|authn|authz|oauth|jwt|keychain|credential|password|secret|token|crypto|encrypt|sign)[^/]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|swift)$|(?:^|\/)(?:auth|security|crypto|keychain)\//i,
    weight: 0.9,
    checklist: [
      'This touches authentication, sessions, tokens or cryptography.',
      'Confirm existing sessions and credentials stay valid.',
      'Confirm no secret is logged, printed or committed.',
    ],
  },
  {
    id: 'payment',
    label: 'Payment or pricing',
    pattern:
      /(?:^|\/)(?:payment|billing|pricing|stripe|checkout|invoice|subscription|plan|price)[^/]*\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php)$|(?:^|\/)(?:billing|payments?|pricing)\//i,
    weight: 0.9,
    checklist: [
      'This touches billing, pricing or checkout.',
      'Confirm no customer can be charged twice or the wrong amount.',
      'Confirm currency and tax handling is unchanged.',
    ],
  },
  {
    id: 'database',
    label: 'Database schema or migration',
    pattern:
      /(?:^|\/)(?:schema\.sql|migrations?\/|alembic\/|db\/migrate\/|knex\/|sequelize\/)|[^/]*\.prisma$/i,
    weight: 0.85,
    checklist: [
      'This changes the database schema or a migration.',
      'Confirm the change is backward compatible with running code.',
      'Confirm a rollback or backup exists before it runs.',
    ],
  },
  {
    id: 'ci',
    label: 'Build or deploy pipeline',
    pattern:
      /(?:^|\/)(?:\.github\/workflows\/|\.gitlab-ci\.ya?ml$|Dockerfile$|docker-compose[^/]*\.ya?ml$|terraform\/|k8s\/|helm\/)/i,
    weight: 0.7,
    checklist: [
      'This changes the build or deploy pipeline.',
      'Confirm no secret is printed into logs.',
    ],
  },
  {
    id: 'dependencies',
    label: 'Dependency resolution',
    pattern:
      /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|package-lock\.json|yarn\.lock|requirements\.txt|pyproject\.toml|Cargo\.toml|go\.mod)$/i,
    weight: 0.6,
    checklist: [
      'This changes dependency resolution.',
      'Confirm the lockfile is updated in the same commit.',
    ],
  },
];

export const RISK_RULES: readonly RiskCategoryRule[] = RULES;

/** Tools that write to a path. `read_file` and `terminal` are not here on purpose. */
const FILE_MODIFY_TOOLS = new Set([
  'write_file',
  'patch',
  'edit',
  'apply_patch',
  'str_replace',
  'create_file',
  'multiedit',
  'remove_file',
  'delete_file',
  'move_file',
  'rename_file',
]);

const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'filename', 'target', 'target_file'] as const;

/** Test files are not high blast radius; editing them cannot lock the owner out. */
function isTestPath(path: string): boolean {
  return /(?:^|\/)(?:__tests__|tests?|spec)\//i.test(path) || /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path);
}

function normalizePath(value: string): string {
  return value.trim().replace(/\\/g, '/');
}

/** Every path a tool call writes to, including paths inside a unified `patch` string. */
export function toolCallPaths(payload: { toolName: string; toolInput: unknown }): string[] {
  const tool = payload.toolName.toLowerCase();
  if (!FILE_MODIFY_TOOLS.has(tool)) return [];
  const input = payload.toolInput;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [];
  const rec = input as Record<string, unknown>;
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const value = rec[key];
    if (typeof value === 'string' && value.trim()) paths.push(normalizePath(value));
  }
  const diff = typeof rec.patch === 'string' ? rec.patch : typeof rec.diff === 'string' ? rec.diff : '';
  if (diff) {
    for (const line of diff.split(/\r?\n/)) {
      const match = /^(?:\*\*\* (?:Update|Add|Delete) File:|--- a\/|\+\+\+ b\/)\s*(.+)$/.exec(line);
      if (match?.[1]) paths.push(normalizePath(match[1]));
    }
  }
  return [...new Set(paths.filter(Boolean))];
}

/** Classify one tool call. The verdict is high risk when any path matches at or above the threshold. */
export function classifyToolCallRisk(
  payload: { toolName: string; toolInput: unknown },
  opts: { threshold?: number } = {},
): RiskVerdict {
  const threshold = opts.threshold ?? RISK_THRESHOLD;
  const paths = toolCallPaths(payload).filter((path) => !isTestPath(path));
  const matches: RiskMatch[] = [];
  for (const path of paths) {
    for (const rule of RULES) {
      if (rule.pattern.test(path)) {
        matches.push({
          category: rule.id,
          label: rule.label,
          weight: rule.weight,
          checklist: rule.checklist,
          path,
        });
        break;
      }
    }
  }
  const score = matches.reduce((max, match) => Math.max(max, match.weight), 0);
  return { highRisk: score >= threshold, score, matches, paths };
}

/** Multiline text for the owner card: what is at risk and what to check before allowing. */
export function blastRadiusReason(verdict: RiskVerdict): string | undefined {
  if (!verdict.highRisk || verdict.matches.length === 0) return undefined;
  const labels = [...new Set(verdict.matches.map((match) => match.label))];
  const files = [...new Set(verdict.matches.map((match) => match.path))].slice(0, 3);
  const checklist = [...new Set(verdict.matches.flatMap((match) => match.checklist))];
  return [
    `High-risk system file: ${files.join(', ')}`,
    `Blast radius: ${labels.join(', ')}.`,
    ...checklist.map((item) => `- ${item}`),
    'Allow once only after checking the list.',
  ].join('\n');
}
