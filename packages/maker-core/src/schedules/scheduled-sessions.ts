/**
 * Scheduled sessions, local (ROADMAP 5.4a).
 *
 * A schedule is a Markdown file `<dir>/<id>.md`: YAML frontmatter (`expert`, `cron`, optional
 * `timezone`, `enabled`, `output`) and a body that is the fixed prompt. Files are the source of
 * truth; this module only reads them. It decides WHICH schedules are due and WHAT to run; it
 * never starts a session. The cron maths is injected (`CronApi`, satisfied by
 * `@cindy/maker-scheduler/cron`: `parseCron`, `nextRun`) so nothing is reimplemented here and
 * maker-core takes no new dependency. Running the session (upstream scheduler) and writing the
 * result into the vault (5.1a `appendNote`) is 5.4b.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import matter from 'gray-matter';

import { checkNotePath } from '../notes/vault-notes';

export interface CronApi {
  /** Throws on an invalid expression. */
  parseCron(expr: string): unknown;
  /** Epoch ms of the first fire strictly after `fromMs` in `tz`. */
  nextRun(expr: string, fromMs: number, tz: string): number;
}

export interface Schedule {
  id: string;
  file: string;
  expert: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  /** Vault-relative note the result goes to; `{date}` becomes YYYY-MM-DD. */
  output: string;
  prompt: string;
}

export type ScheduleEntry = { ok: true; schedule: Schedule } | { ok: false; id: string; file: string; error: string };

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function parseSchedule(file: string, raw: string, cron: CronApi): ScheduleEntry {
  const id = path.basename(file, '.md');
  const bad = (error: string): ScheduleEntry => ({ ok: false, id, file, error });
  if (!ID_RE.test(id)) return bad('file name must be lowercase letters, digits and dashes');
  let parsed: matter.GrayMatterFile<string>;
  try {
    // gray-matter caches by input string; pass an empty options object to skip the cache
    parsed = matter(raw, {});
  } catch (err) {
    return bad(`invalid frontmatter: ${err instanceof Error ? err.message : String(err)}`);
  }
  const d = parsed.data as Record<string, unknown>;
  const str = (k: string): string | undefined => (typeof d[k] === 'string' && (d[k] as string).trim() ? (d[k] as string).trim() : undefined);

  const expert = str('expert');
  if (!expert) return bad('frontmatter "expert" is required');
  const expr = str('cron');
  if (!expr) return bad('frontmatter "cron" is required');
  try {
    cron.parseCron(expr);
  } catch (err) {
    return bad(err instanceof Error ? err.message : String(err));
  }
  const timezone = str('timezone') ?? 'UTC';
  if (!isValidTimezone(timezone)) return bad(`unknown timezone "${timezone}"`);
  if (d.enabled !== undefined && typeof d.enabled !== 'boolean') return bad('"enabled" must be true or false');
  const prompt = parsed.content.trim();
  if (!prompt) return bad('the prompt (file body) is empty');

  const output = str('output') ?? `schedules/${id}.md`;
  const outCheck = checkNotePath(output.replace('{date}', '2000-01-01'));
  if (!outCheck.ok) return bad(`"output": ${outCheck.message}`);

  return { ok: true, schedule: { id, file, expert, cron: expr, timezone, enabled: d.enabled !== false, output, prompt } };
}

/** Read every `*.md` in `dir`. A bad file is returned with its error and never hides the others. */
export function loadSchedules(dir: string, cron: CronApi): ScheduleEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.md') && !n.startsWith('.'));
  } catch {
    return [];
  }
  return names.sort().map((n): ScheduleEntry => {
    const file = path.join(dir, n);
    try {
      return parseSchedule(file, fs.readFileSync(file, 'utf8'), cron);
    } catch (err) {
      return { ok: false, id: path.basename(n, '.md'), file, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

/**
 * Schedules that should run now. `lastRunMs[id]` is when each last started. A schedule with no
 * recorded run is never due immediately (no backfill): its clock starts at `firstSeenMs`
 * (default `nowMs`). After downtime a schedule is due ONCE, however many fires were missed.
 */
export function dueSchedules(
  schedules: readonly Schedule[],
  lastRunMs: Readonly<Record<string, number>>,
  nowMs: number,
  cron: CronApi,
  firstSeenMs: Readonly<Record<string, number>> = {},
): Schedule[] {
  return schedules.filter((s) => {
    if (!s.enabled) return false;
    const since = lastRunMs[s.id] ?? firstSeenMs[s.id] ?? nowMs;
    try {
      return cron.nextRun(s.cron, since, s.timezone) <= nowMs;
    } catch {
      return false;
    }
  });
}

/** Vault-relative note for this run's result. */
export function resolveOutputPath(s: Pick<Schedule, 'output'>, now: Date): string {
  return s.output.replace('{date}', now.toISOString().slice(0, 10));
}

/** The first message of the scheduled session: a fixed header, then the owner's prompt. */
export function buildScheduledPrompt(s: Pick<Schedule, 'id' | 'cron' | 'prompt'>, now: Date): string {
  return `[Scheduled run "${s.id}" (${s.cron}) at ${now.toISOString()}. No one is watching this session: finish the task and reply with the result only.]\n\n${s.prompt}`;
}
