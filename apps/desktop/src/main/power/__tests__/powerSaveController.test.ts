import { describe, expect, it, vi } from 'vitest';

import {
  PowerSaveController,
  type PowerSaveBlockerBackend,
  type PowerSaveStatus,
} from '../powerSaveController';

function mockBackend() {
  let next = 1;
  const live = new Set<number>();
  const backend: PowerSaveBlockerBackend & { live: () => number[] } = {
    start: vi.fn((_type: 'prevent-app-suspension' | 'prevent-display-sleep') => {
      const id = next++;
      live.add(id);
      return id;
    }),
    stop: vi.fn((id: number) => {
      live.delete(id);
    }),
    isStarted: vi.fn((id: number) => live.has(id)),
    live: () => [...live],
  };
  return backend;
}

describe('PowerSaveController', () => {
  it('holds nothing until a reason is active', () => {
    const backend = mockBackend();
    const controller = new PowerSaveController(backend);
    expect(controller.status).toEqual({ active: false, reasons: [], blockerId: null });
    expect(backend.start).not.toHaveBeenCalled();
  });

  it('starts one blocker for the first reason and releases it when the last clears', () => {
    const backend = mockBackend();
    const controller = new PowerSaveController(backend);

    controller.setReason('turn', true);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(backend.start).toHaveBeenCalledWith('prevent-app-suspension');
    expect(controller.status).toMatchObject({ active: true, reasons: ['turn'] });
    expect(backend.live()).toHaveLength(1);

    controller.setReason('turn', false);
    expect(backend.stop).toHaveBeenCalledTimes(1);
    expect(controller.status).toMatchObject({ active: false, reasons: [], blockerId: null });
    expect(backend.live()).toHaveLength(0);
  });

  it('keeps the blocker while another reason is still active', () => {
    const backend = mockBackend();
    const controller = new PowerSaveController(backend);

    controller.setReason('turn', true);
    controller.setReason('scheduler', true);
    expect(backend.start).toHaveBeenCalledTimes(1);
    expect(controller.status.reasons).toEqual(['turn', 'scheduler']);

    controller.setReason('turn', false);
    expect(backend.stop).not.toHaveBeenCalled();
    expect(controller.status).toMatchObject({ active: true, reasons: ['scheduler'] });

    controller.setReason('scheduler', false);
    expect(backend.stop).toHaveBeenCalledTimes(1);
    expect(controller.status.active).toBe(false);
  });

  it('is idempotent for repeated reasons', () => {
    const backend = mockBackend();
    const controller = new PowerSaveController(backend);
    controller.setReason('turn', true);
    controller.setReason('turn', true);
    controller.setReason('turn', true);
    expect(backend.start).toHaveBeenCalledTimes(1);
    controller.setReason('turn', false);
    controller.setReason('turn', false);
    expect(backend.stop).toHaveBeenCalledTimes(1);
  });

  it('re-acquires after a full release', () => {
    const backend = mockBackend();
    const controller = new PowerSaveController(backend);
    controller.setReason('turn', true);
    controller.setReason('turn', false);
    controller.setReason('turn', true);
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(controller.status.active).toBe(true);
  });

  it('reports inactive when the system stopped the blocker, and starts a new one on the next reason', () => {
    const backend = mockBackend();
    const controller = new PowerSaveController(backend);
    controller.setReason('turn', true);
    const id = controller.status.blockerId!;
    // Simulate the OS or another process stopping it.
    backend.stop(id);
    expect(controller.status.active).toBe(false);
    controller.setReason('scheduler', true);
    expect(backend.start).toHaveBeenCalledTimes(2);
    expect(controller.status.active).toBe(true);
  });

  it('notifies listeners only on real changes', () => {
    const backend = mockBackend();
    const controller = new PowerSaveController(backend);
    const seen: PowerSaveStatus[] = [];
    const off = controller.onChange((status) => seen.push(status));

    controller.setReason('turn', true);
    controller.setReason('turn', true);
    controller.setReason('scheduler', true);
    controller.setReason('turn', false);
    controller.setReason('turn', false);
    controller.setReason('scheduler', false);
    off();
    controller.setReason('turn', true);

    expect(seen.map((status) => [status.active, status.reasons])).toEqual([
      [true, ['turn']],
      [true, ['turn', 'scheduler']],
      [true, ['scheduler']],
      [false, []],
    ]);
  });

  it('reset releases every reason', () => {
    const backend = mockBackend();
    const controller = new PowerSaveController(backend);
    controller.setReason('turn', true);
    controller.setReason('scheduler', true);
    controller.reset();
    expect(controller.status).toMatchObject({ active: false, reasons: [] });
    expect(backend.live()).toHaveLength(0);
  });
});
