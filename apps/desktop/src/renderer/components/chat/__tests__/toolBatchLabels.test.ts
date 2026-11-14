/**
 * Tool-batch labels, renderer helpers (ROADMAP 13.4): which groups are reported at a turn end,
 * the stable cache key, reading a deferred group's calls from persisted rows, and the header.
 */

import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '@/lib/makerChatStore';
import type { RenderItem } from '../messageWorkGroups';
import {
  collectLastTurnToolGroups,
  collectWorkGroupToolCalls,
  formatToolBatchHeader,
  historyPageWorkSummaries,
  toolCallsFromPersistedRows,
  toolLabelKeyForWorkGroup,
} from '../toolBatchLabels';

function toolUse(clientId: string, name: string, input: unknown, toolUseId?: string): ChatMessage {
  return {
    clientId,
    role: 'tool_use',
    content: '',
    toolName: name,
    toolInput: input,
    ...(toolUseId ? { toolUseId } : {}),
  } as ChatMessage;
}

function segment(...calls: ChatMessage[]): RenderItem {
  return {
    type: 'tool_segment',
    key: `seg-${calls[0]!.clientId}`,
    toolCalls: calls,
    resultMap: new Map(),
    settledIds: new Set(),
    resultTsMap: new Map(),
  };
}

function group(
  key: string,
  children: RenderItem[],
  isStreaming = false,
  deferred = false,
): RenderItem {
  return {
    type: 'work_group',
    key,
    children: children as never,
    isStreaming,
    ...(deferred
      ? { deferred: { expanded: false, loading: false, failed: false, toggle() {}, retry() {} } }
      : {}),
  };
}

function message(clientId: string, role: 'user' | 'assistant', content = 'x'): RenderItem {
  return { type: 'message', key: clientId, message: { clientId, role, content } as ChatMessage };
}

describe('collectWorkGroupToolCalls', () => {
  it('flattens nested action groups and agent tasks in order', () => {
    const inner = group('work-a', [segment(toolUse('a', 'Read', { file_path: 'x' }, 'toolu_a'))]);
    const task: RenderItem = {
      type: 'agent_task',
      key: 't',
      toolCall: toolUse('t', 'Task', { description: 'review' }),
    };
    const outer = group('work-summary-a', [
      inner,
      message('m', 'assistant'),
      task,
      segment(toolUse('b', 'Bash', { command: 'ls' })),
    ]);
    const calls = collectWorkGroupToolCalls(
      (outer as Extract<RenderItem, { type: 'work_group' }>).children,
    );
    expect(calls.map((c) => [c.id, c.name])).toEqual([
      ['toolu_a', 'Read'],
      ['t', 'Task'],
      ['b', 'Bash'],
    ]);
  });
});

describe('toolLabelKeyForWorkGroup', () => {
  it('is the group render key, present even for a deferred group with no children', () => {
    expect(
      toolLabelKeyForWorkGroup(group('work-a', [segment(toolUse('a', 'Read', {}))]) as never),
    ).toBe('work-a');
    expect(toolLabelKeyForWorkGroup(group('work-b', [], false, true) as never)).toBe('work-b');
  });
});

describe('collectLastTurnToolGroups', () => {
  it('reports only finished groups after the last owner message', () => {
    const items: RenderItem[] = [
      message('u1', 'user'),
      group('work-old', [segment(toolUse('old', 'Read', {}))]),
      message('a1', 'assistant'),
      message('u2', 'user'),
      group('work-1', [
        segment(
          toolUse('c1', 'Read', { file_path: 'a' }),
          toolUse('c2', 'Read', { file_path: 'b' }),
        ),
      ]),
      group('work-empty', [message('th', 'assistant')]),
      group('work-2', [segment(toolUse('c3', 'Bash', { command: 'pnpm test' }))]),
      group('work-live', [segment(toolUse('c4', 'Bash', {}))], true),
      message('a2', 'assistant'),
    ];
    expect(collectLastTurnToolGroups(items)).toEqual([
      {
        key: 'work-1',
        deferred: false,
        calls: [
          { name: 'Read', input: { file_path: 'a' } },
          { name: 'Read', input: { file_path: 'b' } },
        ],
      },
      {
        key: 'work-2',
        deferred: false,
        calls: [{ name: 'Bash', input: { command: 'pnpm test' } }],
      },
    ]);
  });
  it('marks a deferred history group (children not loaded) for a persisted read', () => {
    expect(
      collectLastTurnToolGroups([message('u', 'user'), group('work-d', [], false, true)]),
    ).toEqual([{ key: 'work-d', deferred: true, calls: [] }]);
  });
  it('returns nothing when the turn had no tool calls', () => {
    expect(collectLastTurnToolGroups([message('u', 'user'), message('a', 'assistant')])).toEqual(
      [],
    );
  });
});

describe('persisted reads', () => {
  it('extracts tool calls from persisted rows (content: { toolName, input })', () => {
    expect(
      toolCallsFromPersistedRows([
        { role: 'assistant', content: 'hi' },
        {
          role: 'tool_use',
          content: { toolUseId: '1', toolName: 'terminal', input: { command: 'ls' } },
        },
        { role: 'tool_result', content: { toolUseId: '1' } },
        { role: 'tool_use', content: { toolName: '' } },
      ]),
    ).toEqual([{ name: 'terminal', input: { command: 'ls' } }]);
  });
  it('finds outer, nested and deferred work summaries in a history page', () => {
    const page = {
      items: [
        { type: 'messages', key: 'm' },
        {
          type: 'work',
          summary: { key: 'work-summary-a' },
          children: [{ type: 'work', summary: { key: 'work-a' } }],
        },
        { type: 'messages', key: 'n', deferred: { key: 'work-b' } },
      ],
    };
    expect(historyPageWorkSummaries(page).map((s) => s.key)).toEqual([
      'work-summary-a',
      'work-a',
      'work-b',
    ]);
    expect(historyPageWorkSummaries(null)).toEqual([]);
  });
});

describe('formatToolBatchHeader', () => {
  it('keeps the count as the suffix', () => {
    expect(formatToolBatchHeader('Updated auth tests', 7)).toBe('Updated auth tests · 7 tools');
    expect(formatToolBatchHeader('Read config', 1)).toBe('Read config · 1 tool');
  });
});
