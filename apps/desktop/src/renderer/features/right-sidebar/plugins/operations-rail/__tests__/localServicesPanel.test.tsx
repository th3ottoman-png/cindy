// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServiceView } from '../../../../../../main/local-services/serviceSupervisor';

import { LocalServicesPanel } from '../LocalServicesPanel';

const MOCK_SERVICES: ServiceView[] = [
  {
    id: 'svc:svc-1',
    name: 'web',
    command: 'npx vite --port 5173',
    pid: 4242,
    ports: [5173],
    running: true,
    uptimeMs: 65_000,
    source: 'supervised',
    manageable: true,
  },
  {
    id: 'ext:7777',
    name: 'External dev server (:3000)',
    command: '/opt/node/bin/node /work/node_modules/.bin/vite --port 3000',
    pid: 7777,
    ports: [3000],
    running: true,
    source: 'discovered',
    manageable: true,
  },
];

describe('LocalServicesPanel (ROADMAP 11.6)', () => {
  let listMock: ReturnType<typeof vi.fn>;
  let stopMock: ReturnType<typeof vi.fn>;
  let restartMock: ReturnType<typeof vi.fn>;
  let terminateMock: ReturnType<typeof vi.fn>;
  let logsMock: ReturnType<typeof vi.fn>;
  let startMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listMock = vi.fn(async () => ({ services: MOCK_SERVICES }));
    stopMock = vi.fn(async () => ({ ok: true }));
    restartMock = vi.fn(async () => ({ ok: true }));
    terminateMock = vi.fn(async () => ({ ok: true }));
    logsMock = vi.fn(async () => ({ ok: true, lines: ['VITE ready in 100 ms'] }));
    startMock = vi.fn(async () => ({ ok: true, id: 'svc-2', pid: 9999 }));

    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: {
        localServices: {
          list: listMock,
          stop: stopMock,
          restart: restartMock,
          terminate: terminateMock,
          logs: logsMock,
          start: startMock,
          onChanged: vi.fn(() => () => {}),
        },
      },
    };
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('lists supervised and discovered services with ports', async () => {
    render(<LocalServicesPanel />);

    await waitFor(() => {
      expect(screen.getByText(/active services/i)).toBeTruthy();
      expect(screen.getByText('web')).toBeTruthy();
      expect(screen.getByText(':5173')).toBeTruthy();
      expect(screen.getByText(':3000')).toBeTruthy();
      expect(screen.getByText('external')).toBeTruthy();
    });
  });

  it('stops a supervised service with its panel id', async () => {
    render(<LocalServicesPanel />);

    await waitFor(() => {
      expect(screen.getByText('web')).toBeTruthy();
    });
    fireEvent.click(screen.getAllByText('Stop')[0]);

    await waitFor(() => {
      expect(stopMock).toHaveBeenCalledWith({ id: 'svc:svc-1' });
    });
  });

  it('terminates a discovered server with pid plus command', async () => {
    render(<LocalServicesPanel />);

    await waitFor(() => {
      expect(screen.getByText('Terminate')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('Terminate'));

    await waitFor(() => {
      expect(terminateMock).toHaveBeenCalledWith({
        pid: 7777,
        command: '/opt/node/bin/node /work/node_modules/.bin/vite --port 3000',
      });
    });
  });

  it('shows the empty state when no servers are detected', async () => {
    listMock.mockResolvedValueOnce({ services: [] });
    render(<LocalServicesPanel />);

    await waitFor(() => {
      expect(screen.getByText(/No local dev servers detected/)).toBeTruthy();
    });
  });
});
