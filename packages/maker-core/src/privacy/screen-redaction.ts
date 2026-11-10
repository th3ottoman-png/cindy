export type RedactionCategory =
  | 'api-key'
  | 'token'
  | 'password'
  | 'email'
  | 'financial'
  | 'system-path';

export interface RedactionSpan {
  start: number;
  end: number;
  category: RedactionCategory;
  matchedText: string;
  replacement: string;
}

export interface RedactionOptions {
  maskStyle?: 'badge' | 'bullets' | 'redacted';
}

interface PatternRule {
  category: RedactionCategory;
  regex: RegExp;
  getReplacement: (match: string, ...groups: string[]) => string;
}

const REDACTION_RULES: PatternRule[] = [
  // API Keys: sk-..., ghp_..., gho_..., Google AIza...
  {
    category: 'api-key',
    regex: /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]-[A-Za-z0-9_]{16,}|xox[baprs]-[A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z-_]{35})\b/g,
    getReplacement: () => '[REDACTED:API_KEY]',
  },
  // Key / secret assignments: api_key = "...", secret: '...'
  {
    category: 'api-key',
    regex: /\b(api[_-]?key|secret_key|private_key)\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})["']?/gi,
    getReplacement: (_match, p1) => `${p1}: [REDACTED:KEY]`,
  },
  // Tokens: Bearer ..., token: "..."
  {
    category: 'token',
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    getReplacement: () => 'Bearer [REDACTED:TOKEN]',
  },
  {
    category: 'token',
    regex: /\b(access_token|refresh_token|auth_token)\s*[:=]\s*["']?([A-Za-z0-9._~+/=-]{8,})["']?/gi,
    getReplacement: (_match, p1) => `${p1}: [REDACTED:TOKEN]`,
  },
  // Passwords: password = "..."
  {
    category: 'password',
    regex: /\b(password|passwd|pwd)\s*[:=]\s*["']?([^\s"',}]{4,})["']?/gi,
    getReplacement: (_match, p1) => `${p1}: [REDACTED:PASSWORD]`,
  },
  // Email addresses
  {
    category: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    getReplacement: () => '[REDACTED:EMAIL]',
  },
  // Financial amounts: $1,250.00, 500 USD, 1500 tokens
  {
    category: 'financial',
    regex: /(?:\$\s*\d+(?:,\d{3})*(?:\.\d{1,2})?|\b\d+(?:,\d{3})*(?:\.\d{1,2})?\s*(?:USD|EUR|GBP|CNY)\b)/gi,
    getReplacement: () => '[REDACTED:AMOUNT]',
  },
  // Home and user directory paths: /Users/<user>/ or /home/<user>/
  {
    category: 'system-path',
    regex: /(?:\/Users\/|\/home\/)([a-zA-Z0-9._-]+)(?=\/|$)/g,
    getReplacement: (match) => {
      const prefix = match.startsWith('/Users/') ? '/Users/' : '/home/';
      return `${prefix}[REDACTED:USER]`;
    },
  },
];

/**
 * Finds all sensitive redaction spans in text, sorted by start position, non-overlapping.
 */
export function findRedactionSpans(text: string): RedactionSpan[] {
  if (!text || typeof text !== 'string') return [];

  const rawSpans: RedactionSpan[] = [];

  for (const rule of REDACTION_RULES) {
    // Clone regex to reset lastIndex
    const re = new RegExp(rule.regex.source, rule.regex.flags);
    let match: RegExpExecArray | null;

    while ((match = re.exec(text)) !== null) {
      const matchedText = match[0];
      const start = match.index;
      const end = start + matchedText.length;
      const replacement = rule.getReplacement(matchedText, ...(match.slice(1) as string[]));

      rawSpans.push({
        start,
        end,
        category: rule.category,
        matchedText,
        replacement,
      });
    }
  }

  // Sort by start position
  rawSpans.sort((a, b) => a.start - b.start || b.end - a.end);

  // De-duplicate and filter overlapping spans (prefer earlier or longer)
  const result: RedactionSpan[] = [];
  let lastEnd = -1;

  for (const span of rawSpans) {
    if (span.start >= lastEnd) {
      result.push(span);
      lastEnd = span.end;
    }
  }

  return result;
}

/**
 * Redacts all sensitive patterns from text.
 */
export function redactSensitiveText(text: string, options: RedactionOptions = {}): string {
  if (!text || typeof text !== 'string') return '';

  const spans = findRedactionSpans(text);
  if (spans.length === 0) return text;

  let out = '';
  let cursor = 0;

  for (const span of spans) {
    out += text.slice(cursor, span.start);

    if (options.maskStyle === 'bullets') {
      out += '•'.repeat(Math.min(span.matchedText.length, 8));
    } else if (options.maskStyle === 'redacted') {
      out += '[REDACTED]';
    } else {
      out += span.replacement;
    }

    cursor = span.end;
  }

  out += text.slice(cursor);
  return out;
}

/**
 * Returns CSS stylesheet content for screen-share privacy redaction mode.
 */
export function getScreenShareRedactionCss(): string {
  return `
/* Screen-Share & Recording Privacy Redaction Mode (ROADMAP 7.7) */
body.screen-share-privacy-active .privacy-sensitive,
body.screen-share-privacy-active [data-privacy-sensitive="true"] {
  filter: blur(5px) !important;
  user-select: none !important;
  transition: filter 0.15s ease-in-out;
}

body.screen-share-privacy-active .privacy-sensitive:hover,
body.screen-share-privacy-active [data-privacy-sensitive="true"]:hover {
  filter: blur(2px) !important;
}

body.screen-share-privacy-active .privacy-mask-text {
  background-color: var(--surface-hover, #2d3748) !important;
  color: transparent !important;
  border-radius: 3px;
  user-select: none !important;
}
`;
}
