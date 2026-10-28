// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ImBotSection } from '../ImBotSection';
import { SettingsSearchNavigationContext } from '../SettingsSearchNavigation';
import imBotSearch from '../ImBotSection.settings-search';

const authState = vi.hoisted(() => ({
  mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
  membershipKind: 'org' as 'personal' | 'org' | null,
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({
    mode: authState.mode,
    dataOwnerId: 'owner-1',
    user: { membershipKind: authState.membershipKind },
  }),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../HookConnectionsSection', () => ({
  HookConnectionsSection: () => <div data-testid="official-connections" />,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn() }),
}));
vi.mock('../ImChannelSettingsCard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ImChannelSettingsCard')>()),
  useImChannelSettingsSummary: () => [null, vi.fn()],
}));
vi.mock('../ImDefaultSettingsSection', () => ({
  ImDefaultSettingsSection: () => null,
}));
vi.mock('../TelegramBotSection', () => ({
  TelegramBotSection: () => <div data-testid="telegram-bot" />,
}));

describe('ImBotSection', () => {
  const scrollIntoView = vi.fn();

  beforeEach(() => {
    authState.mode = 'cloud';
    authState.membershipKind = 'org';
    scrollIntoView.mockReset();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  it('shows official and personal bot types together in vertical sections', () => {
    render(<ImBotSection targetGroup={null} />);

    const official = screen.getByRole('heading', { name: 'settings.imBot.groups.cindy' });
    const personal = screen.getByRole('heading', { name: 'settings.imBot.groups.personal' });

    expect(official.compareDocumentPosition(personal) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(screen.getByTestId('official-connections')).toBeTruthy();
    // 本地私有构建只保留 Telegram:其余渠道没有入口,也不该在测试里被渲染。
    expect(screen.queryByTestId('wechat-bot')).toBeNull();
    expect(screen.queryByTestId('wecom-bot')).toBeNull();
    expect(screen.queryByTestId('dingtalk-bot')).toBeNull();
    expect(screen.queryByTestId('discord-bot')).toBeNull();
    expect(screen.getByTestId('telegram-bot')).toBeTruthy();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('shows official and Telegram bots to personal cloud accounts', () => {
    authState.membershipKind = 'personal';

    render(<ImBotSection targetGroup="cindy" />);

    expect(screen.getByTestId('official-connections')).toBeTruthy();
    expect(screen.getByTestId('telegram-bot')).toBeTruthy();
    expect(scrollIntoView.mock.instances[0]).toBe(
      screen.getByRole('heading', { name: 'settings.imBot.groups.cindy' }).closest('section'),
    );
  });

  it('expands Telegram for a personal account opened from the Telegram search entry', () => {
    authState.membershipKind = 'personal';
    const entry = imBotSearch.entries.find((item) => item.id === 'imBot.telegram')!;

    render(
      <SettingsSearchNavigationContext.Provider value={{ entry, activation: 1 }}>
        <ImBotSection targetGroup="personal" />
      </SettingsSearchNavigationContext.Provider>,
    );

    expect(screen.getByTestId('telegram-bot')).toBeTruthy();
  });

  it('keeps imGroup deep links by scrolling to the requested section', () => {
    render(<ImBotSection targetGroup="personal" />);

    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'start', inline: 'nearest' });
    expect(scrollIntoView.mock.instances[0]).toBe(
      screen.getByRole('heading', { name: 'settings.imBot.groups.personal' }).closest('section'),
    );
  });

  it('shows only the personal section when the official group is unavailable', () => {
    authState.mode = 'local';
    authState.membershipKind = null;

    render(<ImBotSection targetGroup="cindy" />);

    expect(screen.queryByRole('heading', { name: 'settings.imBot.groups.cindy' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'settings.imBot.groups.personal' })).toBeTruthy();
    expect(screen.getByText('settings.imBot.tips.personal')).toBeTruthy();
    expect(scrollIntoView.mock.instances[0]).toBe(
      screen.getByRole('heading', { name: 'settings.imBot.groups.personal' }).closest('section'),
    );
  });
});
