import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { TurnAuditHost, registerTurnAuditHandlers } from '../turnAudit.js';

const dir = () => mkdtempSync(join(tmpdir(), 'cindy-turn-audit-'));
const fence = (body: string) => `\`\`\`cindy-audit\n${body}\n\`\`\``;

describe('TurnAuditHost (ROADMAP 11.10)', () => {
  it('is off for an unknown session and an empty id', () => {
    const host = new TurnAuditHost({ file: join(dir(), 'turn-audit.json') });
    expect(host.isOn('s1')).toBe(false);
    expect(host.isOn('')).toBe(false);
  });

  it('persists the flag across instances and clears the entry when turned off', () => {
    const file = join(dir(), 'turn-audit.json');
    expect(new TurnAuditHost({ file }).set('s1', true)).toEqual({
      sessionId: 's1',
      turnAudit: true,
    });
    new TurnAuditHost({ file }).set('s2', true);
    expect(new TurnAuditHost({ file }).isOn('s1')).toBe(true);
    new TurnAuditHost({ file }).set('s1', false);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ s2: true });
  });

  it('ignores a corrupt or hostile file', () => {
    const file = join(dir(), 'turn-audit.json');
    writeFileSync(file, '{ nope', 'utf8');
    expect(new TurnAuditHost({ file }).isOn('s1')).toBe(false);
    writeFileSync(file, JSON.stringify({ s1: 'yes', s2: true }), 'utf8');
    expect(new TurnAuditHost({ file }).isOn('s1')).toBe(false);
    expect(new TurnAuditHost({ file }).isOn('s2')).toBe(true);
  });

  it('summarizes the session from its stored messages, flag included', async () => {
    const file = join(dir(), 'turn-audit.json');
    const host = new TurnAuditHost({
      file,
      listMessages: async (sessionId) =>
        sessionId === 's1'
          ? [
              { role: 'user', content: 'refactor' },
              {
                role: 'assistant',
                content: `done\n${fence('{"progress":60,"assumptions":[{"text":"Redis on 6379","confidence":60,"verify":"redis-cli ping"}]}')}`,
              },
            ]
          : [],
    });
    host.set('s1', true);
    const view = await host.summary('s1');
    expect(view.turnAudit).toBe(true);
    expect(view.audit.progress).toBe(60);
    expect(view.audit.lowConfidenceCount).toBe(1);
    expect(view.audit.assumptions[0]).toMatchObject({
      text: 'Redis on 6379',
      low: true,
      verify: 'redis-cli ping',
      turn: 1,
    });
    expect((await host.summary('s2')).audit.auditedTurns).toBe(0);
  });

  it('registers GET/SET/SUMMARY handlers that check the sender and validate input', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();
    const trusted: unknown[] = [];
    const host = new TurnAuditHost({
      file: join(dir(), 'turn-audit.json'),
      listMessages: async () => [],
    });
    registerTurnAuditHandlers(
      { handle: (channel, listener) => handlers.set(channel, listener) },
      {
        host,
        assertTrusted: (event) => trusted.push(event),
        channels: { GET: 'get', SET: 'set', SUMMARY: 'summary' },
      },
    );
    expect(await handlers.get('set')!('e1', { sessionId: 's1', turnAudit: true })).toEqual({
      sessionId: 's1',
      turnAudit: true,
    });
    expect(await handlers.get('get')!('e2', { sessionId: 's1' })).toEqual({
      sessionId: 's1',
      turnAudit: true,
    });
    expect(await handlers.get('summary')!('e3', { sessionId: 's1' })).toMatchObject({
      turnAudit: true,
    });
    await expect(
      Promise.resolve().then(() =>
        handlers.get('set')!('e4', { sessionId: 's1', turnAudit: 'yes' }),
      ),
    ).rejects.toThrow('turnAudit must be a boolean');
    await expect(Promise.resolve().then(() => handlers.get('get')!('e5', {}))).rejects.toThrow(
      'sessionId is required',
    );
    expect(trusted).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
  });
});
