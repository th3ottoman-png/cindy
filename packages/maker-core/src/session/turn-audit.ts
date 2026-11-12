/**
 * Session uncertainty & assumption audit (ROADMAP 11.10).
 *
 * When a session's turn audit is on, each Hermes turn carries `TURN_AUDIT_INSTRUCTION` after the
 * owner's text, asking the model to end its answer with ONE fenced footer:
 *
 *   ```cindy-audit
 *   {"progress":70,"decisions":[{"text":"…","why":"…"}],"assumptions":[{"text":"…","confidence":60,"verify":"…"}]}
 *   ```
 *
 * `parseTurnAudit` lifts that footer out of an assistant message (so raw JSON never renders as
 * prose) and normalizes it; `aggregateSessionAudit` folds every audited turn of a session into
 * the "Audit & Assumptions" view. Assumptions below `TURN_AUDIT_LOW_CONFIDENCE`, or with no
 * usable confidence, are flagged `low` so the owner sees possible hallucinations at a glance.
 *
 * Pure: no disk, no clock, no network, no model call.
 */

export const TURN_AUDIT_FENCE = "cindy-audit";

/** Assumptions strictly below this confidence (percent) get the amber warning pill. */
export const TURN_AUDIT_LOW_CONFIDENCE = 80;

/** One example, shared by the instruction and the tests so they cannot drift apart. */
export const TURN_AUDIT_EXAMPLE =
  '{"progress":70,"decisions":[{"text":"Cache session reads in Redis","why":"Reads dominate and SQLite stays the source of truth"}],"assumptions":[{"text":"Redis is running on the default port 6379","confidence":60,"verify":"redis-cli -p 6379 ping"}]}';

export const TURN_AUDIT_INSTRUCTION = [
  "[Turn audit is ON for this session. After your answer, end your message with ONE fenced block:",
  `\`\`\`${TURN_AUDIT_FENCE}`,
  TURN_AUDIT_EXAMPLE,
  "```",
  "- progress: your estimate (0-100) of how complete the owner's overall task is after this turn.",
  "- decisions: architectural or design decisions you made in this turn, each with a one-line why (empty list if none).",
  "- assumptions: things you relied on but did not verify, each with an honest confidence (0-100) and, when you can, a one-line way to verify it. List every assumption below 80; do not inflate confidence.",
  "Keep every entry to one line. The block is hidden from the chat and shown in the owner's audit panel.]",
].join("\n");

/** Append the audit instruction after the owner's text, which stays byte-identical above it. */
export function applyTurnAuditInstruction(text: string): string {
  return `${text}\n\n${TURN_AUDIT_INSTRUCTION}`;
}

export interface TurnAuditDecision {
  text: string;
  why?: string;
}

export interface TurnAuditAssumption {
  text: string;
  /** Percent 0-100, or null when the model gave no usable confidence. */
  confidence: number | null;
  /** True below `TURN_AUDIT_LOW_CONFIDENCE`, and when confidence is unknown. */
  low: boolean;
  verify?: string;
}

export interface TurnAudit {
  progress: number | null;
  decisions: TurnAuditDecision[];
  assumptions: TurnAuditAssumption[];
}

export interface ParsedTurnAudit {
  /** The last valid footer in the message, or null. */
  audit: TurnAudit | null;
  /** Text with every cindy-audit fence (valid, malformed or still streaming) removed. */
  cleanedText: string;
}

const MAX_ENTRIES = 20;
const MAX_TEXT = 300;

function cleanStr(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, MAX_TEXT) : "";
}

/**
 * Accepts 60, 0.6, "60%", " 72.4 ". Values in [0, 1] are read as fractions (so 1 means 100%).
 * Clamped to 0-100 and rounded; anything else is null.
 */
export function normalizePercent(value: unknown): number | null {
  let n: number;
  if (typeof value === "number") n = value;
  else if (
    typeof value === "string" &&
    /^\s*-?\d+(?:\.\d+)?\s*%?\s*$/.test(value)
  )
    n = Number.parseFloat(value);
  else return null;
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1 && !(typeof value === "string" && value.includes("%")))
    n *= 100;
  return Math.round(Math.min(100, Math.max(0, n)));
}

function parseDecision(raw: unknown): TurnAuditDecision | undefined {
  if (typeof raw === "string") {
    const text = cleanStr(raw);
    return text ? { text } : undefined;
  }
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const text = cleanStr(r.text ?? r.decision);
  if (!text) return undefined;
  const why = cleanStr(r.why ?? r.rationale);
  return why ? { text, why } : { text };
}

function parseAssumption(raw: unknown): TurnAuditAssumption | undefined {
  const r: Record<string, unknown> =
    typeof raw === "string"
      ? { text: raw }
      : raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)
        : {};
  const text = cleanStr(r.text ?? r.assumption);
  if (!text) return undefined;
  const confidence = normalizePercent(r.confidence);
  const low = confidence === null || confidence < TURN_AUDIT_LOW_CONFIDENCE;
  const verify = cleanStr(r.verify);
  return verify ? { text, confidence, low, verify } : { text, confidence, low };
}

function parseBody(body: string): TurnAudit | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null;
  const r = parsed as Record<string, unknown>;
  const list = (value: unknown): unknown[] =>
    Array.isArray(value) ? value : [];
  return {
    progress: normalizePercent(r.progress),
    decisions: list(r.decisions)
      .map(parseDecision)
      .filter((d): d is TurnAuditDecision => d !== undefined)
      .slice(0, MAX_ENTRIES),
    assumptions: list(r.assumptions)
      .map(parseAssumption)
      .filter((a): a is TurnAuditAssumption => a !== undefined)
      .slice(0, MAX_ENTRIES),
  };
}

// Body starts right after the fence name: models also write ```cindy-audit{...} on one line.
const CLOSED_FENCE_RE = new RegExp(
  `\`\`\`${TURN_AUDIT_FENCE}([\\s\\S]*?)\`\`\``,
  "g",
);
const OPEN_FENCE_RE = new RegExp(`\`\`\`${TURN_AUDIT_FENCE}[\\s\\S]*$`);

export function parseTurnAudit(content: string): ParsedTurnAudit {
  if (!content || !content.includes(`\`\`\`${TURN_AUDIT_FENCE}`)) {
    return { audit: null, cleanedText: content };
  }
  let audit: TurnAudit | null = null;
  const withoutClosed = content.replace(
    CLOSED_FENCE_RE,
    (_match, body: string) => {
      const parsed = parseBody(String(body));
      if (parsed) audit = parsed;
      return "";
    },
  );
  // A footer still streaming in has no closing fence yet: hide it rather than flash raw JSON.
  const cleanedText = withoutClosed
    .replace(OPEN_FENCE_RE, "")
    .replace(/\s+$/, "");
  return { audit, cleanedText };
}

export interface SessionAuditMessage {
  role: string;
  content?: unknown;
  text?: unknown;
}

export interface SessionAudit {
  /** Progress reported by the most recent audited turn that gave one. */
  progress: number | null;
  auditedTurns: number;
  decisions: Array<TurnAuditDecision & { turn: number }>;
  assumptions: Array<TurnAuditAssumption & { turn: number }>;
  lowConfidenceCount: number;
}

function blockText(value: unknown): string {
  if (typeof value === "string") {
    // The local DB stores content as JSON text (`{"text":…}` or a block list); decode it so the
    // footer's quotes and newlines are real again. Anything else is plain text.
    if (value.startsWith("{") || value.startsWith("[")) {
      try {
        return blockText(JSON.parse(value) as unknown);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value))
    return value.map(blockText).filter(Boolean).join("\n");
  if (value && typeof value === "object") {
    const r = value as Record<string, unknown>;
    if (typeof r.text === "string") return r.text;
    if (typeof r.message === "string") return r.message;
    if (r.content !== undefined) return blockText(r.content);
  }
  return "";
}

/** Stored content is a string or a list of content blocks; only text blocks can carry a footer. */
function messageText(message: SessionAuditMessage): string {
  return blockText(message.content) || blockText(message.text);
}

/** Folds every audited assistant message; `turn` is the 1-based owner prompt it answers. */
export function aggregateSessionAudit(
  messages: readonly SessionAuditMessage[],
): SessionAudit {
  const out: SessionAudit = {
    progress: null,
    auditedTurns: 0,
    decisions: [],
    assumptions: [],
    lowConfidenceCount: 0,
  };
  let turn = 0;
  for (const message of messages) {
    if (message.role === "user") {
      turn += 1;
      continue;
    }
    if (message.role !== "assistant") continue;
    const { audit } = parseTurnAudit(messageText(message));
    if (!audit) continue;
    const at = Math.max(1, turn);
    out.auditedTurns += 1;
    if (audit.progress !== null) out.progress = audit.progress;
    for (const d of audit.decisions) out.decisions.push({ ...d, turn: at });
    for (const a of audit.assumptions) {
      out.assumptions.push({ ...a, turn: at });
      if (a.low) out.lowConfidenceCount += 1;
    }
  }
  return out;
}
