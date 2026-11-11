/**
 * Power-save controller (ROADMAP 11.2).
 *
 * Keeps the machine awake while work is actually running: any session turn, any scheduled run, or
 * a future deep-research job. One `prevent-app-suspension` blocker is held while at least one
 * reason is active, and released when the last one ends. Display sleep is still allowed, which is
 * what a background agent wants.
 *
 * This is separate from the owner's manual "keep awake" setting (`device-link/power-blocker.ts`).
 * Both may hold a blocker at once; Electron keeps the machine awake while any is active. The header
 * chip shows the union.
 *
 * The backend is injected so the lifecycle is testable without Electron.
 */

import { powerSaveBlocker } from 'electron';

import { createLogger } from '../logger';

const log = createLogger('power-save');

export type PowerSaveReason = 'turn' | 'scheduler' | 'research';

export interface PowerSaveStatus {
  /** True while this controller holds a live blocker. */
  active: boolean;
  /** Active reasons, in a stable order. */
  reasons: PowerSaveReason[];
  blockerId: number | null;
}

export interface PowerSaveBlockerBackend {
  start(type: 'prevent-app-suspension' | 'prevent-display-sleep'): number;
  stop(id: number): void;
  isStarted(id: number): boolean;
}

const REASON_ORDER: readonly PowerSaveReason[] = ['turn', 'scheduler', 'research'];

export class PowerSaveController {
  private readonly reasons = new Set<PowerSaveReason>();
  private blockerId: number | null = null;
  private readonly listeners = new Set<(status: PowerSaveStatus) => void>();

  constructor(private readonly backend: PowerSaveBlockerBackend = powerSaveBlocker) {}

  get status(): PowerSaveStatus {
    return {
      active: this.blockerId !== null && this.backend.isStarted(this.blockerId),
      reasons: REASON_ORDER.filter((reason) => this.reasons.has(reason)),
      blockerId: this.blockerId,
    };
  }

  /** Add or remove one reason. Idempotent; only real changes touch the blocker. */
  setReason(reason: PowerSaveReason, active: boolean): void {
    const before = this.reasons.has(reason);
    if (active) this.reasons.add(reason);
    else this.reasons.delete(reason);
    if (before === active) return;
    this.reconcile();
  }

  /** Release everything (tests, shutdown). */
  reset(): void {
    if (this.reasons.size === 0 && this.blockerId === null) return;
    this.reasons.clear();
    this.reconcile();
  }

  /** Subscribe to status changes. Returns an unsubscribe function. */
  onChange(listener: (status: PowerSaveStatus) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private reconcile(): void {
    const want = this.reasons.size > 0;
    const active = this.blockerId !== null && this.backend.isStarted(this.blockerId);
    if (want && !active) {
      this.blockerId = this.backend.start('prevent-app-suspension');
      log.info('power-save started', { reasons: this.status.reasons, id: this.blockerId });
    } else if (!want && this.blockerId !== null) {
      const id = this.blockerId;
      this.blockerId = null;
      if (this.backend.isStarted(id)) this.backend.stop(id);
      log.info('power-save stopped', { id });
    }
    const status = this.status;
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch {
        // A broken listener must not affect the blocker.
      }
    }
  }
}

/** Process-wide singleton. */
export const powerSaveController = new PowerSaveController();
