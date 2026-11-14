/**
 * Tool-batch labels, renderer side (ROADMAP 13.4, blueprint §6).
 *
 * Main owns routing, the model call and the cache file. The renderer only (a) reads the cached
 * labels for the open session, (b) reports the finished top-level work groups of the turn that
 * just ended, and (c) shows a label in the group header when one exists. The header renders
 * its generic text first and swaps when a label arrives — it never waits on the label.
 */

import { useEffect, useRef, useSyncExternalStore } from 'react';

import type { RenderItem, WorkGroupChildItem } from './messageWorkGroups';

export interface ToolBatchLabel {
  label: string;
  toolCount: number;
  routeName: string;
  model: string;
  provider: string;
  createdAt: number;
}

export type ToolBatchLabelMap = Record<string, ToolBatchLabel>;

type WorkGroupItem = Extract<RenderItem, { type: 'work_group' }>;

export interface ToolBatchCall {
  name: string;
  input: unknown;
}

/** Every tool call inside a group, in order, including nested action groups and agent tasks. */
export function collectWorkGroupToolCalls(
  children: readonly WorkGroupChildItem[],
  out: Array<ToolBatchCall & { id: string }> = [],
): Array<ToolBatchCall & { id: string }> {
  for (const child of children) {
    if (child.type === 'work_group') {
      collectWorkGroupToolCalls(child.children, out);
    } else if (child.type === 'tool_segment') {
      for (const call of child.toolCalls) {
        out.push({
          id: call.toolUseId ?? call.clientId,
          name: call.toolName ?? 'tool',
          input: call.toolInput,
        });
      }
    } else if (child.type === 'agent_task' && child.toolCall) {
      const call = child.toolCall;
      out.push({
        id: call.toolUseId ?? call.clientId,
        name: call.toolName ?? 'Agent',
        input: call.toolInput,
      });
    }
  }
  return out;
}

/**
 * The cache key: the group's own render key (`work-<anchor client id>`). The anchor is the first
 * activity's persisted client id, so the key is the same live and after a reload — and it is
 * there even when a finished group is a deferred history group whose children are not loaded.
 */
export function toolLabelKeyForWorkGroup(item: WorkGroupItem): string {
  return item.key;
}

/**
 * The finished top-level work groups after the last owner message: the turn that just ended.
 * A deferred history group has no children in hand, so its `calls` are empty and `deferred` is
 * true: the caller reads them from the persisted range (see `readDeferredGroupCalls`).
 */
export function collectLastTurnToolGroups(
  items: readonly RenderItem[],
): Array<{ key: string; calls: ToolBatchCall[]; deferred: boolean }> {
  let start = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.type === 'message' && item.message.role === 'user') {
      start = i + 1;
      break;
    }
  }
  const groups: Array<{ key: string; calls: ToolBatchCall[]; deferred: boolean }> = [];
  for (const item of items.slice(start)) {
    if (item.type !== 'work_group' || item.isStreaming) continue;
    const calls = collectWorkGroupToolCalls(item.children);
    const deferred = calls.length === 0 && item.deferred !== undefined;
    if (calls.length === 0 && !deferred) continue;
    groups.push({
      key: item.key,
      calls: calls.map(({ name, input }) => ({ name, input })),
      deferred,
    });
  }
  return groups;
}

/** A persisted tool_use row as the history detail read returns it. */
interface PersistedRow {
  role?: unknown;
  content?: unknown;
}

/** The tool calls in persisted rows, in order (`content: { toolName, input }`). */
export function toolCallsFromPersistedRows(rows: readonly PersistedRow[]): ToolBatchCall[] {
  const calls: ToolBatchCall[] = [];
  for (const row of rows) {
    if (row.role !== 'tool_use' || !row.content || typeof row.content !== 'object') continue;
    const content = row.content as { toolName?: unknown; input?: unknown };
    if (typeof content.toolName !== 'string' || !content.toolName) continue;
    calls.push({ name: content.toolName, input: content.input });
  }
  return calls;
}

interface HistoryWorkSummaryLike {
  key: string;
  [field: string]: unknown;
}

/** Every work summary in a history-view page, outer and nested. */
export function historyPageWorkSummaries(page: unknown): HistoryWorkSummaryLike[] {
  const out: HistoryWorkSummaryLike[] = [];
  const walk = (items: unknown): void => {
    if (!Array.isArray(items)) return;
    for (const item of items as Array<Record<string, unknown>>) {
      if (item?.type === 'work') {
        const summary = item.summary as HistoryWorkSummaryLike | undefined;
        if (summary && typeof summary.key === 'string') out.push(summary);
        walk(item.children);
      } else if (
        item?.deferred &&
        typeof (item.deferred as HistoryWorkSummaryLike).key === 'string'
      ) {
        out.push(item.deferred as HistoryWorkSummaryLike);
      }
    }
  };
  walk((page as { items?: unknown } | null)?.items);
  return out;
}

/** Bound on detail pages per group, so a malformed cursor can never loop. */
const MAX_DETAIL_PAGES = 20;

/** Read a deferred group's tool calls from its persisted range, through the existing reads. */
async function readDeferredGroupCalls(
  sessionId: string,
  keys: readonly string[],
): Promise<Map<string, ToolBatchCall[]>> {
  const result = new Map<string, ToolBatchCall[]>();
  const api = typeof window !== 'undefined' ? window.electronAPI?.localDb?.messages : undefined;
  if (!api || keys.length === 0) return result;
  const page = await api.historyView(sessionId, { lazyDetails: true });
  const summaries = historyPageWorkSummaries(page);
  for (const key of keys) {
    const summary = summaries.find((s) => s.key === key);
    if (!summary) continue;
    const rows: PersistedRow[] = [];
    let after: string | null = null;
    for (let i = 0; i < MAX_DETAIL_PAGES; i += 1) {
      // The summary comes straight from historyView, so it is the reference workDetails expects.
      const ref =
        summary as unknown as import('@cindy/maker-shared/message-window').HistoryWorkReference;
      const detail = (await api.workDetails(sessionId, ref, after ? { after } : undefined)) as {
        messages?: PersistedRow[];
        hasMore?: boolean;
        nextCursor?: string | null;
      } | null;
      rows.push(...(detail?.messages ?? []));
      if (!detail?.hasMore || !detail.nextCursor || detail.nextCursor === after) break;
      after = detail.nextCursor;
    }
    const calls = toolCallsFromPersistedRows(rows);
    if (calls.length > 0) result.set(key, calls);
  }
  return result;
}

/** `Updated auth tests · 7 tools` — the count always stays as the suffix. */
export function formatToolBatchHeader(label: string, toolCount: number): string {
  const n = Math.max(0, Math.floor(toolCount));
  return `${label} · ${n} ${n === 1 ? 'tool' : 'tools'}`;
}

// ── Store: one cached map per session, shared by every group header ──────────────────────────

const labelsBySession = new Map<string, ToolBatchLabelMap>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function setToolBatchLabels(sessionId: string, labels: ToolBatchLabelMap): void {
  labelsBySession.set(sessionId, labels);
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The cached label for one group, or undefined (generic header). */
export function useToolBatchLabel(
  sessionId: string | undefined,
  key: string | null,
): ToolBatchLabel | undefined {
  return useSyncExternalStore(subscribe, () =>
    sessionId && key ? labelsBySession.get(sessionId)?.[key] : undefined,
  );
}

/** Let the groups settle (turnCompleted / DB echo) before reading the final shape. */
export const TOOL_LABEL_SETTLE_MS = 1_500;

function toolLabelApi() {
  return typeof window !== 'undefined' ? window.electronAPI?.maker?.toolLabel : undefined;
}

/**
 * Loads the cached labels when a session opens (cache only — no model call), and on each
 * running-to-idle edge within the same session reports the just-finished groups to main.
 * Fire-and-forget: a label can never block or break the chat loop.
 */
export function useToolBatchLabelsAfterTurn(
  sessionId: string | undefined,
  running: boolean,
  items: readonly RenderItem[],
): void {
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const last = useRef<{ id: string | undefined; running: boolean }>({
    id: undefined,
    running: false,
  });

  useEffect(() => {
    const api = toolLabelApi();
    if (!sessionId || !api) return;
    let cancelled = false;
    void api
      .getLabels(sessionId)
      .then((labels) => {
        if (!cancelled) setToolBatchLabels(sessionId, labels ?? {});
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    const prev = last.current;
    last.current = { id: sessionId, running };
    if (!sessionId || running || prev.id !== sessionId || !prev.running) return;
    const api = toolLabelApi();
    if (!api) return;
    const timer = window.setTimeout(() => {
      const found = collectLastTurnToolGroups(itemsRef.current);
      if (found.length === 0) return;
      void (async () => {
        const deferredCalls = await readDeferredGroupCalls(
          sessionId,
          found.filter((g) => g.deferred).map((g) => g.key),
        );
        const groups = found
          .map((g) => ({
            key: g.key,
            calls: g.deferred ? (deferredCalls.get(g.key) ?? []) : g.calls,
          }))
          .filter((g) => g.calls.length > 0);
        if (groups.length === 0) return;
        const labels = await api.labelGroups({ sessionId, groups });
        if (labels) setToolBatchLabels(sessionId, labels);
      })().catch(() => undefined);
    }, TOOL_LABEL_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [sessionId, running]);
}
