/**
 * Renderer store subscribing once to Main's Doctor state (`maker:doctor:updated`)
 * and exposing actions for Settings -> Doctor and the Settings entry attention dot.
 */

import { useSyncExternalStore } from 'react';
import type {
  DoctorRunParams,
  DoctorUiState,
  FixOutcome,
  FixPlan,
  LkgSnapshotManifest,
  LkgSnapshotRecord,
} from '../../shared/doctor';

export interface DoctorStoreSnapshot {
  state: DoctorUiState | null;
  loading: boolean;
  error: string | null;
}

const listeners = new Set<() => void>();

let snapshot: DoctorStoreSnapshot = {
  state: null,
  loading: false,
  error: null,
};

let subscribedIpc = false;
let unsubscribeIpc: (() => void) | null = null;
let initialFetchStarted = false;

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function updateSnapshot(patch: Partial<DoctorStoreSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  notify();
}

function getDoctorApi() {
  if (typeof window === 'undefined') return undefined;
  return window.electronAPI?.maker?.doctor;
}

function ensureInitialized(): void {
  const api = getDoctorApi();
  if (!api) return;

  if (!subscribedIpc && typeof api.onUpdated === 'function') {
    subscribedIpc = true;
    unsubscribeIpc = api.onUpdated((nextState) => {
      updateSnapshot({ state: nextState, loading: false, error: null });
    });
  }

  if (!initialFetchStarted && typeof api.getState === 'function') {
    initialFetchStarted = true;
    void api
      .getState()
      .then((state) => {
        updateSnapshot({ state, error: null });
      })
      .catch((err: unknown) => {
        updateSnapshot({ error: err instanceof Error ? err.message : String(err) });
      });
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  ensureInitialized();
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): DoctorStoreSnapshot {
  return snapshot;
}

export function resetDoctorStatusStoreForTests(): void {
  unsubscribeIpc?.();
  unsubscribeIpc = null;
  subscribedIpc = false;
  initialFetchStarted = false;
  snapshot = { state: null, loading: false, error: null };
  notify();
}

export async function refreshDoctorState(): Promise<DoctorUiState | null> {
  const api = getDoctorApi();
  if (!api) return null;
  try {
    const state = await api.getState();
    updateSnapshot({ state, error: null });
    return state;
  } catch (err) {
    updateSnapshot({ error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

export async function setDoctorRunOnStart(runOnStart: boolean): Promise<DoctorUiState | null> {
  const api = getDoctorApi();
  if (!api) return null;
  try {
    const state = await api.setConfig({ runOnStart });
    updateSnapshot({ state, error: null });
    return state;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateSnapshot({ error: message });
    throw err;
  }
}

export async function runDoctorChecks(params: DoctorRunParams = {}): Promise<DoctorUiState | null> {
  const api = getDoctorApi();
  if (!api) return null;
  updateSnapshot({ loading: true, error: null });
  try {
    const report = await api.run(params);
    const state = await api.getState();
    const merged: DoctorUiState = state
      ? { ...state, report, hasFailure: report.counts.fail > 0, running: false }
      : {
          report,
          hasFailure: report.counts.fail > 0,
          running: false,
          runOnStart: snapshot.state?.runOnStart ?? true,
          lastStartupSnapshotAt: snapshot.state?.lastStartupSnapshotAt ?? null,
          fixesMeta: snapshot.state?.fixesMeta ?? {},
        };
    updateSnapshot({ state: merged, loading: false, error: null });
    return merged;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateSnapshot({ loading: false, error: message });
    throw err;
  }
}

export async function previewDoctorFix(fixId: string, target?: string): Promise<FixPlan> {
  const api = getDoctorApi();
  if (!api) {
    throw new Error('Doctor IPC API is unavailable');
  }
  return api.fixPreview({ fixId, ...(target ? { target } : {}) });
}

export async function applyDoctorFix(plan: FixPlan): Promise<FixOutcome> {
  const api = getDoctorApi();
  if (!api) {
    throw new Error('Doctor IPC API is unavailable');
  }
  updateSnapshot({ loading: true, error: null });
  try {
    const outcome = await api.fixApply({ plan });
    const state = await api.getState();
    updateSnapshot({ state, loading: false, error: null });
    return outcome;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateSnapshot({ loading: false, error: message });
    throw err;
  }
}

export async function listDoctorSnapshots(): Promise<LkgSnapshotRecord[]> {
  const api = getDoctorApi();
  if (!api) return [];
  return api.snapshots();
}

export async function takeDoctorSnapshot(reason = 'manual'): Promise<LkgSnapshotManifest> {
  const api = getDoctorApi();
  if (!api) {
    throw new Error('Doctor IPC API is unavailable');
  }
  return api.snapshot({ reason });
}

export function useDoctorStatus() {
  const current = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    state: current.state,
    report: current.state?.report ?? null,
    hasFailure: current.state?.hasFailure ?? false,
    running: current.state?.running ?? current.loading,
    runOnStart: current.state?.runOnStart ?? true,
    lastStartupSnapshotAt: current.state?.lastStartupSnapshotAt ?? null,
    fixesMeta: current.state?.fixesMeta ?? {},
    error: current.error,
  };
}
