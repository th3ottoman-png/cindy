/**
 * Plan First mode (ROADMAP 11.7), daemon side.
 *
 * When a session's Plan First lock is on, the model's turns are for architectural discovery:
 * file-writing tools stay locked until the owner answers the decision cards (or Proceeds to
 * Build). Two halves:
 *
 * - `PLAN_FIRST_TURN_INSTRUCTION`: prepended to the turn text while locked (in-band, like the
 *   11.1 pinned-skills precedent — Hermes chat has no system-prompt flag). It teaches the
 *   `cindy-decisions` fenced block the renderer turns into interactive cards.
 * - `PLAN_FIRST_LOCK_REASON`: the block reason a locked file-write call dies with. No owner
 *   card is raised — the decision UI is where this resolves, not a per-call approval.
 *
 * Pure: no disk, no model, no network.
 */

/** Fence the model must wrap its decisions in so the renderer can lift them into cards. */
export const PLAN_FIRST_DECISIONS_FENCE = 'cindy-decisions';

/**
 * Example block, kept in one place so the instruction, the parser contract and the tests
 * cannot drift apart.
 */
export const PLAN_FIRST_DECISIONS_EXAMPLE = `{"decisions":[{"id":"auth","question":"How should users sign in?","options":[{"id":"jwt","label":"JWT in header","detail":"Stateless, works for the mobile app later"},{"id":"session","label":"Server sessions","detail":"Simpler to revoke, needs sticky storage"}],"defaultOptionId":"jwt"}]}`;

export const PLAN_FIRST_TURN_INSTRUCTION = [
  '[Plan First mode is ON for this session: this turn is for planning only.',
  'Do NOT call any file-writing tool (write_file, patch, edit, terminal writes, …) — locked calls are refused automatically.',
  'Reads (read_file, searches, terminal reads) are allowed so you can ground your options.',
  'Return 1–3 consequential decisions the owner must make as ONE fenced block:',
  '```cindy-decisions',
  PLAN_FIRST_DECISIONS_EXAMPLE,
  '```',
  'Keep `id` values short kebab-case, `question` to one line, each option to a `label` plus one-line `detail`, and mark the recommended option with `defaultOptionId`.',
  'Then stop and wait — no code, no writes. The owner answers in the UI and file tools unlock after they proceed.]',
].join('\n');

/** Block reason for a file-write call while the Plan First lock is on. */
export const PLAN_FIRST_LOCK_REASON =
  'Plan First is on: file writes are locked until the owner answers the decision cards or proceeds to build. ' +
  'Ask your questions in text instead — do not retry the write.';

/**
 * Prepend the Plan First instruction to a turn while the lock is on. Pure string join so the
 * owner's text stays byte-identical below the instruction.
 */
export function applyPlanFirstInstruction(text: string): string {
  return `${PLAN_FIRST_TURN_INSTRUCTION}\n\n${text}`;
}
