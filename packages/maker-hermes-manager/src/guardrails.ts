/**
 * Deterministic command guardrails (ROADMAP 11.3).
 *
 * The injection guard (10.1) scores a tool call and asks a model to review the risky ones. That
 * costs a round trip and can be talked out of a verdict. This layer is the opposite: a fixed set
 * of POSIX regexes, no model, no network, evaluated before any review. A catastrophic command
 * (`rm -rf /`, `mkfs`, a force push, a credential upload) is recognised in well under a
 * millisecond and never reaches the reviewer.
 *
 * The rules live in `~/.cindy-harness/guardrails.yaml`, which the owner can edit or disable by id.
 * Defaults stay built in, so a missing or broken file arms the guard rather than disarming it.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as nodePath from 'node:path';

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

const RULES: readonly GuardrailRule[] = [
  {
    id: 'root-wipe',
    category: 'filesystem',
    scope: 'segment',
    pattern:
      '^rm\\s+(?:-[a-z-]*[rf][a-z-]*\\s+)+(?:--\\s+)?(?:/|/\\*|~|\\$HOME|\\$\\{HOME\\})(?:\\s|$)',
    reason: 'Deleting the filesystem root or the home directory is not allowed.',
  },
  {
    id: 'system-dir-wipe',
    category: 'filesystem',
    scope: 'segment',
    pattern:
      '^rm\\s+(?:-[a-z-]*[rf][a-z-]*\\s+)+(?:--\\s+)?/(?:etc|usr|bin|sbin|lib|lib64|boot|dev|var|opt|System|Library|Applications)(?:/|\\s|$)',
    reason: 'Deleting a top-level system directory is not allowed.',
  },
  {
    id: 'mkfs',
    category: 'filesystem',
    scope: 'segment',
    pattern: '^mkfs(?:\\.[a-z0-9]+)?\\s+',
    reason: 'Formatting a filesystem destroys its contents.',
  },
  {
    id: 'dd-disk',
    category: 'filesystem',
    scope: 'segment',
    pattern: '^dd\\b[^\\n]*\\bof=/dev/(?:sd|disk|nvme|hd|vd|mmcblk)',
    reason: 'Writing raw bytes to a block device destroys the disk.',
  },
  {
    id: 'disk-overwrite',
    category: 'filesystem',
    scope: 'segment',
    pattern: '>\\s*/dev/(?:sd|disk|nvme|hd|vd|mmcblk)',
    reason: 'Redirecting output onto a block device destroys the disk.',
  },
  {
    id: 'fork-bomb',
    category: 'process',
    scope: 'whole',
    pattern: ':\\s*\\(\\s*\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&',
    reason: 'A fork bomb would exhaust the machine.',
  },
  {
    id: 'chmod-root',
    category: 'filesystem',
    scope: 'segment',
    pattern: '^chmod\\s+(?:-[a-z-]+\\s+)*777\\s+(?:/|~|\\$HOME)(?:\\s|$)',
    reason: 'World-writable permissions on the root or home tree are not allowed.',
  },
  {
    id: 'git-reset-hard',
    category: 'git',
    scope: 'segment',
    pattern: '^git\\s+reset\\s+--hard\\b',
    reason: 'git reset --hard discards uncommitted work.',
  },
  {
    id: 'git-force-push',
    category: 'git',
    scope: 'segment',
    pattern: '^git\\s+push\\b[^\\n]*(?:\\s--force(?:\\s|$)|\\s-f(?:\\s|$))',
    reason: 'Force-pushing rewrites remote history.',
  },
  {
    id: 'git-clean',
    category: 'git',
    scope: 'segment',
    pattern: '^git\\s+clean\\s+-[a-z]*[fdx][a-z]*',
    reason: 'git clean -fdx deletes untracked and ignored files.',
  },
  {
    id: 'rm-git',
    category: 'git',
    scope: 'segment',
    pattern: '^rm\\s+(?:-[a-z-]*[rf][a-z-]*\\s+)+\\.git(?:\\s|$)',
    reason: 'Deleting .git destroys the repository history.',
  },
  {
    id: 'db-drop',
    category: 'database',
    scope: 'segment',
    pattern: '\\bdrop\\s+database\\b|^dropdb\\s+(?!-)',
    reason: 'Dropping a database destroys its data.',
  },
  {
    id: 'db-truncate',
    category: 'database',
    scope: 'segment',
    pattern: '\\btruncate\\s+table\\b',
    reason: 'TRUNCATE TABLE removes every row.',
  },
  {
    id: 'remote-code-exec',
    category: 'remote-exec',
    scope: 'whole',
    pattern: '\\b(?:curl|wget)\\b[^|\\n]*\\|\\s*(?:sudo\\s+)?(?:ba|z|da)?sh\\b',
    reason: 'Piping a download straight into a shell runs unreviewed remote code.',
  },
  {
    id: 'remote-code-exec-interpreter',
    category: 'remote-exec',
    scope: 'whole',
    pattern: '\\b(?:curl|wget)\\b[^|\\n]*\\|\\s*(?:python[0-9.]*|node|perl|ruby)\\b',
    reason: 'Piping a download straight into an interpreter runs unreviewed remote code.',
  },
  {
    id: 'base64-exec',
    category: 'remote-exec',
    scope: 'whole',
    pattern: '\\bbase64\\s+(?:-d|--decode)\\b[^|\\n]*\\|\\s*(?:ba|z|da)?sh\\b',
    reason: 'Decoding a blob straight into a shell hides what will run.',
  },
  {
    id: 'credentials-read',
    category: 'credentials',
    scope: 'segment',
    pattern:
      '^(?:cat|less|more|head|tail|cp|scp|rsync|base64|xxd|od|strings)\\b[^\\n]*(?:\\.ssh/(?:id_[a-z0-9]+|id_rsa|id_ed25519|id_ecdsa|id_dsa)|\\.aws/credentials|\\.hermes-cindy/\\.env|\\.config/gcloud/application_default_credentials\\.json)',
    reason: 'Reading private keys or credential stores is not allowed.',
  },
  {
    id: 'credentials-upload',
    category: 'credentials',
    scope: 'whole',
    pattern:
      '\\b(?:curl|wget|nc|ncat|socat)\\b[^\\n]*(?:\\.ssh/|\\.aws/|\\.hermes-cindy/\\.env|\\.config/gcloud/)',
    reason: 'Uploading credentials or private keys is not allowed.',
  },
  {
    id: 'env-exfil',
    category: 'credentials',
    scope: 'whole',
    pattern: '\\benv\\b\\s*\\|\\s*(?:curl|wget|nc|ncat|socat)\\b',
    reason: 'Piping the environment to the network can leak secrets.',
  },
  {
    id: 'system-power',
    category: 'system',
    scope: 'segment',
    pattern: '^(?:shutdown|reboot|halt|poweroff)\\b',
    reason: 'Powering off or rebooting the machine is not allowed.',
  },
  {
    id: 'kill-all',
    category: 'process',
    scope: 'segment',
    pattern: '^kill\\s+-9\\s+-1\\b',
    reason: 'Killing every process would take down the machine.',
  },
  {
    id: 'crontab-wipe',
    category: 'system',
    scope: 'segment',
    pattern: '^crontab\\s+-r\\b',
    reason: 'Removing the crontab deletes every scheduled job.',
  },
  {
    id: 'shell-c-exec',
    category: 'remote-exec',
    scope: 'segment',
    pattern: '^(?:ba|z|da)?sh\\s+-c\\s+.*\\brm\\s+-rf\\s+(?:/|~)(?:\\s|$)',
    reason: 'A shell running a destructive command inline is not allowed.',
  },
  {
    id: 'eval-destructive',
    category: 'remote-exec',
    scope: 'whole',
    pattern: '\\beval\\b[^\\n]*(?:rm\\s+-rf\\s+(?:/|~)|curl[^|\\n]*\\|\\s*(?:ba|z|da)?sh)',
    reason: 'eval of a destructive command hides what will run.',
  },
];

export const DEFAULT_GUARDRAIL_RULES: readonly GuardrailRule[] = RULES;

/** `~/.cindy-harness/guardrails.yaml`. */
export function defaultGuardrailsFile(): string {
  return nodePath.join(os.homedir(), '.cindy-harness', 'guardrails.yaml');
}

/** Tools whose input carries a shell command. */
const COMMAND_TOOLS = /^(?:terminal|bash|shell|exec|run_command|execute_command)$/i;

function commandOf(toolName: string, toolInput: unknown): string | undefined {
  if (!COMMAND_TOOLS.test(toolName)) return undefined;
  if (typeof toolInput === 'string') return toolInput;
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return undefined;
  const rec = toolInput as Record<string, unknown>;
  const value = rec.command ?? rec.cmd ?? rec.script;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Lowercase, resolve `$IFS`, drop line continuations and backslash escapes, strip quotes, and
 * collapse whitespace. Quotes go because `rm -rf "/"` is the same command as `rm -rf /`.
 */
export function normalizeCommand(command: string): string {
  return command
    .toLowerCase()
    .replace(/\$\{?ifs\}?/g, ' ')
    .replace(/\\\r?\n/g, ' ')
    .replace(/\\(?=[a-z0-9])/g, '')
    .replace(/["']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Remove `sudo`, `env FOO=bar`, `nohup`, `time`, and similar prefixes before matching. */
function stripWrappers(segment: string): string {
  let current = segment.trim();
  for (;;) {
    const match = /^(?:sudo|doas|env|nohup|time|command|exec|builtin)\s+(?:(?:-[a-z-]+|[a-z_][a-z0-9_]*=\S*)\s+)*/.exec(
      current,
    );
    if (!match || match[0].length === 0) return current;
    current = current.slice(match[0].length).trim();
  }
}

/** Split a normalized command into the parts a shell would run. */
export function commandSegments(normalized: string): string[] {
  return normalized
    .split(/;|&&|\|\||\||\n|&|\(|\)|`|\$\(/)
    .map(stripWrappers)
    .filter(Boolean);
}

function activeRules(config: GuardrailsConfig): GuardrailRule[] {
  const disabled = new Set(config.disabled);
  return [...DEFAULT_GUARDRAIL_RULES, ...config.extraRules].filter((rule) => !disabled.has(rule.id));
}

/** Evaluate one tool call. `policy: off` disables the whole layer. */
export function evaluateToolCallGuardrail(
  payload: { toolName: string; toolInput: unknown },
  config: GuardrailsConfig = DEFAULT_GUARDRAILS_CONFIG,
): GuardrailVerdict {
  if (config.policy === 'off') return { blocked: false };
  const command = commandOf(payload.toolName, payload.toolInput);
  if (!command) return { blocked: false };
  const whole = normalizeCommand(command);
  if (!whole) return { blocked: false };
  const segments = commandSegments(whole);
  for (const rule of activeRules(config)) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, 'i');
    } catch {
      continue;
    }
    const hit = rule.scope === 'whole' ? re.test(whole) : segments.some((segment) => re.test(segment));
    if (hit) {
      return { blocked: true, ruleId: rule.id, category: rule.category, reason: rule.reason };
    }
  }
  return { blocked: false };
}

/** Text shown on the owner's override card. */
export function guardrailReason(verdict: GuardrailVerdict): string | undefined {
  if (!verdict.blocked) return undefined;
  return `Cindy guardrail blocked this command: ${verdict.reason ?? 'destructive command'} (${verdict.ruleId ?? 'rule'}). Allow once to override.`;
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

/** Never throws: a missing or broken file leaves the guard at its defaults. */
export async function loadGuardrailsConfig(
  file: string = defaultGuardrailsFile(),
): Promise<GuardrailsConfig> {
  try {
    return parseGuardrailsYaml(await fs.readFile(file, 'utf8'));
  } catch {
    return { ...DEFAULT_GUARDRAILS_CONFIG };
  }
}

const DEFAULT_FILE_BODY = `# Cindy command guardrails (ROADMAP 11.3). Edit freely; this file is yours.
#
# policy: enforce   # or "off" to disable the deterministic layer entirely
# disabled:         # rule ids to switch off, one per line
#   - git-reset-hard
# rules:            # extra rules; defaults stay armed
#   - id: my-rule
#     category: filesystem
#     scope: segment   # segment (default) or whole
#     pattern: '^rm\\s+-rf\\s+/data'
#     reason: Deleting /data is not allowed.
policy: enforce
disabled: []
`;

/** Writes the commented default file once; never overwrites an existing one. */
export async function ensureGuardrailsFile(file: string = defaultGuardrailsFile()): Promise<void> {
  try {
    await fs.access(file);
    return;
  } catch {
    /* missing: write the template */
  }
  await fs.mkdir(nodePath.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, DEFAULT_FILE_BODY, { mode: 0o600 });
  await fs.rename(tmp, file);
}
