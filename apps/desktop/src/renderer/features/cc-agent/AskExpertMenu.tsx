import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { ExpertEntry } from '@cindy/maker-core/experts';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { toast } from '@/lib/toast';

import { buildExpertOptions } from './HermesExpertPicker';
import { prefillExpertHandoffDraft } from './lib/startExpertHandoff';

/**
 * Session header "Ask expert" menu (ROADMAP 3.6b). Picking an expert builds a summary of this
 * session (main: `maker:experts:handoff`), makes that expert the pending pick, prefills a new
 * Hermes task with the summary and opens it. The owner sends it; nothing starts on its own.
 * Only loadable Hermes experts are offered.
 */
export function AskExpertMenuView({
  entries,
  busy,
  onPick,
}: {
  entries: readonly ExpertEntry[];
  busy: boolean;
  onPick: (slug: string) => void;
}) {
  const options = buildExpertOptions(entries).filter((o) => !o.disabled);
  if (options.length === 0) return null;
  return (
    <select
      data-testid="ask-expert"
      aria-label="Ask expert"
      title="Ask an expert about this conversation in a new task (you review the message before sending)"
      className="mx-1 h-6 max-w-[9rem] shrink-0 truncate rounded-md border border-[var(--border-default)] bg-transparent px-1 text-xs text-[var(--text-secondary)]"
      style={WINDOW_NO_DRAG_STYLE}
      value=""
      disabled={busy}
      onChange={(event) => {
        if (event.target.value) onPick(event.target.value);
      }}
    >
      <option value="">Ask expert…</option>
      {options.map((o) => (
        <option key={o.slug} value={o.slug} title={o.title}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function AskExpertMenu({ sessionId }: { sessionId: string | null | undefined }) {
  const [entries, setEntries] = useState<ExpertEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const experts = window.electronAPI?.maker?.experts;
    if (!experts) return undefined;
    let alive = true;
    void experts.list().then((list) => { if (alive) setEntries(list); }).catch(() => undefined);
    const off = experts.onChanged((list) => setEntries(list));
    return () => {
      alive = false;
      off();
    };
  }, []);

  if (!sessionId) return null;
  return (
    <AskExpertMenuView
      entries={entries}
      busy={busy}
      onPick={(slug) => {
        const experts = window.electronAPI?.maker?.experts;
        if (!experts) return;
        setBusy(true);
        void experts
          .handoff({ sessionId, slug })
          .then((res) => {
            if (!res.ok) {
              toast.error(res.message);
              return;
            }
            prefillExpertHandoffDraft(res.prompt);
            navigate('/cc-agent/new');
          })
          .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
          .finally(() => setBusy(false));
      }}
    />
  );
}
