import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';

/** Read-only model shown beside the session title. Hermes sessions only (ROADMAP 1.8b). */
export function HermesSessionModelLabel({
  agentKind,
  model,
}: {
  agentKind: string;
  model: string | null | undefined;
}) {
  if (agentKind !== 'hermes' || !model) return null;
  return (
    <span
      data-testid="hermes-session-model"
      title={model}
      className="mx-1 min-w-0 max-w-[16vw] shrink truncate text-xs text-[var(--text-tertiary)]"
      style={WINDOW_NO_DRAG_STYLE}
    >
      {model}
    </span>
  );
}
