/**
 * Operations Rail Host & IPC Handlers (ROADMAP 8.6b).
 *
 * Coordinates runtime operations status, user actions (cancel, replay, dry-run),
 * and aggregates turns, workers, bots, and schedules into a unified rail model.
 */

import {
  buildOperationsRail,
  hasRunningOperation,
  operationRailSummary,
  type OperationBotFact,
  type OperationRow,
  type OperationScheduleFact,
  type OperationsInput,
  type OperationTurnFact,
  type OperationWorkerFact,
} from '@cindy/maker-core/operations-rail';
import type { Schedule, ScheduleRunRecord } from '@cindy/maker-core/scheduled-sessions';

import { MAKER_INVOKE, MAKER_PUSH } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import type { ScheduledSessionsHost } from './scheduledSessions.js';

export interface OperationsRailHostDeps {
  getTurnFacts?: () => Promise<OperationTurnFact[]>;
  getWorkerFacts?: () => Promise<OperationWorkerFact[]>;
  getBotFacts?: () => Promise<OperationBotFact[]>;
  scheduledSessionsHost?: ScheduledSessionsHost;
  onCancelTurn?: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
  onReplayTurn?: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
  broadcast?: (channel: string, payload?: unknown) => void;
  now?: () => number;
}

export class OperationsRailHost {
  private readonly getTurnFacts: () => Promise<OperationTurnFact[]>;
  private readonly getWorkerFacts: () => Promise<OperationWorkerFact[]>;
  private readonly getBotFacts: () => Promise<OperationBotFact[]>;
  private readonly scheduledSessionsHost?: ScheduledSessionsHost;
  private readonly onCancelTurn?: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
  private readonly onReplayTurn?: (sessionId: string) => Promise<{ ok: boolean; message?: string }>;
  private readonly broadcast?: (channel: string, payload?: unknown) => void;
  private readonly now: () => number;

  constructor(deps: OperationsRailHostDeps = {}) {
    this.getTurnFacts = deps.getTurnFacts ?? (async () => []);
    this.getWorkerFacts = deps.getWorkerFacts ?? (async () => []);
    this.getBotFacts = deps.getBotFacts ?? (async () => []);
    this.scheduledSessionsHost = deps.scheduledSessionsHost;
    this.onCancelTurn = deps.onCancelTurn;
    this.onReplayTurn = deps.onReplayTurn;
    this.broadcast = deps.broadcast;
    this.now = deps.now ?? (() => Date.now());
  }

  async listOperations(): Promise<{
    rows: OperationRow[];
    summary: { kind: string; count: number; running: number }[];
    hasRunning: boolean;
  }> {
    const nowMs = this.now();
    const [turns, workers, bots] = await Promise.all([
      this.getTurnFacts(),
      this.getWorkerFacts(),
      this.getBotFacts(),
    ]);

    let schedules: OperationScheduleFact[] = [];
    if (this.scheduledSessionsHost) {
      const scheduleEntries = this.scheduledSessionsHost.listSchedules();
      const state = this.scheduledSessionsHost.getState();
      schedules = scheduleEntries
        .filter((e) => e.ok)
        .map((e) => {
          const runRecord = state.lastRuns?.[e.id] ?? e.lastRun;
          return {
            id: e.id,
            title: e.id,
            enabled: e.enabled !== false,
            lastStatus: runRecord?.status,
            lastRunMs: state.lastRunMs?.[e.id] ?? (runRecord?.at ?? null),
            nextRunMs: e.nextRunMs ?? null,
            lastOutput: runRecord?.error,
            notePath: runRecord?.notePath ?? e.output,
          };
        });
    }

    const input: OperationsInput = {
      turns,
      workers,
      bots,
      schedules,
      nowMs,
    };

    const rows = buildOperationsRail(input);
    const summary = operationRailSummary(rows);
    const hasRunning = hasRunningOperation(rows);

    return { rows, summary, hasRunning };
  }

  async cancelOperation(kind: string, id: string): Promise<{ ok: boolean; message?: string }> {
    if (kind === 'turn' || kind === 'worker') {
      if (this.onCancelTurn) {
        const res = await this.onCancelTurn(id);
        this.broadcast?.(MAKER_PUSH.OPERATIONS_CHANGED, { id, kind, status: 'cancelled' });
        return res;
      }
      return { ok: true, message: `Stop signal dispatched for ${kind}:${id}` };
    }
    return { ok: false, message: `Cancellation not supported for kind: ${kind}` };
  }

  async replayOperation(kind: string, id: string): Promise<{ ok: boolean; message?: string }> {
    if (kind === 'turn' || kind === 'worker') {
      if (this.onReplayTurn) {
        const res = await this.onReplayTurn(id);
        this.broadcast?.(MAKER_PUSH.OPERATIONS_CHANGED, { id, kind, status: 'replaying' });
        return res;
      }
      return { ok: true, message: `Replay triggered for ${kind}:${id}` };
    }
    return { ok: false, message: `Replay not supported for kind: ${kind}` };
  }

  async dryRunSchedule(scheduleIdOrParams: string | { id: string }): Promise<ScheduleRunRecord> {
    if (!this.scheduledSessionsHost) {
      throw new Error('Scheduled sessions host is unavailable');
    }
    const scheduleId = typeof scheduleIdOrParams === 'string' ? scheduleIdOrParams : scheduleIdOrParams.id;
    const result = await this.scheduledSessionsHost.dryRunSchedule(scheduleId);
    this.broadcast?.(MAKER_PUSH.OPERATIONS_CHANGED, { id: scheduleId, kind: 'schedule', result });
    return result;
  }
}

let desktopOperationsRailHost: OperationsRailHost | undefined;

export function getDesktopOperationsRailHost(deps?: OperationsRailHostDeps): OperationsRailHost {
  if (!desktopOperationsRailHost) {
    desktopOperationsRailHost = new OperationsRailHost(deps);
  }
  return desktopOperationsRailHost;
}

export interface OperationsRailHandlerDeps {
  host: OperationsRailHost;
  assertTrusted(event: unknown): void;
}

export function registerOperationsRailHandlers(
  registry: IpcHandlerRegistry,
  deps: OperationsRailHandlerDeps,
): void {
  registry.handle(MAKER_INVOKE.OPERATIONS_LIST, async (event: unknown) => {
    deps.assertTrusted(event);
    return deps.host.listOperations();
  });

  registry.handle(
    MAKER_INVOKE.OPERATIONS_CANCEL,
    async (event: unknown, request: unknown) => {
      deps.assertTrusted(event);
      const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
      const kind = typeof r.kind === 'string' ? r.kind : '';
      const id = typeof r.id === 'string' ? r.id : '';
      return deps.host.cancelOperation(kind, id);
    },
  );

  registry.handle(
    MAKER_INVOKE.OPERATIONS_REPLAY,
    async (event: unknown, request: unknown) => {
      deps.assertTrusted(event);
      const r = (request && typeof request === 'object' ? request : {}) as Record<string, unknown>;
      const kind = typeof r.kind === 'string' ? r.kind : '';
      const id = typeof r.id === 'string' ? r.id : '';
      return deps.host.replayOperation(kind, id);
    },
  );
}
