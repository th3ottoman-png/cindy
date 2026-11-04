// @vitest-environment jsdom

/**
 * ROADMAP 2.4b regression: the blocked-route banner must appear when a local
 * provider dies mid-session, not only when the renderer happens to mount while
 * the endpoint is already offline. Found in the 2.4b-live re-run 2026-11-04:
 * `evaluate()` was a mount-only effect keyed on agentKind/sessionModel.
 *
 * This test drives the full container component over a mocked IPC surface and a
 * mocked chat store, so a passing run proves the subscription wiring, not just
 * the pure assessment helper.
 */

import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  SessionRouteBlockedBanner,
  routeHealthTriggerSignature,
} from '@/features/cc-agent/SessionRouteBlockedBanner';
import { makerChatStore } from '@/lib/makerChatStore';
import * as sessionService from '@/lib/sessionService';

vi.mock('@/lib/sessionService', () => ({
  update: vi.fn(async () => ({})),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

const GEMMA = 'google/gemma-4-26b-a4b-qat';

type Probe = { id: string; status: string; models: string[]; error?: string };

const providers = [
  { id: 'lmstudio-local', kind: 'lmstudio', baseUrl: 'http://127.0.0.1:1234', local: true },
  { id: 'ollama-local', kind: 'ollama', baseUrl: 'http://127.0.0.1:11434', local: true },
];

const routing = {
  routes: {
    'gemma-local': { provider: 'lmstudio-local', model: GEMMA },
    'ollama-offline': { provider: 'ollama-local', model: 'llama3.2' },
  },
  rules: {},
};

const onlineProbes: Probe[] = [
  { id: 'lmstudio-local', status: 'online', models: [GEMMA] },
  { id: 'ollama-local', status: 'offline', models: [], error: 'fetch failed' },
];

const offlineProbes: Probe[] = [
  { id: 'lmstudio-local', status: 'offline', models: [], error: 'fetch failed' },
  { id: 'ollama-local', status: 'offline', models: [], error: 'fetch failed' },
];

let probes: Probe[];
let discoverCalls: number;
let snapshot: { error: string | null; isRunning: boolean };
let listeners: Set<() => void>;
let providersChangedCb: (() => void) | null;

function setStore(error: string | null, isRunning: boolean): void {
  snapshot = { error, isRunning };
  for (const cb of [...listeners]) cb();
}

function notifyStore(): void {
  for (const cb of [...listeners]) cb();
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function banner(container: HTMLElement): Element | null {
  return container.querySelector('[data-testid="session-route-blocked-banner"]');
}

beforeEach(() => {
  probes = onlineProbes;
  discoverCalls = 0;
  snapshot = { error: null, isRunning: false };
  listeners = new Set();
  providersChangedCb = null;

  vi.spyOn(makerChatStore, 'getSnapshot').mockImplementation(
    () => snapshot as unknown as ReturnType<typeof makerChatStore.getSnapshot>,
  );
  vi.spyOn(makerChatStore, 'subscribe').mockImplementation((_sessionId, cb) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  });

  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      maker: {
        setModel: vi.fn(async () => ({ deferred: false })),
        providers: {
          list: async () => ({ providers }),
          getRouting: async () => routing,
          discover: async () => {
            discoverCalls += 1;
            return probes;
          },
        },
        onProvidersChanged: (cb: () => void) => {
          providersChangedCb = cb;
          return () => {
            providersChangedCb = null;
          };
        },
      },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('routeHealthTriggerSignature', () => {
  it('ignores streaming deltas but changes on turn start and on error transitions', () => {
    const idle = { error: null, agentStatus: { isRunning: false } };
    const running = { error: null, agentStatus: { isRunning: true } };
    const failed = {
      error: 'Network error: the service is temporarily unreachable.',
      agentStatus: { isRunning: false },
    };
    expect(routeHealthTriggerSignature(idle)).toBe(routeHealthTriggerSignature(idle));
    expect(routeHealthTriggerSignature(running)).not.toBe(routeHealthTriggerSignature(idle));
    expect(routeHealthTriggerSignature(failed)).not.toBe(routeHealthTriggerSignature(idle));
    expect(routeHealthTriggerSignature(failed)).not.toBe(routeHealthTriggerSignature(running));
  });
});

describe('SessionRouteBlockedBanner re-evaluation (2.4b)', () => {
  it('appears on a mid-session outage without a remount and clears on recovery', async () => {
    const view = render(
      <SessionRouteBlockedBanner sessionId="session-1" agentKind="hermes" sessionModel={GEMMA} />,
    );
    await flush();

    expect(banner(view.container)).toBeNull();
    const callsAfterMount = discoverCalls;
    expect(callsAfterMount).toBeGreaterThan(0);

    // Streaming token deltas notify the store but must not re-probe endpoints.
    await act(async () => {
      notifyStore();
    });
    expect(discoverCalls).toBe(callsAfterMount);

    // LM Studio quits, then the next turn's preflight refuses the route. This is
    // the exact 2.4b-live failure: previously no banner until a renderer reload.
    probes = offlineProbes;
    await act(async () => {
      setStore('Network error: the service is temporarily unreachable.', false);
    });
    await flush();

    expect(discoverCalls).toBeGreaterThan(callsAfterMount);
    const shown = banner(view.container);
    expect(shown).not.toBeNull();
    expect(shown?.textContent).toContain('lmstudio-local');
    expect(shown?.textContent).toContain('fetch failed');
    expect(shown?.textContent).toContain('Automatic fallback is disabled');
    expect(
      view.container.querySelector('[data-testid="session-route-no-alternatives"]'),
    ).not.toBeNull();

    // Endpoint restored and a successful turn clears the error.
    probes = onlineProbes;
    await act(async () => {
      setStore(null, false);
    });
    await flush();
    expect(banner(view.container)).toBeNull();
  });

  it('re-evaluates when providers.yaml changes and when the window regains focus', async () => {
    const view = render(
      <SessionRouteBlockedBanner sessionId="session-1" agentKind="hermes" sessionModel={GEMMA} />,
    );
    await flush();
    expect(banner(view.container)).toBeNull();

    probes = offlineProbes;
    await act(async () => {
      providersChangedCb?.();
    });
    await flush();
    expect(banner(view.container)).not.toBeNull();

    probes = onlineProbes;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await flush();
    expect(banner(view.container)).toBeNull();
  });

  it('switches model, notifies onModelChange, and clears banner when an alternative is clicked', async () => {
    const onModelChange = vi.fn();
    probes = onlineProbes;
    const view = render(
      <SessionRouteBlockedBanner
        sessionId="session-1"
        agentKind="hermes"
        sessionModel="llama3.2"
        onModelChange={onModelChange}
      />,
    );
    await flush();

    const shown = banner(view.container);
    expect(shown).not.toBeNull();
    const gemmaBtn = view.container.querySelector(
      '[data-testid="use-route-alternative-gemma-local"]',
    ) as HTMLButtonElement | null;
    expect(gemmaBtn).not.toBeNull();

    await act(async () => {
      gemmaBtn?.click();
    });
    await flush();

    expect(window.electronAPI.maker.setModel).toHaveBeenCalledWith(
      'session-1',
      GEMMA,
      'lmstudio-local',
    );
    expect(sessionService.update).toHaveBeenCalledWith('session-1', {
      model: GEMMA,
      providerId: 'lmstudio-local',
    });
    expect(onModelChange).toHaveBeenCalledWith(GEMMA);
    expect(banner(view.container)).toBeNull();
  });
});
