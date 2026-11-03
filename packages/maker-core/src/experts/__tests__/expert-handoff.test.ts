import { describe, expect, it } from 'vitest';

import type { ExportSession } from '../../export/session-markdown';
import { buildExpertHandoff, buildGoAheadHandoff, DEFAULT_HANDOFF_QUESTION } from '../expert-handoff';

const EXPERT = { slug: 'reviewer', name: 'Code Reviewer' };
const SESSION: ExportSession = {
  title: 'Fix the login bug',
  agent: 'hermes',
  model: 'hermes-default',
  messages: [
    { role: 'user', text: 'Why does login fail?' },
    { role: 'assistant', text: 'Checking logs.', toolCalls: [{ name: 'read_file', input: { path: 'auth.log' }, output: 'SECRET-PAYLOAD-LINE' }] },
    { role: 'assistant', text: 'The token expires too early.' },
  ],
};

function ok(r: ReturnType<typeof buildExpertHandoff>): Exclude<ReturnType<typeof buildExpertHandoff>, { error: string }> {
  if ('error' in r) throw new Error(`unexpected error: ${r.message}`);
  return r;
}

describe('buildExpertHandoff', () => {
  it('builds a prompt with the source, the owner question and every message in order', () => {
    const r = ok(buildExpertHandoff(EXPERT, SESSION, { question: 'Is the fix safe?' }));
    expect(r).toMatchObject({ expertSlug: 'reviewer', includedMessages: 3, omittedMessages: 0, truncated: false });
    expect(r.prompt).toContain('Source session: "Fix the login bug" (agent hermes, model hermes-default)');
    expect(r.prompt).toContain("Owner's question: Is the fix safe?");
    expect(r.prompt.indexOf('Owner: Why does login fail?')).toBeLessThan(r.prompt.indexOf('Assistant: The token expires too early.'));
  });

  it('uses the default question when none or a blank one is given', () => {
    expect(ok(buildExpertHandoff(EXPERT, SESSION)).prompt).toContain(DEFAULT_HANDOFF_QUESTION);
    expect(ok(buildExpertHandoff(EXPERT, SESSION, { question: '   ' })).prompt).toContain(DEFAULT_HANDOFF_QUESTION);
  });

  it('shows tool calls by name only and never their input or output', () => {
    const r = ok(buildExpertHandoff(EXPERT, SESSION));
    expect(r.prompt).toContain('(tools used: read_file)');
    expect(r.prompt).not.toContain('SECRET-PAYLOAD-LINE');
    expect(r.prompt).not.toContain('auth.log');
  });

  it('redacts credentials in message text', () => {
    const r = ok(buildExpertHandoff(EXPERT, { ...SESSION, messages: [{ role: 'user', text: 'my key is sk-abcdefghijklmnop1234 ok' }] }));
    expect(r.prompt).not.toContain('sk-abcdef');
    expect(r.prompt).toContain('[redacted]');
  });

  it('keeps the NEWEST messages within the budget and says how many were dropped', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, text: `message-${i} ${'x'.repeat(100)}` }));
    const r = ok(buildExpertHandoff(EXPERT, { ...SESSION, messages }, { maxChars: 350 }));
    expect(r.truncated).toBe(true);
    expect(r.omittedMessages).toBeGreaterThan(0);
    expect(r.includedMessages + r.omittedMessages).toBe(10);
    expect(r.prompt).toContain('message-9');
    expect(r.prompt).not.toContain('message-0');
    expect(r.prompt).toContain(`${r.omittedMessages} older omitted`);
  });

  it('always keeps the newest message even when it alone is over budget, cut by the per-message cap', () => {
    const r = ok(
      buildExpertHandoff(EXPERT, { ...SESSION, messages: [{ role: 'user', text: 'y'.repeat(500) }] }, { maxChars: 10, maxMessageChars: 40 }),
    );
    expect(r.includedMessages).toBe(1);
    expect(r.truncated).toBe(true);
    expect(r.prompt).toContain('460 more characters cut');
  });

  it('refuses an empty source session and an unloaded expert instead of producing a prompt', () => {
    expect(buildExpertHandoff(EXPERT, { ...SESSION, messages: [{ role: 'assistant', text: '  ' }] })).toMatchObject({ error: 'no-messages' });
    expect(buildExpertHandoff({ slug: '', name: '' }, SESSION)).toMatchObject({ error: 'expert-unavailable' });
  });
});

describe('buildGoAheadHandoff (ROADMAP 3.10c)', () => {
  const PICKED: ExportSession = {
    title: 'Suggest tasks',
    agent: 'hermes',
    model: 'hermes-default',
    messages: [
      { role: 'user', text: 'Suggest ways to save time here.' },
      { role: 'assistant', text: 'Option 1: a CSV normalizer. Option 2: a lint script.', toolCalls: [{ name: 'web_search', input: { q: 'x' }, output: 'SECRET-PAYLOAD-LINE' }] },
      { role: 'user', text: 'Option 1, go ahead and do it' },
    ],
  };

  it('asks the new task to carry out the picked option, with the conversation and no expert framing', () => {
    const r = buildGoAheadHandoff(PICKED);
    if ('error' in r) throw new Error(r.message);
    expect(r).toMatchObject({ includedMessages: 3, omittedMessages: 0, truncated: false });
    expect(r.prompt).toContain('Source session: "Suggest tasks" (agent hermes, model hermes-default)');
    expect(r.prompt).toMatch(/carry out the option the owner picked/i);
    expect(r.prompt).toMatch(/could not read files or run commands/i);
    expect(r.prompt).not.toContain('wants your take');
    expect(r.prompt).not.toContain('You have no tools');
    expect(r.prompt.indexOf('Owner: Suggest ways')).toBeLessThan(r.prompt.indexOf('Owner: Option 1, go ahead and do it'));
    expect(r.prompt).toContain('(tools used: web_search)');
    expect(r.prompt).not.toContain('SECRET-PAYLOAD-LINE');
  });

  it('keeps the newest messages within the budget and refuses an empty session', () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, text: `message-${i} ${'x'.repeat(100)}` }));
    const r = buildGoAheadHandoff({ ...PICKED, messages }, { maxChars: 350 });
    if ('error' in r) throw new Error(r.message);
    expect(r.prompt).toContain('message-9');
    expect(r.prompt).not.toContain('message-0');
    expect(buildGoAheadHandoff({ ...PICKED, messages: [{ role: 'assistant', text: ' ' }] })).toMatchObject({ error: 'no-messages' });
  });
});
