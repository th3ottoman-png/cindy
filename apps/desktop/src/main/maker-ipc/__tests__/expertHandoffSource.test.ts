import { describe, expect, it } from 'vitest';

import type { HandoffSourceMessage } from '../agentHandoff';
import { toExpertHandoffMessages } from '../expertHandoffSource';

const row = (role: string, content: unknown, createdAt = 1): HandoffSourceMessage => ({ role, content, createdAt });

describe('toExpertHandoffMessages (ROADMAP 3.6b)', () => {
  it('adapts stored rows: owner and assistant text, tool calls by name on the next assistant, payloads dropped', () => {
    const out = toExpertHandoffMessages([
      row('user', JSON.stringify({ text: 'Plan my route', images: [], files: [] })),
      row('tool_use', { toolUseId: 't1', toolName: 'read_file', input: { path: '/secret/input.txt' } }),
      row('tool_result', 'TOOL OUTPUT PAYLOAD'),
      row('tool_use', { toolUseId: 't2', toolName: 'web_search', input: { query: 'q' } }),
      row('assistant', 'Here is the route.'),
      row('user', { text: '[UI_ACTION_TRIGGER] internal' }),
      row('system', 'compacted'),
      row('user', 'Thanks'),
    ]);
    expect(out).toEqual([
      { role: 'user', text: 'Plan my route' },
      { role: 'assistant', text: 'Here is the route.', toolCalls: [{ name: 'read_file' }, { name: 'web_search' }] },
      { role: 'user', text: 'Thanks' },
    ]);
    expect(JSON.stringify(out)).not.toContain('TOOL OUTPUT PAYLOAD');
    expect(JSON.stringify(out)).not.toContain('/secret/input.txt');
  });

  it('keeps tool calls that no assistant text followed as a tools-only assistant entry', () => {
    expect(toExpertHandoffMessages([
      row('user', 'go'),
      row('tool_use', { toolName: 'terminal', input: {} }),
      row('user', 'stop'),
      row('tool_use', { toolName: 'read_file', input: {} }),
    ])).toEqual([
      { role: 'user', text: 'go' },
      { role: 'assistant', text: '', toolCalls: [{ name: 'terminal' }] },
      { role: 'user', text: 'stop' },
      { role: 'assistant', text: '', toolCalls: [{ name: 'read_file' }] },
    ]);
  });
});
