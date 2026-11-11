/**
 * ChatOnlyToggle — ROADMAP 10.3 "conversation only" switch for a Hermes session.
 *
 * Sits in the session header next to the manifest strip so the mode is stated, not hidden. Turning
 * it on makes every later turn run Hermes with `--safe-mode` (no toolsets, no MCP servers, no
 * plugins); turning it off restores the tools. The host owns the flag and tells the daemon, which
 * is what actually builds the argv.
 */

import { useCallback, useEffect, useState } from 'react';
import { MessageSquareOff, MessageSquare } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';

export interface ChatOnlyToggleProps {
  sessionId: string;
  /** Route model: Hermes refuses `--safe-mode` without an explicit one. */
  model?: string | null;
  disabled?: boolean;
}

export function ChatOnlyToggle({ sessionId, model, disabled = false }: ChatOnlyToggleProps) {
  const { t } = useTranslation();
  const [chatOnly, setChatOnly] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    const read = () => {
      void window.electronAPI?.maker?.chatOnly
        ?.get({ sessionId })
        .then((view) => {
          if (alive) setChatOnly(view.chatOnly);
        })
        .catch(() => undefined);
    };
    read();
    // The host is the source of truth and can change under the chip (another window, a restart).
    // Re-reading on focus keeps the header honest without polling.
    window.addEventListener('focus', read);
    return () => {
      alive = false;
      window.removeEventListener('focus', read);
    };
  }, [sessionId]);

  const toggle = useCallback(async () => {
    const next = !chatOnly;
    setBusy(true);
    try {
      const view = await window.electronAPI.maker.chatOnly.set({
        sessionId,
        chatOnly: next,
        ...(model ? { model } : {}),
      });
      setChatOnly(view.chatOnly);
      toast.success(t(view.chatOnly ? 'chat.chatOnly.onToast' : 'chat.chatOnly.offToast'));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('chat.chatOnly.failed'));
    } finally {
      setBusy(false);
    }
  }, [chatOnly, model, sessionId, t]);

  const Icon = chatOnly ? MessageSquareOff : MessageSquare;

  return (
    <button
      type="button"
      data-testid="chat-only-toggle"
      aria-pressed={chatOnly}
      aria-label={chatOnly ? t('chat.chatOnly.disable') : t('chat.chatOnly.enable')}
      title={t(chatOnly ? 'chat.chatOnly.onHint' : 'chat.chatOnly.offHint')}
      disabled={disabled || busy}
      onClick={() => void toggle()}
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-11 font-medium leading-none transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        chatOnly
          ? 'border-[var(--status-warning)] bg-[var(--surface-chip)] text-[var(--status-warning)]'
          : 'border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]',
        (disabled || busy) && 'cursor-default opacity-60',
      )}
    >
      <Icon size={12} aria-hidden="true" />
      <span>{t(chatOnly ? 'chat.chatOnly.on' : 'chat.chatOnly.off')}</span>
    </button>
  );
}
