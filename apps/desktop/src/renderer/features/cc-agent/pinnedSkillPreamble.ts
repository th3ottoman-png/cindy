/**
 * ROADMAP 11.1 Tier 2B — composer-side skill pinning for a new draft.
 *
 * Called once, immediately before the 8.4 turn-attachment transform. It resolves
 * `@skill:<slug>` / `/<slug>` pins against the main-process catalog and injects the full
 * SKILL.md bodies into THIS turn's preamble only. The tokens are consumed, so the daemon-side
 * resolver (which covers existing sessions, IM and scheduler turns) is a no-op afterwards.
 *
 * Fail open on convenience: if the preload API is unavailable (unit harness, older build) or
 * the IPC fails, the message passes through byte-identical. No session state is written.
 */

import { applyPinnedSkills } from '@cindy/maker-core/pinned-skill-invocation';

/** Cheap guard so the common case (no pins) never opens an IPC round trip. */
const PIN_SHAPED = /(?:@skill:|\/)/;

export async function applyPinnedSkillsForTurn(
  message: string,
  options: { chatOnly?: boolean } = {},
): Promise<string> {
  if (options.chatOnly || !message || !PIN_SHAPED.test(message)) return message;
  const resolve = window?.electronAPI?.maker?.skills?.resolvePinned;
  if (typeof resolve !== 'function') return message;
  try {
    const response = await resolve({ text: message, chatOnly: options.chatOnly });
    if (!response?.skills?.length) return message;
    return applyPinnedSkills(message, response.skills, { chatOnly: options.chatOnly });
  } catch {
    // A broken resolver must never block the owner's message.
    return message;
  }
}
