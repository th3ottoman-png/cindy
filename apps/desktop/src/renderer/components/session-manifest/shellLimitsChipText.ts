import type { ShellLimitsView } from '../../../main/maker-ipc/shellLimits';

export interface ShellLimitsChipModel {
  label: string;
  title: string;
  state: 'on' | 'off' | 'error';
}

/**
 * ROADMAP 13.10b: `shell 300s` in the session manifest strip.
 *
 * The limit is one owner file, not a per-session number, so this is pure text: no polling, no
 * daemon call. `state: 'error'` means the file was read but a value in it was not usable, which the
 * strip must show rather than hide behind a plausible-looking number.
 */
export function shellLimitsChip(view: ShellLimitsView | null): ShellLimitsChipModel | null {
  if (!view || !view.file) return null;
  const seconds = view.timeoutSeconds;
  const state: ShellLimitsChipModel['state'] =
    view.errors.length > 0 ? 'error' : seconds > 0 ? 'on' : 'off';
  const label = seconds > 0 ? `shell ${seconds}s` : 'shell default';
  const source = view.exists ? view.file : `${view.file} (not created; defaults in use)`;
  const title =
    state === 'error'
      ? `${source} — ${view.errors.join(' | ')}`
      : seconds > 0
        ? `Shell limit from ${source}: a terminal command stops after ${seconds} s. `
          + "A per-call timeout in the model's own tool call still wins."
        : `No shell limit in ${source} (timeout_seconds 0): Hermes' own default (180 s) applies.`;
  return { label, title, state };
}
