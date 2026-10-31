import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { nextRun, parseCron } from '../../../../maker-scheduler/src/engine/cron';
import { buildScheduledPrompt, dueSchedules, loadSchedules, parseSchedule, resolveOutputPath, type CronApi, type Schedule } from '../scheduled-sessions';

// The real upstream cron implementation, not a fake: the contract is that it satisfies CronApi.
const cron: CronApi = { parseCron, nextRun };

const FILE = '/s/morning-brief.md';
const GOOD = '---\nexpert: researcher\ncron: "0 8 * * 1-5"\ntimezone: Europe/Berlin\n---\nSummarise my notes.\n';

function ok(raw: string, file = FILE): Schedule {
  const e = parseSchedule(file, raw, cron);
  if (!e.ok) throw new Error(e.error);
  return e.schedule;
}
const err = (raw: string, file = FILE) => {
  const e = parseSchedule(file, raw, cron);
  return e.ok ? '' : e.error;
};

describe('parseSchedule', () => {
  it('parses a good file with defaults', () => {
    expect(ok(GOOD)).toEqual({
      id: 'morning-brief',
      file: FILE,
      expert: 'researcher',
      cron: '0 8 * * 1-5',
      timezone: 'Europe/Berlin',
      enabled: true,
      output: 'schedules/morning-brief.md',
      prompt: 'Summarise my notes.',
    });
    expect(ok('---\nexpert: a\ncron: "*/5 * * * *"\n---\nx').timezone).toBe('UTC');
  });

  it('rejects missing fields, bad cron, bad timezone, empty prompt, bad id', () => {
    expect(err('---\ncron: "0 8 * * *"\n---\nx')).toMatch(/expert/);
    expect(err('---\nexpert: a\n---\nx')).toMatch(/cron/);
    expect(err('---\nexpert: a\ncron: "61 * * * *"\n---\nx')).not.toBe('');
    expect(err('---\nexpert: a\ncron: "0 8 * *"\n---\nx')).toMatch(/5 fields/);
    expect(err('---\nexpert: a\ncron: "0 8 * * *"\ntimezone: Mars/Base\n---\nx')).toMatch(/timezone/);
    expect(err('---\nexpert: a\ncron: "0 8 * * *"\n---\n   \n')).toMatch(/empty/);
    expect(err(GOOD, '/s/Bad Name.md')).toMatch(/file name/);
    expect(err('---\nexpert: a\ncron: "0 8 * * *"\nenabled: "no"\n---\nx')).toMatch(/enabled/);
  });

  it('only allows an output path that stays inside a vault', () => {
    for (const out of ['../x.md', '/etc/x.md', 'a.txt', '.hidden/x.md']) {
      expect(err(`---\nexpert: a\ncron: "0 8 * * *"\noutput: ${out}\n---\nx`)).toMatch(/output/);
    }
    expect(ok('---\nexpert: a\ncron: "0 8 * * *"\noutput: "briefs/{date}.md"\n---\nx').output).toBe('briefs/{date}.md');
  });
});

describe('loadSchedules', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('lists good and bad files side by side, ignores non-md and dotfiles, tolerates a missing dir', () => {
    fs.writeFileSync(path.join(dir, 'good.md'), GOOD);
    fs.writeFileSync(path.join(dir, 'broken.md'), '---\nexpert: a\n---\nx');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(dir, '.hidden.md'), GOOD);
    const entries = loadSchedules(dir, cron);
    expect(entries.map((e) => (e.ok ? `ok:${e.schedule.id}` : `err:${e.id}`))).toEqual(['err:broken', 'ok:good']);
    expect(loadSchedules(path.join(dir, 'nope'), cron)).toEqual([]);
  });
});

describe('dueSchedules', () => {
  // Weekdays 08:00 UTC. 2026-10-30 is a Friday.
  const s = ok('---\nexpert: a\ncron: "0 8 * * 1-5"\n---\nx', '/s/job.md');
  const at = (iso: string) => Date.parse(iso);

  it('is due once the next fire after the last run has passed', () => {
    const last = { job: at('2026-10-29T08:00:00Z') };
    expect(dueSchedules([s], last, at('2026-10-30T07:59:00Z'), cron)).toEqual([]);
    expect(dueSchedules([s], last, at('2026-10-30T08:00:00Z'), cron)).toEqual([s]);
  });

  it('runs once after downtime, not once per missed fire', () => {
    const last = { job: at('2026-10-20T08:00:00Z') };
    expect(dueSchedules([s], last, at('2026-10-30T09:00:00Z'), cron)).toHaveLength(1);
    // After that single run is recorded it is not due again until the next fire.
    expect(dueSchedules([s], { job: at('2026-10-30T09:00:00Z') }, at('2026-10-30T09:05:00Z'), cron)).toEqual([]);
  });

  it('never backfills a schedule it has not run before', () => {
    expect(dueSchedules([s], {}, at('2026-10-30T09:00:00Z'), cron)).toEqual([]);
    // Its clock can be anchored earlier by the caller (first seen yesterday).
    expect(dueSchedules([s], {}, at('2026-10-30T09:00:00Z'), cron, { job: at('2026-10-29T12:00:00Z') })).toEqual([s]);
  });

  it('skips disabled schedules and treats a throwing cron as not due', () => {
    const off = { ...s, enabled: false };
    expect(dueSchedules([off], { job: 0 }, at('2026-10-30T09:00:00Z'), cron)).toEqual([]);
    const broken: CronApi = { parseCron, nextRun: () => { throw new Error('boom'); } };
    expect(dueSchedules([s], { job: 0 }, at('2026-10-30T09:00:00Z'), broken)).toEqual([]);
  });

  it('honours the schedule timezone', () => {
    const berlin = ok('---\nexpert: a\ncron: "0 8 * * *"\ntimezone: Europe/Berlin\n---\nx', '/s/de.md');
    const last = { de: at('2026-10-29T07:00:00Z') };
    // 08:00 Berlin on 2026-10-30 (CET after the DST switch, UTC+1) is 07:00 UTC.
    expect(dueSchedules([berlin], last, at('2026-10-30T06:59:00Z'), cron)).toEqual([]);
    expect(dueSchedules([berlin], last, at('2026-10-30T07:00:00Z'), cron)).toEqual([berlin]);
  });
});

describe('resolveOutputPath / buildScheduledPrompt', () => {
  const now = new Date('2026-10-30T08:00:00Z');
  it('fills {date} in the output path', () => {
    expect(resolveOutputPath({ output: 'briefs/{date}.md' }, now)).toBe('briefs/2026-10-30.md');
    expect(resolveOutputPath({ output: 'schedules/job.md' }, now)).toBe('schedules/job.md');
  });
  it('puts a fixed header before the owner prompt', () => {
    const p = buildScheduledPrompt({ id: 'job', cron: '0 8 * * 1-5', prompt: 'Do the thing.' }, now);
    expect(p.startsWith('[Scheduled run "job" (0 8 * * 1-5) at 2026-10-30T08:00:00.000Z.')).toBe(true);
    expect(p.endsWith('\n\nDo the thing.')).toBe(true);
  });
});
