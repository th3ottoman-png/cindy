import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { ScheduledSessionsView } from '../ScheduledSessionsSection';

describe('Settings ScheduledSessionsSection (ROADMAP 5.4b)', () => {
  it('renders configured schedules folder and valid schedule rows', () => {
    const html = renderToStaticMarkup(
      <ScheduledSessionsView
        config={{
          schedulesDir: '/Users/turko/.cindy-harness/schedules',
          vaultDir: '/Users/turko/Bishi-memory',
          vaultConfigured: true,
        }}
        schedules={[
          {
            id: 'morning-brief',
            file: '/schedules/morning-brief.md',
            ok: true,
            expert: 'researcher',
            cron: '0 8 * * *',
            timezone: 'UTC',
            enabled: true,
            output: 'briefs/{date}.md',
            prompt: 'Summarise notes',
            nextRunMs: Date.parse('2026-11-06T08:00:00.000Z'),
          },
        ]}
        loading={false}
        saving={false}
        runningId={null}
        onSaveConfig={() => undefined}
        onPickFolder={() => undefined}
        onRunNow={() => undefined}
      />,
    );

    expect(html).toContain('Scheduled Sessions');
    expect(html).toContain('value="/Users/turko/.cindy-harness/schedules"');
    expect(html).toContain('Connected (1 valid schedule)');
    expect(html).toContain('morning-brief');
    expect(html).toContain('expert: researcher');
    expect(html).toContain('0 8 * * *');
    expect(html).toContain('briefs/{date}.md');
    expect(html).toContain('Run now');
  });

  it('renders vault warning when Notes Vault is not configured', () => {
    const html = renderToStaticMarkup(
      <ScheduledSessionsView
        config={{
          schedulesDir: '/Users/turko/.cindy-harness/schedules',
          vaultDir: '',
          vaultConfigured: false,
        }}
        schedules={[]}
        loading={false}
        saving={false}
        runningId={null}
        onSaveConfig={() => undefined}
        onPickFolder={() => undefined}
        onRunNow={() => undefined}
      />,
    );

    expect(html).toContain('Notes Vault Not Configured');
    expect(html).toContain('Scheduled sessions require a Notes Vault folder');
  });

  it('renders error alert for invalid schedule files', () => {
    const html = renderToStaticMarkup(
      <ScheduledSessionsView
        config={{
          schedulesDir: '/Users/turko/.cindy-harness/schedules',
          vaultDir: '/vault',
          vaultConfigured: true,
        }}
        schedules={[
          {
            id: 'broken',
            file: '/schedules/broken.md',
            ok: false,
            error: 'frontmatter "cron" is required',
          },
        ]}
        loading={false}
        saving={false}
        runningId={null}
        onSaveConfig={() => undefined}
        onPickFolder={() => undefined}
        onRunNow={() => undefined}
      />,
    );

    expect(html).toContain('broken.md');
    expect(html).toContain('frontmatter &quot;cron&quot; is required');
  });

  it('renders last run info for success and error', () => {
    const html = renderToStaticMarkup(
      <ScheduledSessionsView
        config={{
          schedulesDir: '/schedules',
          vaultDir: '/vault',
          vaultConfigured: true,
        }}
        schedules={[
          {
            id: 'daily',
            file: '/schedules/daily.md',
            ok: true,
            expert: 'researcher',
            cron: '0 8 * * *',
            timezone: 'UTC',
            enabled: true,
            output: 'schedules/{date}.md',
            prompt: 'Summarise',
            lastRun: {
              status: 'success',
              at: Date.parse('2026-11-05T08:00:00.000Z'),
              notePath: 'schedules/2026-11-05.md',
            },
          },
        ]}
        loading={false}
        saving={false}
        runningId={null}
        onSaveConfig={() => undefined}
        onPickFolder={() => undefined}
        onRunNow={() => undefined}
      />,
    );

    expect(html).toContain('Last run:');
    expect(html).toContain('(schedules/2026-11-05.md)');
  });

  it('renders empty state message when no schedules exist', () => {
    const html = renderToStaticMarkup(
      <ScheduledSessionsView
        config={{
          schedulesDir: '/schedules',
          vaultDir: '/vault',
          vaultConfigured: true,
        }}
        schedules={[]}
        loading={false}
        saving={false}
        runningId={null}
        onSaveConfig={() => undefined}
        onPickFolder={() => undefined}
        onRunNow={() => undefined}
      />,
    );

    expect(html).toContain('No schedule files found in this folder');
  });
});
