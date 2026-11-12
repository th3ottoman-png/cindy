/**
 * Decision-card blocks (ROADMAP 11.7 Plan First).
 *
 * While the Plan First lock is on, the model returns its 1–3 consequential decisions as ONE
 * fenced block:
 *
 *   ```cindy-decisions
 *   {"decisions":[{"id":"auth","question":"…","options":[{"id":"jwt","label":"…","detail":"…"}],"defaultOptionId":"jwt"}]}
 *   ```
 *
 * The parser lifts validated blocks out of the assistant text (so the raw JSON never renders
 * as prose) and hands the decisions to the interactive `DecisionCards` component. Pure:
 * no DOM, no store, no IPC — unit-tested in isolation.
 */

export interface DecisionOption {
  id: string;
  label: string;
  detail?: string;
}

export interface PlanDecision {
  id: string;
  question: string;
  options: DecisionOption[];
  defaultOptionId?: string;
}

export interface ParsedDecisions {
  decisions: PlanDecision[];
  /** Original text with every (parseable or not) cindy-decisions fence removed. */
  cleanedText: string;
}

export const DECISIONS_FENCE = 'cindy-decisions';

const MAX_DECISIONS = 5;
const MAX_OPTIONS = 6;
const MAX_ID = 80;
const MAX_TEXT = 300;

function cleanStr(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function parseOption(raw: unknown): DecisionOption | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = cleanStr(r.id, MAX_ID);
  const label = cleanStr(r.label, MAX_TEXT);
  if (!id || !label) return undefined;
  const detail = cleanStr(r.detail, MAX_TEXT);
  return { id, label, ...(detail ? { detail } : {}) };
}

function parseDecision(raw: unknown): PlanDecision | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = cleanStr(r.id, MAX_ID);
  const question = cleanStr(r.question, MAX_TEXT);
  if (!id || !question) return undefined;
  const options = (Array.isArray(r.options) ? r.options : [])
    .map(parseOption)
    .filter((o): o is DecisionOption => o !== undefined)
    .slice(0, MAX_OPTIONS);
  if (options.length < 2) return undefined;
  const out: PlanDecision = { id, question, options };
  const def = cleanStr(r.defaultOptionId, MAX_ID);
  if (def && options.some((o) => o.id === def)) out.defaultOptionId = def;
  return out;
}

const FENCE_RE = /```cindy-decisions\s*([\s\S]*?)\s*```/g;

/**
 * Extract validated decision blocks; strip every cindy-decisions fence (valid or not) from
 * the display text so unparseable model output degrades to nothing, not raw JSON.
 */
export function parseDecisionBlocks(content: string): ParsedDecisions {
  if (!content || !content.includes(DECISIONS_FENCE)) return { decisions: [], cleanedText: content };
  const decisions: PlanDecision[] = [];
  const cleanedText = content.replace(FENCE_RE, (_match, body: string) => {
    try {
      const parsed: unknown = JSON.parse(String(body).trim());
      const list =
        parsed && typeof parsed === 'object' && Array.isArray((parsed as { decisions?: unknown }).decisions)
          ? (parsed as { decisions: unknown[] }).decisions
          : [];
      for (const raw of list.slice(0, MAX_DECISIONS)) {
        const d = parseDecision(raw);
        if (d && !decisions.some((seen) => seen.id === d.id)) decisions.push(d);
      }
    } catch {
      // Unparseable block: still stripped (see doc comment), just yields no cards.
    }
    return '';
  });
  return { decisions, cleanedText };
}
