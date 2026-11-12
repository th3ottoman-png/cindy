import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PlanFirstHost } from '../planFirst.js';

let counter = 0;
function tmpFile(): string {
  counter += 1;
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'plan-first-')), `store-${counter}.json`);
}

describe('PlanFirstHost (ROADMAP 11.7)', () => {
  it('starts unlocked and unknown', () => {
    const host = new PlanFirstHost({ file: tmpFile() });
    expect(host.isLocked('s1')).toBe(false);
    expect(host.get('s1')).toMatchObject({ planFirst: false, decided: false, locked: false, decisions: [] });
  });

  it('set(true) locks; decide unlocks with the recorded choices', () => {
    const host = new PlanFirstHost({ file: tmpFile() });
    expect(host.set('s1', true)).toMatchObject({ planFirst: true, decided: false, locked: true });
    expect(host.isLocked('s1')).toBe(true);
    const decided = host.decide('s1', [{ decisionId: 'auth', optionId: 'jwt', summary: 'Auth: JWT' }]);
    expect(decided).toMatchObject({ planFirst: true, decided: true, locked: false });
    expect(decided.decisions).toEqual([{ decisionId: 'auth', optionId: 'jwt', summary: 'Auth: JWT' }]);
    expect(host.isLocked('s1')).toBe(false);
  });

  it('set(false) clears everything; re-enabling starts a fresh interrogation', () => {
    const host = new PlanFirstHost({ file: tmpFile() });
    host.set('s1', true);
    host.decide('s1', [{ decisionId: 'auth', optionId: 'jwt', summary: 'Auth: JWT' }]);
    host.set('s1', false);
    expect(host.get('s1')).toMatchObject({ planFirst: false, locked: false, decisions: [] });
    host.set('s1', true);
    expect(host.get('s1')).toMatchObject({ decided: false, decisions: [] });
  });

  it('persists across instances and sanitizes hostile entries', () => {
    const file = tmpFile();
    const a = new PlanFirstHost({ file });
    a.set('s1', true);
    const b = new PlanFirstHost({ file });
    expect(b.isLocked('s1')).toBe(true);
    fs.writeFileSync(file, JSON.stringify({ s1: [1, 2], s2: null, '': true, s3: { decided: 'yes' } }));
    const c = new PlanFirstHost({ file });
    expect(c.isLocked('s1')).toBe(false);
    // Fail closed on safety: a hostile-but-present entry keeps the lock (chip on, not decided).
    expect(c.isLocked('s3')).toBe(true);
  });

  it('bounds and cleans decide payloads', () => {
    const host = new PlanFirstHost({ file: tmpFile() });
    host.set('s1', true);
    const view = host.decide('s1', [
      { decisionId: '', optionId: 'x', summary: 'blank id dropped' },
      { decisionId: 'a'.repeat(200), optionId: 'b', summary: 'c'.repeat(500) },
    ] as never);
    expect(view.decisions).toHaveLength(1);
    expect(view.decisions[0]?.decisionId).toHaveLength(80);
    expect(view.decisions[0]?.summary).toHaveLength(300);
  });
});
