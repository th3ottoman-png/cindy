import { describe, expect, it } from "vitest";

import {
  TURN_AUDIT_EXAMPLE,
  TURN_AUDIT_FENCE,
  TURN_AUDIT_INSTRUCTION,
  TURN_AUDIT_LOW_CONFIDENCE,
  aggregateSessionAudit,
  applyTurnAuditInstruction,
  normalizePercent,
  parseTurnAudit,
} from "../turn-audit";

const fence = (body: string) => `\`\`\`${TURN_AUDIT_FENCE}\n${body}\n\`\`\``;

describe("turn audit (ROADMAP 11.10)", () => {
  it("teaches a footer block whose example parses with the same parser", () => {
    expect(TURN_AUDIT_INSTRUCTION).toContain(`\`\`\`${TURN_AUDIT_FENCE}`);
    expect(TURN_AUDIT_INSTRUCTION).toContain(TURN_AUDIT_EXAMPLE);
    const { audit } = parseTurnAudit(fence(TURN_AUDIT_EXAMPLE));
    expect(audit?.progress).toBe(70);
    expect(audit?.decisions[0]?.text).toBeTruthy();
    expect(audit?.assumptions[0]).toMatchObject({ confidence: 60, low: true });
  });

  it("appends the instruction after the owner text, which stays byte-identical", () => {
    const owner = "Refactor the cache layer.\n  keep spacing  ";
    const out = applyTurnAuditInstruction(owner);
    expect(out.startsWith(owner)).toBe(true);
    expect(out.endsWith(TURN_AUDIT_INSTRUCTION)).toBe(true);
  });

  it("normalizes percent from fractions, numbers and strings, and clamps", () => {
    expect(normalizePercent(0.6)).toBe(60);
    expect(normalizePercent(60)).toBe(60);
    expect(normalizePercent("85%")).toBe(85);
    expect(normalizePercent(" 72.4 ")).toBe(72);
    expect(normalizePercent(140)).toBe(100);
    expect(normalizePercent(-3)).toBe(0);
    expect(normalizePercent(1)).toBe(100);
    expect(normalizePercent("high")).toBeNull();
    expect(normalizePercent(undefined)).toBeNull();
    expect(normalizePercent(Number.NaN)).toBeNull();
  });

  it("extracts progress, decisions and assumptions and strips the block from display text", () => {
    const text = [
      "Done: moved sessions behind a cache.",
      "",
      fence(
        JSON.stringify({
          progress: "45%",
          decisions: [
            { text: "Cache sessions in Redis", why: "Reads dominate" },
            "Keep SQLite as source of truth",
          ],
          assumptions: [
            {
              text: "Redis is running on the default port 6379",
              confidence: 0.6,
              verify: "redis-cli -p 6379 ping",
            },
            { text: "Node 22 is installed", confidence: 95 },
            { text: "No confidence given" },
          ],
        }),
      ),
    ].join("\n");
    const { audit, cleanedText } = parseTurnAudit(text);
    expect(cleanedText.trim()).toBe("Done: moved sessions behind a cache.");
    expect(audit).toEqual({
      progress: 45,
      decisions: [
        { text: "Cache sessions in Redis", why: "Reads dominate" },
        { text: "Keep SQLite as source of truth" },
      ],
      assumptions: [
        {
          text: "Redis is running on the default port 6379",
          confidence: 60,
          low: true,
          verify: "redis-cli -p 6379 ping",
        },
        { text: "Node 22 is installed", confidence: 95, low: false },
        // Unknown confidence is treated as unverified: flagged, never silently trusted.
        { text: "No confidence given", confidence: null, low: true },
      ],
    });
  });

  it("reads a footer written on the same line as the fence name (seen live from deepseek)", () => {
    const { audit, cleanedText } = parseTurnAudit(
      'Plan.\n\n```cindy-audit{"progress":100,"decisions":["Keep SQLite"]}\n```',
    );
    expect(audit).toEqual({
      progress: 100,
      decisions: [{ text: "Keep SQLite" }],
      assumptions: [],
    });
    expect(cleanedText).toBe("Plan.");
  });

  it("flags exactly the assumptions below the 80% threshold", () => {
    expect(TURN_AUDIT_LOW_CONFIDENCE).toBe(80);
    const { audit } = parseTurnAudit(
      fence(
        '{"assumptions":[{"text":"a","confidence":79},{"text":"b","confidence":80}]}',
      ),
    );
    expect(audit?.assumptions.map((a) => a.low)).toEqual([true, false]);
  });

  it("strips malformed and unclosed (still streaming) blocks without yielding an audit", () => {
    const bad = parseTurnAudit(`Answer.\n${fence("{not json")}`);
    expect(bad.audit).toBeNull();
    expect(bad.cleanedText.trim()).toBe("Answer.");
    const streaming = parseTurnAudit('Answer.\n```cindy-audit\n{"progress": 4');
    expect(streaming.audit).toBeNull();
    expect(streaming.cleanedText.trim()).toBe("Answer.");
  });

  it("leaves text without a block untouched and returns no audit", () => {
    const text = "Plain answer with ```js\ncode\n``` inside.";
    expect(parseTurnAudit(text)).toEqual({ audit: null, cleanedText: text });
  });

  it("drops empty entries and caps list sizes", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      text: `a${i}`,
      confidence: 50,
    }));
    const { audit } = parseTurnAudit(
      fence(
        JSON.stringify({
          decisions: ["", { text: "  " }],
          assumptions: [...many, { confidence: 10 }],
        }),
      ),
    );
    expect(audit?.decisions).toEqual([]);
    expect(audit?.assumptions).toHaveLength(20);
  });

  it("aggregates a session: latest progress, entries tagged by turn, low-confidence count", () => {
    const summary = aggregateSessionAudit([
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: `one\n${fence('{"progress":30,"decisions":["Use Postgres"],"assumptions":[{"text":"x","confidence":50}]}')}`,
      },
      { role: "user", content: `pasted ${fence('{"progress":99}')}` },
      { role: "assistant", text: "no block this turn" },
      {
        role: "assistant",
        content: `two\n${fence('{"progress":0.8,"assumptions":[{"text":"y","confidence":90}]}')}`,
      },
    ]);
    expect(summary).toEqual({
      progress: 80,
      auditedTurns: 2,
      decisions: [{ text: "Use Postgres", turn: 1 }],
      assumptions: [
        { text: "x", confidence: 50, low: true, turn: 1 },
        // Turn = the owner prompt it answers (2nd user message), not the assistant row index.
        { text: "y", confidence: 90, low: false, turn: 2 },
      ],
      lowConfidenceCount: 1,
    });
  });

  it("reads the footer from stored content blocks, not only plain strings", () => {
    const summary = aggregateSessionAudit([
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "text", text: fence('{"progress":25}') },
        ],
      },
    ]);
    expect(summary.progress).toBe(25);
    expect(summary.auditedTurns).toBe(1);
  });

  it("decodes content stored as JSON text, the way the local DB keeps it", () => {
    const summary = aggregateSessionAudit([
      { role: "user", content: JSON.stringify({ text: "plan it" }) },
      {
        role: "assistant",
        content: JSON.stringify({
          text: `plan\n${fence('{"progress":35,"assumptions":[{"text":"Redis on 6379","confidence":60}]}')}`,
        }),
      },
      { role: "assistant", content: "{not json but plain text" },
    ]);
    expect(summary.progress).toBe(35);
    expect(summary.assumptions).toEqual([
      { text: "Redis on 6379", confidence: 60, low: true, turn: 1 },
    ]);
  });

  it("returns an empty summary for a session with no audited turns", () => {
    expect(aggregateSessionAudit([])).toEqual({
      progress: null,
      auditedTurns: 0,
      decisions: [],
      assumptions: [],
      lowConfidenceCount: 0,
    });
  });
});
