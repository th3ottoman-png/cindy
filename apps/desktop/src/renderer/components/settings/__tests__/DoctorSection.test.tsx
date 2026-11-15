// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DoctorUiState,
  FixOutcome,
  FixPlan,
  LkgSnapshotRecord,
} from '../../../../shared/doctor';
import { DoctorSection } from '../DoctorSection';
import { SidebarIconButton } from '../../sidebar/SidebarIconButton';
import { resetDoctorStatusStoreForTests, useDoctorStatus } from '@/state/doctorStatusStore';
import { Settings } from 'lucide-react';

const toastMock = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({
  toast: toastMock,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactElement }) => children,
  Tooltip: {
    Provider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Root: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Trigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Content: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  },
}));

function makeState(overrides: Partial<DoctorUiState> = {}): DoctorUiState {
  return {
    report: {
      startedAt: '2026-11-15T12:00:00.000Z',
      durationMs: 42,
      host: { node: '22.23.4', platform: 'darwin' },
      counts: { ok: 1, warn: 1, fail: 2, skip: 0 },
      results: [
        {
          id: 'config.routing',
          layer: 'config',
          title: 'Routing config',
          severity: 'fail',
          summary: 'Dangling provider in routing.yaml',
          action: 'Run repair fix',
          fixIds: ['fix.routing'],
          durationMs: 3,
        },
        {
          id: 'proc.daemon',
          layer: 'processes',
          title: 'Daemon socket',
          severity: 'fail',
          summary: 'Stale socket file remains',
          action: 'Close Cindy app and repair via CLI',
          fixIds: ['fix.daemon-socket'],
          durationMs: 2,
        },
        {
          id: 'runtimes.hermes.pin',
          layer: 'runtimes',
          title: 'Hermes pin',
          severity: 'warn',
          summary: 'Unpinned Hermes version',
          durationMs: 4,
        },
        {
          id: 'environment.node',
          layer: 'environment',
          title: 'Node runtime',
          severity: 'ok',
          summary: 'Node 22.23.4 OK',
          durationMs: 1,
        },
      ],
    },
    hasFailure: true,
    running: false,
    runOnStart: true,
    lastStartupSnapshotAt: null,
    fixesMeta: {
      'fix.routing': {
        id: 'fix.routing',
        title: 'Repair routing.yaml',
        risk: 'moves-files',
        needsAppClosed: false,
        recheck: ['config.routing'],
        cliCommand: 'pnpm run doctor fix fix.routing',
      },
      'fix.daemon-socket': {
        id: 'fix.daemon-socket',
        title: 'Clean stale socket',
        risk: 'kills-process',
        needsAppClosed: true,
        recheck: ['proc.daemon'],
        cliCommand: 'pnpm run doctor fix fix.daemon-socket',
      },
    },
    ...overrides,
  };
}

describe('DoctorSection UI (ROADMAP 14.8)', () => {
  let listeners: Array<(state: DoctorUiState) => void> = [];
  let currentState: DoctorUiState;

  const installDoctorApi = (initial: DoctorUiState) => {
    currentState = initial;
    listeners = [];

    const api = {
      getState: vi.fn(async () => currentState),
      setConfig: vi.fn(async ({ runOnStart }: { runOnStart: boolean }) => {
        currentState = { ...currentState, runOnStart };
        listeners.forEach((cb) => cb(currentState));
        return currentState;
      }),
      run: vi.fn(async () => currentState.report!),
      fixPreview: vi.fn(async ({ fixId }: { fixId: string }): Promise<FixPlan> => ({
        fixId,
        steps: ['Point route back to configured lmstudio provider'],
        touches: ['/tmp/.cindy-harness/routing.yaml'],
        requiresAppClosed: false,
      })),
      fixApply: vi.fn(async ({ plan }: { plan: FixPlan }): Promise<FixOutcome> => {
        currentState = makeState({
          hasFailure: false,
          report: {
            ...currentState.report!,
            startedAt: '2026-11-15T12:05:00.000Z',
            counts: { ok: 3, warn: 1, fail: 0, skip: 0 },
            results: currentState.report!.results.map((r) =>
              r.severity === 'fail' ? { ...r, severity: 'ok', summary: `${r.id} ok`, fixIds: undefined } : r,
            ),
          },
        });
        listeners.forEach((cb) => cb(currentState));
        return {
          ok: true,
          rolledBack: false,
          message: `Repaired ${plan.fixId} cleanly`,
          recheck: [],
        };
      }),
      snapshots: vi.fn(async (): Promise<LkgSnapshotRecord[]> => [
        {
          stamp: '2026-11-15T11-00-00Z',
          dir: '/tmp/.cindy-harness/doctor/lkg/2026-11-15T11-00-00Z',
          createdMs: Date.parse('2026-11-15T11:00:00.000Z'),
          valid: true,
          manifest: {
            formatVersion: 1,
            stamp: '2026-11-15T11-00-00Z',
            createdAt: '2026-11-15T11:00:00.000Z',
            reason: 'daily',
            reportCounts: { ok: 54, warn: 3, fail: 0, skip: 1 },
            files: [],
          },
        },
      ]),
      snapshot: vi.fn(async () => ({
        formatVersion: 1 as const,
        stamp: '2026-11-15T12:06:00Z',
        createdAt: '2026-11-15T12:06:00Z',
        reason: 'manual',
        reportCounts: { ok: 54, warn: 3, fail: 0, skip: 1 },
        files: [],
      })),
      bundle: vi.fn(async () => ({
        stamp: '2026-11-15T12-07-00.000Z',
        path: '/tmp/.cindy-harness/doctor/bundles/2026-11-15T12-07-00.000Z.md',
        displayPath: '~/.cindy-harness/doctor/bundles/2026-11-15T12-07-00.000Z.md',
        createdAt: '2026-11-15T12:07:00.000Z',
        markdown: '# Cindy Doctor Incident Bundle\n\n## Diagnostic Report (--all)\n\n- `config.routing`\n',
        bytes: 84,
        reportCounts: { ok: 1, warn: 1, fail: 2, skip: 0 },
        configCount: 2,
        envKeyCount: 1,
      })),
      onUpdated: vi.fn((cb: (state: DoctorUiState) => void) => {
        listeners.push(cb);
        return () => {
          listeners = listeners.filter((x) => x !== cb);
        };
      }),
    };

    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      writable: true,
      value: { maker: { doctor: api } },
    });

    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn(async () => {}) },
    });

    return api;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetDoctorStatusStoreForTests();
  });

  it('expands fail layers by default, keeps ok/warn collapsed, and displays counts summary', async () => {
    installDoctorApi(makeState());
    render(<DoctorSection />);

    await waitFor(() => {
      expect(screen.getByTestId('doctor-summary-line').textContent).toContain(
        '4 checks · 1 ok · 1 warn · 2 fail · 0 skip',
      );
    });

    // Failure layer expanded automatically
    expect(screen.getByText('Dangling provider in routing.yaml')).toBeTruthy();
    expect(screen.getByText('Stale socket file remains')).toBeTruthy();

    // Non-failure layers collapsed until toggled
    expect(screen.queryByText('Unpinned Hermes version')).toBeNull();
    expect(screen.queryByText('Node 22.23.4 OK')).toBeNull();

    // Expand Runtimes layer manually
    fireEvent.click(screen.getByRole('button', { name: /Runtimes/i }));
    expect(screen.getByText('Unpinned Hermes version')).toBeTruthy();
  });

  it('shows Fix preview dialog -> confirm -> apply outcome, and shows CLI copy for needsAppClosed fixes', async () => {
    const api = installDoctorApi(makeState());
    render(<DoctorSection />);

    await waitFor(() => {
      expect(screen.getByText('pnpm run doctor fix fix.daemon-socket')).toBeTruthy();
    });

    // needsAppClosed fix shows CLI copy, NOT a Fix... preview trigger
    expect(screen.queryByRole('button', { name: /Clean stale socket/i })).toBeNull();

    // Interactive fix preview & confirm
    fireEvent.click(screen.getByRole('button', { name: 'Fix Repair routing.yaml' }));
    await waitFor(() => {
      expect(api.fixPreview).toHaveBeenCalledWith({ fixId: 'fix.routing' });
      expect(screen.getByText(/Preview fix: Repair routing.yaml/i)).toBeTruthy();
    });
    expect(screen.getByText('Point route back to configured lmstudio provider')).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Apply fix' }));
    });

    await waitFor(() => {
      expect(api.fixApply).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/fix\.routing: Repaired fix\.routing cleanly/i)).toBeTruthy();
    });
  });

  it('triggers Run all checks with slow cost, toggles run_on_start, and copies report', async () => {
    const api = installDoctorApi(makeState());
    render(<DoctorSection />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Run all checks' })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole('button', { name: 'Run all checks' }));
    expect(api.run).toHaveBeenCalledWith({ cost: ['instant', 'fast', 'slow'] });

    fireEvent.click(screen.getByRole('button', { name: 'Copy report' }));
    await waitFor(() => {
      expect(api.bundle).toHaveBeenCalledTimes(1);
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    });
    const copied = vi.mocked(navigator.clipboard.writeText).mock.calls[0]?.[0] ?? '';
    expect(copied).toContain('# Cindy Doctor Incident Bundle');
    expect(copied).toContain('config.routing');

    const toggle = screen.getByRole('switch', { name: 'Run startup health check' });
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(api.setConfig).toHaveBeenCalledWith({ runOnStart: false });
    });
  });

  it('drives the Settings entry attention dot when hasFailure changes cleanly', async () => {
    installDoctorApi(makeState({ hasFailure: true }));

    function SettingsEntryProbe() {
      const { hasFailure } = useDoctorStatus();
      return (
        <SidebarIconButton
          icon={Settings}
          label="Settings"
          showDot={hasFailure}
          dotTone="error"
          dotTestId="settings-doctor-dot"
        />
      );
    }

    render(<SettingsEntryProbe />);
    await waitFor(() => {
      expect(screen.getByTestId('settings-doctor-dot')).toBeTruthy();
    });

    act(() => {
      listeners.forEach((cb) => cb(makeState({ hasFailure: false })));
    });
    await waitFor(() => {
      expect(screen.queryByTestId('settings-doctor-dot')).toBeNull();
    });
  });
});
