import { showCindyGroup } from './imBotVisibility';
import type { SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export default {
  id: 'im-bot',
  order: 12,
  entries: [
    {
      id: 'imBot',
      tab: 'im-bot',
      targetId: 'settings-panel-im-bot',
      titleKey: 'settings.tabs.imBot',
      sectionKey: 'settings.sections.imBot',
    },
    {
      id: 'imBot.cindy',
      isVisible: showCindyGroup,
      tab: 'im-bot',
      targetId: 'im-bot-group-cindy',
      titleKey: 'settings.imBot.groups.cindy',
      sectionKey: 'settings.sections.imBot',
      aliases: ['Cindy', 'official bot', '官方机器人'],
    },
    {
      id: 'imBot.cindy.slack',
      isVisible: (identity) => identity.mode === 'cloud' && showCindyGroup(identity),
      fallbackTargetId: 'im-bot-group-cindy',
      tab: 'im-bot',
      targetId: 'cindy-im-slack',
      titleKey: 'settings.remoteControl.sections.hook',
      sectionKey: 'settings.imBot.groups.cindy',
      aliases: ['Slack', 'Slack bot', 'IM'],
    },
    {
      id: 'imBot.cindy.telegram',
      isVisible: (identity) => identity.mode === 'cloud' && showCindyGroup(identity),
      fallbackTargetId: 'im-bot-group-cindy',
      tab: 'im-bot',
      targetId: 'cindy-im-telegram',
      titleKey: 'settings.tina.prefs.providerTelegram',
      sectionKey: 'settings.imBot.groups.cindy',
      descriptionKey: 'settings.remoteControl.hook.telegram.description',
      aliases: ['Telegram', 'Telegram bot'],
    },
    {
      id: 'imBot.cindy.x',
      isVisible: (identity) => identity.mode === 'cloud' && showCindyGroup(identity),
      fallbackTargetId: 'im-bot-group-cindy',
      tab: 'im-bot',
      targetId: 'cindy-im-x',
      titleKey: 'settings.tina.prefs.providerX',
      sectionKey: 'settings.imBot.groups.cindy',
      descriptionKey: 'settings.remoteControl.hook.x.description',
      aliases: ['X', 'Twitter'],
    },
    {
      id: 'imBot.telegram',
      tab: 'im-bot',
      targetId: 'personal-im-telegram',
      titleKey: 'settings.telegramBot.title',
      sectionKey: 'settings.imBot.groups.personal',
      aliases: ['Telegram', 'Telegram bot'],
    },
  ],
} satisfies SettingsSearchModule;
