/**
 * Decision-card blocks (ROADMAP 11.7 Plan First).
 *
 * While the Plan First lock is on, the model returns its plan decisions as ONE fenced block,
 * either the 1–3 consequential choices of 11.7a:
 *
 *   ```cindy-decisions
 *   {"decisions":[{"id":"auth","question":"…","options":[{"id":"jwt","label":"…","detail":"…"}],"defaultOptionId":"jwt"}]}
 *   ```
 *
 * or the Interrogate 4x4 tradeoff matrix of 11.7b (options scored against criteria):
 *
 *   ```cindy-matrix
 *   {"matrix":{"title":"…","criteria":["…","…"],"rows":[{"id":"jwt","label":"…","scores":["…","…"]}],"defaultOptionId":"jwt"}}
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
  /** Interrogate 4x4 (11.7b): one cell per criteria column, same order as `criteria`. */
  scores?: string[];
}

export interface PlanDecision {
  id: string;
  question: string;
  options: DecisionOption[];
  defaultOptionId?: string;
  /**
   * Interrogate 4x4 (11.7b): column headers of a tradeoff matrix. Presence switches the card
   * to matrix rendering (options as selectable rows, cells from `scores`).
   */
  criteria?: string[];
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

/** Parse an interrogate 4x4 row: id + label required, scores trimmed to the criteria width. */
function parseMatrixRow(raw: unknown, width: number): DecisionOption | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const id = cleanStr(r.id, MAX_ID);
  const label = cleanStr(r.label, MAX_TEXT);
  if (!id || !label) return undefined;
  const detail = cleanStr(r.summary ?? r.detail, MAX_TEXT);
  const scores = (Array.isArray(r.scores) ? r.scores : [])
    .map((s) => cleanStr(s, 60))
    .filter((s): s is string => s.length > 0)
    .slice(0, width);
  const out: DecisionOption = { id, label, ...(detail ? { detail } : {}) };
  if (scores.length > 0) out.scores = scores;
  return out;
}

/** Parse the `cindy-matrix` body (11.7b): 4-ish options scored against 4-ish criteria. */
function parseMatrixBody(raw: unknown): PlanDecision | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = (raw as Record<string, unknown>).matrix;
  if (!m || typeof m !== 'object') return undefined;
  const r = m as Record<string, unknown>;
  const id = cleanStr(r.id ?? 'matrix', MAX_ID);
  const question = cleanStr(r.title ?? r.question, MAX_TEXT);
  if (!question) return undefined;
  const criteria = (Array.isArray(r.criteria) ? r.criteria : [])
    .map((c) => cleanStr(c, MAX_TEXT))
    .filter((c): c is string => c.length > 0)
    .slice(0, MAX_OPTIONS);
  if (criteria.length < 2) return undefined;
  const options = (Array.isArray(r.rows) ? r.rows : [])
    .map((row) => parseMatrixRow(row, criteria.length))
    .filter((o): o is DecisionOption => o !== undefined)
    .slice(0, MAX_OPTIONS);
  if (options.length < 2) return undefined;
  const out: PlanDecision = { id, question, options, criteria };
  const def = cleanStr(r.defaultOptionId, MAX_ID);
  if (def && options.some((o) => o.id === def)) out.defaultOptionId = def;
  return out;
}

const FENCE_RE = /```(cindy-decisions|cindy-matrix)\s*([\s\S]*?)\s*```/g;

/**
 * Extract validated decision blocks; strip every cindy-decisions/cindy-matrix fence (valid or
 * not) from the display text so unparseable model output degrades to nothing, not raw JSON.
 */
export function parseDecisionBlocks(content: string): ParsedDecisions {
  if (!content || !content.includes('cindy-')) return { decisions: [], cleanedText: content };
  const decisions: PlanDecision[] = [];
  const cleanedText = content.replace(FENCE_RE, (_match, name: string, body: string) => {
    try {
      const parsed: unknown = JSON.parse(String(body).trim());
      const list =
        parsed && typeof parsed === 'object' && Array.isArray((parsed as { decisions?: unknown }).decisions)
          ? (parsed as { decisions: unknown[] }).decisions
          : [];
      const incoming =
        name === 'cindy-matrix'
          ? [parseMatrixBody(parsed)].filter((d): d is PlanDecision => d !== undefined)
          : list.slice(0, MAX_DECISIONS).map(parseDecision).filter((d): d is PlanDecision => d !== undefined);
      for (const d of incoming) {
        if (!decisions.some((seen) => seen.id === d.id)) decisions.push(d);
      }
    } catch {
      // Unparseable block: still stripped (see doc comment), just yields no cards.
    }
    return '';
  });
  return { decisions, cleanedText };
}
