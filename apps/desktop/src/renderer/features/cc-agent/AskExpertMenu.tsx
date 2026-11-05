import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { ExpertEntry } from '@cindy/maker-core/experts';

import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { toast } from '@/lib/toast';

import { buildExpertOptions } from './HermesExpertPicker';
import { prefillExpertHandoffDraft, prefillGoAheadDraft } from './lib/startExpertHandoff';

/**
 * Session header "Ask expert" menu (ROADMAP 3.6b). Picking an expert builds a summary of this
 * session (main: `maker:experts:handoff`), makes that expert the pending pick, prefills a new
 * Hermes task with the summary and opens it. The owner sends it; nothing starts on its own.
 * Only loadable Hermes experts are offered.
 *
 * ROADMAP 3.10c: in a chat locked by its expert (Options first), "Go ahead" comes first. It
 * prefills a plain task (no expert) in the same folder and access level with this conversation,
 * so the picked option can be done there. Again the owner sends it.
 */
export const GO_AHEAD_VALUE = '__go_ahead__';

export function AskExpertMenuView({
  entries,
  goAhead = false,
  busy,
  onPick,
}: {
  entries: readonly ExpertEntry[];
  /** True in a chat locked by its expert's `toolsets:`. */
  goAhead?: boolean;
  busy: boolean;
  onPick: (value: string) => void;
}) {
  const options = buildExpertOptions(entries).filter((o) => !o.disabled);
  if (options.length === 0 && !goAhead) return null;
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
      {goAhead && (
        <option value={GO_AHEAD_VALUE} title="Do the picked option in a new task in this folder, with no expert and this chat's access level">
          Go ahead (new task)
        </option>
      )}
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
  const [locked, setLocked] = useState(false);
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

  useEffect(() => {
    setLocked(false);
    const experts = window.electronAPI?.maker?.experts;
    if (!sessionId || !experts) return undefined;
    let alive = true;
    const refresh = (): void => {
      void experts.getSessionBinding(sessionId)
        .then((binding) => { if (alive) setLocked(Boolean(binding?.toolsets?.length)); })
        .catch(() => undefined);
    };
    refresh();
    const offSession = experts.onSessionEvent((event) => {
      if (event.type === 'bound' && event.sessionId === sessionId) refresh();
    });
    const offList = experts.onChanged(() => refresh());
    return () => {
      alive = false;
      offSession();
      offList();
    };
  }, [sessionId]);

  if (!sessionId) return null;
  return (
    <AskExpertMenuView
      entries={entries}
      goAhead={locked}
      busy={busy}
      onPick={(slug) => {
        const experts = window.electronAPI?.maker?.experts;
        if (!experts) return;
        setBusy(true);
        if (slug === GO_AHEAD_VALUE) {
          void experts
            .goAhead({ sessionId })
            .then((res) => {
              if (!res.ok) {
                toast.error(res.message);
                return;
              }
              prefillGoAheadDraft(res.prompt, { workingDir: res.workingDir, permissionMode: res.permissionMode });
              navigate('/cc-agent/new');
            })
            .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
            .finally(() => setBusy(false));
          return;
        }
        void experts
          .handoff({ sessionId, slug })
          .then((res) => {
            if (!res.ok) {
              toast.error(res.message);
              return;
            }
            prefillExpertHandoffDraft(res.prompt, res.model);
            navigate('/cc-agent/new');
          })
          .catch((error: unknown) => toast.error(error instanceof Error ? error.message : String(error)))
          .finally(() => setBusy(false));
      }}
    />
  );
}
