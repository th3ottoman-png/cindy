/**
 * Operations rail projection (ROADMAP 8.6).
 *
 * One flat, ordered view of the local runtime: the active Hermes turn, Orca
 * workers, bots and scheduled sessions. Callers supply the facts; this module
 * decides ordering, status labels, relative times and which actions each row
 * offers. No I/O, no clock, no network. `nowMs` is injected so a test can pin
 * time.
 *
 * Kinds are open strings and actions come from a data table, so a new runtime
 * needs a new fact mapper, not a new switch (AGENTS.md section 6.2).
 */

/** Display order for the sections. */
export const OPERATION_KIND_ORDER: readonly string[] = ['turn', 'worker', 'bot', 'schedule'];

/** Actions a row may offer. The renderer owns what each one does. */
export const OPERATION_ACTIONS = ['cancel', 'open', 'replay', 'run-now', 'dry-run'] as const;
export type OperationAction = (typeof OPERATION_ACTIONS)[number];

export type OperationStatus =
  | 'running'
  | 'idle'
  | 'success'
  | 'failed'
  | 'scheduled'
  | 'unknown';

export interface OperationTurnFact {
  id: string;
  title: string;
  streaming: boolean;
  /** Last assistant or tool line, already truncated by the caller. */
  lastOutput?: string;
  startedAtMs?: number | null;
}

export interface OperationWorkerFact {
  id: string;
  title: string;
  /** Session status as stored locally, for example active, idle, archived. */
  status?: string;
  lastOutput?: string;
  atMs?: number | null;
}

export interface OperationBotFact {
  id: string;
  title: string;
  availability?: string;
  lastOutput?: string;
  atMs?: number | null;
}

export interface OperationScheduleFact {
  id: string;
  title: string;
  enabled: boolean;
  /** Last run status as recorded locally: success, failed, or undefined. */
  lastStatus?: string;
  lastRunMs?: number | null;
  /** Epoch ms of the next fire, when the caller can compute it. */
  nextRunMs?: number | null;
  lastOutput?: string;
  notePath?: string;
}

export interface OperationsInput {
  turns?: readonly OperationTurnFact[];
  workers?: readonly OperationWorkerFact[];
  bots?: readonly OperationBotFact[];
  schedules?: readonly OperationScheduleFact[];
  nowMs: number;
}

export interface OperationRow {
  kind: string;
  id: string;
  title: string;
  status: OperationStatus;
  detail: string;
  atMs: number | null;
  actions: OperationAction[];
}

const RUNNING = 0;
const FAILED = 1;
const SCHEDULED = 2;
const REST = 3;

function statusRank(status: OperationStatus): number {
  if (status === 'running') return RUNNING;
  if (status === 'failed') return FAILED;
  if (status === 'scheduled') return SCHEDULED;
  return REST;
}

function kindRank(kind: string): number {
  const position = OPERATION_KIND_ORDER.indexOf(kind);
  return position < 0 ? OPERATION_KIND_ORDER.length : position;
}

function oneLine(value: string | undefined, max = 160): string {
  if (!value) return '';
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

/** Compact relative time, stable for tests because `nowMs` is injected. */
export function formatRelative(atMs: number | null, nowMs: number): string {
  if (atMs === null || !Number.isFinite(atMs)) return '';
  const delta = atMs - nowMs;
  const future = delta > 0;
  const abs = Math.abs(delta);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;

  let amount: string;
  if (abs < minute) amount = 'now';
  else if (abs < hour) amount = `${Math.round(abs / minute)}m`;
  else if (abs < day) amount = `${Math.round(abs / hour)}h`;
  else amount = `${Math.round(abs / day)}d`;

  if (amount === 'now') return 'now';
  return future ? `in ${amount}` : `${amount} ago`;
}

function turnRow(fact: OperationTurnFact): OperationRow {
  const status: OperationStatus = fact.streaming ? 'running' : 'idle';
  const atMs = fact.startedAtMs ?? null;
  return {
    kind: 'turn',
    id: fact.id,
    title: fact.title,
    status,
    detail: oneLine(fact.lastOutput) || (fact.streaming ? 'Working' : 'No output yet'),
    atMs,
    actions: fact.streaming ? ['cancel', 'open'] : ['open'],
  };
}

function workerRow(fact: OperationWorkerFact): OperationRow {
  const raw = (fact.status ?? '').toLowerCase();
  const status: OperationStatus =
    raw === 'active' || raw === 'running' ? 'running' : raw === 'failed' ? 'failed' : 'idle';
  return {
    kind: 'worker',
    id: fact.id,
    title: fact.title,
    status,
    detail: oneLine(fact.lastOutput) || (fact.status ?? 'No recent output'),
    atMs: fact.atMs ?? null,
    actions: ['open'],
  };
}

function botRow(fact: OperationBotFact): OperationRow {
  const raw = (fact.availability ?? '').toLowerCase();
  const status: OperationStatus =
    raw === 'ready' ? 'success' : raw === 'failed' || raw === 'unavailable' ? 'failed' : 'unknown';
  return {
    kind: 'bot',
    id: fact.id,
    title: fact.title,
    status,
    detail: oneLine(fact.lastOutput) || (fact.availability ?? 'Availability unknown'),
    atMs: fact.atMs ?? null,
    actions: ['open'],
  };
}

function scheduleRow(fact: OperationScheduleFact, nowMs: number): OperationRow {
  const last = (fact.lastStatus ?? '').toLowerCase();
  const status: OperationStatus = !fact.enabled
    ? 'idle'
    : last === 'success'
      ? 'success'
      : last === 'failed'
        ? 'failed'
        : 'scheduled';

  const parts: string[] = [];
  if (fact.lastRunMs) parts.push(`last run ${formatRelative(fact.lastRunMs, nowMs)}`);
  if (fact.enabled && fact.nextRunMs) parts.push(`next ${formatRelative(fact.nextRunMs, nowMs)}`);
  if (!fact.enabled) parts.push('disabled');
  if (fact.notePath) parts.push(fact.notePath);
  const detail = oneLine(fact.lastOutput) || parts.join(' - ') || 'Never run';

  return {
    kind: 'schedule',
    id: fact.id,
    title: fact.title,
    status,
    detail,
    atMs: fact.lastRunMs ?? fact.nextRunMs ?? null,
    actions: fact.enabled ? ['run-now', 'open'] : ['open'],
  };
}

/**
 * Build the rail. Running rows first, then failures, then scheduled work, then
 * everything else; within a group the most recent event wins.
 */
export function buildOperationsRail(input: OperationsInput): OperationRow[] {
  const rows: OperationRow[] = [
    ...(input.turns ?? []).map((fact) => turnRow(fact, input.nowMs)),
    ...(input.workers ?? []).map((fact) => workerRow(fact, input.nowMs)),
    ...(input.bots ?? []).map((fact) => botRow(fact, input.nowMs)),
    ...(input.schedules ?? []).map((fact) => scheduleRow(fact, input.nowMs)),
  ];

  return rows.sort(
    (left, right) =>
      statusRank(left.status) - statusRank(right.status) ||
      (right.atMs ?? 0) - (left.atMs ?? 0) ||
      kindRank(left.kind) - kindRank(right.kind) ||
      left.title.localeCompare(right.title),
  );
}

/** Counts for the rail header. */
export function operationRailSummary(
  rows: readonly OperationRow[],
): { kind: string; count: number; running: number }[] {
  const groups = new Map<string, { kind: string; count: number; running: number }>();
  for (const row of rows) {
    const group = groups.get(row.kind) ?? { kind: row.kind, count: 0, running: 0 };
    group.count += 1;
    if (row.status === 'running') group.running += 1;
    groups.set(row.kind, group);
  }
  return [...groups.values()].sort((left, right) => kindRank(left.kind) - kindRank(right.kind));
}

/** True when anything is running right now, for the sidebar badge. */
export function hasRunningOperation(rows: readonly OperationRow[]): boolean {
  return rows.some((row) => row.status === 'running');
}
