// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionQuickSendProvider } from '../SessionQuickSendContext';
import { DecisionCards } from '../DecisionCards';
import type { PlanDecision } from '@/lib/decisionCards';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

const DECISIONS: PlanDecision[] = [
  {
    id: 'auth',
    question: 'How should users sign in?',
    options: [
      { id: 'jwt', label: 'JWT in header', detail: 'Stateless' },
      { id: 'session', label: 'Server sessions', detail: 'Easy revoke' },
    ],
    defaultOptionId: 'jwt',
  },
  {
    id: 'db',
    question: 'Where to store users?',
    options: [
      { id: 'sqlite', label: 'SQLite' },
      { id: 'pg', label: 'Postgres' },
    ],
  },
];

function stubDecide(decide: (req: unknown) => Promise<unknown>) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { maker: { planFirst: { decide } } },
  });
}

const view = (send: (text: string) => Promise<boolean>) => render(
  <SessionQuickSendProvider value={{ send }}>
    <DecisionCards sessionId="s1" decisions={DECISIONS} />
  </SessionQuickSendProvider>,
);

it('selects an option then Proceed calls decide with the picks and sends the summary', async () => {
  const decide = vi.fn(async () => ({ locked: false }));
  const send = vi.fn(async (_text: string): Promise<boolean> => true);
  stubDecide(decide);
  view(send);

  // db card defaults to its first option; switch it to Postgres.
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: /Postgres/ }));
  });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'chat.planFirst.proceed' }));
  });

  expect(decide).toHaveBeenCalledTimes(1);
  expect(decide).toHaveBeenCalledWith({
    sessionId: 's1',
    decisions: [
      { decisionId: 'auth', optionId: 'jwt', summary: expect.stringContaining('JWT in header') },
      { decisionId: 'db', optionId: 'pg', summary: expect.stringContaining('Postgres') },
    ],
  });
  expect(send).toHaveBeenCalledTimes(1);
  const summary = String(send.mock.calls[0]?.[0] ?? '');
  expect(summary).toContain('JWT in header');
  expect(summary).toContain('Postgres');
  expect(summary).toContain('Proceed to build');
  expect(await screen.findByTestId('decision-cards-decided')).toBeTruthy();
});

it('keeps the cards up when the session refuses the summary message', async () => {
  const decide = vi.fn(async () => ({}));
  const send = vi.fn(async (_text: string): Promise<boolean> => false);
  stubDecide(decide);
  view(send);
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'chat.planFirst.proceed' }));
  });
  expect(decide).toHaveBeenCalledTimes(1);
  expect(screen.queryByTestId('decision-cards-decided')).toBeNull();
  expect(screen.getByText('chat.planFirst.failed')).toBeTruthy();
});

it('renders nothing without a session send path', () => {
  stubDecide(vi.fn(async () => ({})));
  render(<DecisionCards sessionId="s1" decisions={DECISIONS} />);
  expect(screen.queryByTestId('decision-cards')).toBeNull();
});

const MATRIX: PlanDecision[] = [
  {
    id: 'matrix',
    question: 'How should users sign in?',
    criteria: ['Scalability', 'Revocation', 'Complexity', 'Mobile fit'],
    options: [
      { id: 'jwt', label: 'JWT in header', detail: 'Stateless', scores: ['High', 'Low', 'Medium', 'High'] },
      { id: 'session', label: 'Server sessions', detail: 'Sticky', scores: ['Medium', 'High', 'Low', 'Medium'] },
      { id: 'oauth', label: 'OAuth delegated', detail: 'Delegated', scores: ['High', 'Medium', 'High', 'High'] },
      { id: 'magic', label: 'Magic links', detail: 'No passwords', scores: ['Medium', 'High', 'Low', 'High'] },
    ],
    defaultOptionId: 'jwt',
  },
];

const matrixView = (send: (text: string) => Promise<boolean>) => render(
  <SessionQuickSendProvider value={{ send }}>
    <DecisionCards sessionId="s2" decisions={MATRIX} />
  </SessionQuickSendProvider>,
);

it('renders the 4x4 matrix as a selectable table and proceeds with the picked row', async () => {
  const decide = vi.fn(async () => ({ locked: false }));
  const send = vi.fn(async (_text: string): Promise<boolean> => true);
  stubDecide(decide);
  matrixView(send);

  // Criteria columns and score cells are visible.
  expect(screen.getByText('Scalability')).toBeTruthy();
  expect(screen.getByText('Mobile fit')).toBeTruthy();
  expect(screen.getAllByText('Medium').length).toBeGreaterThan(0);

  // Default row preselected (jwt); switch to Server sessions, then proceed.
  expect(screen.getByRole('radio', { name: /JWT in header/ }).getAttribute('aria-checked')).toBe('true');
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: /Server sessions/ }));
  });
  expect(screen.getByRole('radio', { name: /Server sessions/ }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByRole('radio', { name: /JWT in header/ }).getAttribute('aria-checked')).toBe('false');

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'chat.planFirst.proceed' }));
  });
  expect(decide).toHaveBeenCalledWith({
    sessionId: 's2',
    decisions: [
      { decisionId: 'matrix', optionId: 'session', summary: expect.stringContaining('Server sessions') },
    ],
  });
  const summary = String(send.mock.calls[0]?.[0] ?? '');
  expect(summary).toContain('Server sessions');
  expect(await screen.findByTestId('decision-cards-decided')).toBeTruthy();
});
