/**
 * ROADMAP 11.1 Tier 2B — deterministic, user-driven skill pinning.
 *
 * The owner types `@skill:<slug>` or `/<slug>` in the composer. Cindy resolves exactly those
 * skills and injects their FULL SKILL.md bodies into that one turn's preamble. Nothing is
 * enabled, disabled or persisted; the next turn has no pinned skills.
 *
 * Pure by design: token parsing, preamble rendering and text rewriting have no I/O, clock or
 * model call. The caller resolves slugs against the discovery catalog and passes back plain
 * strings. Unknown slugs are never guessed: `/name` is a pin only when `name` is an installed
 * skill, so real slash commands (`/issue`, `/model`) and filesystem paths are never hijacked.
 *
 * This complements (does not replace) the 8.4 turn-attachment preamble: that one names the
 * attachment for the session header; this one supplies the actual instructions to the model.
 */

export const MAX_PINNED_SKILLS = 4;
/** Upper bound on the injected preamble so a large skill set cannot flood the prompt. */
export const MAX_PINNED_CHARS = 40_000;

export interface PinnedSkillToken {
  slug: string;
  raw: string;
  start: number;
  end: number;
}

export interface PinnedSkillInstructions {
  slug: string;
  name: string;
  /** SKILL.md body with frontmatter stripped, already bounded by the activation engine. */
  instructions: string;
  truncated: boolean;
  availableScripts: string[];
  availableReferences: string[];
}

const SLUG_CHARS = '[a-z0-9][a-z0-9._-]*';

function tidy(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,;:!?])/g, '$1')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Find composer pins. `knownSlugs` comes from the compiled discovery catalog; without it
 * nothing is treated as a pin (fail closed). A leading slash command must be the first
 * non-whitespace token on its line, so `/Users/.../git-worktree` prose is never a pin.
 */
export function parsePinnedSkillTokens(
  text: string,
  knownSlugs: readonly string[],
): PinnedSkillToken[] {
  if (!text || knownSlugs.length === 0) return [];
  const bySlug = new Map(knownSlugs.map((slug) => [slug.toLowerCase(), slug]));
  const out: PinnedSkillToken[] = [];
  const seen = new Set<string>();

  const add = (raw: string, candidate: string, start: number): void => {
    const slug = bySlug.get(candidate.toLowerCase());
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    out.push({ slug, raw, start, end: start + raw.length });
  };

  // @skill:<slug> — word boundary before @, slug ends at whitespace or trailing punctuation.
  const atPattern = new RegExp(`(^|[\\s([{"'>-])@skill:(${SLUG_CHARS})`, 'gi');
  for (const match of text.matchAll(atPattern)) {
    const raw = `@skill:${match[2]}`.replace(/[.,;:!?]+$/, '');
    add(raw, match[2].replace(/[.,;:!?]+$/, ''), match.index + match[1].length);
    if (out.length >= MAX_PINNED_SKILLS) return out;
  }

  // /<slug> — only at the start of a line, and only when it names an installed skill.
  const slashPattern = new RegExp(`(^|\\n)[ \\t]*/(${SLUG_CHARS})(?=\\s|$)`, 'gi');
  for (const match of text.matchAll(slashPattern)) {
    if (!bySlug.has(match[2].toLowerCase())) continue;
    const raw = `/${match[2]}`;
    const start = match.index + match[1].length + (match[0].length - match[1].length - raw.length);
    add(raw, match[2], start);
    if (out.length >= MAX_PINNED_SKILLS) return out;
  }

  return out.sort((a, b) => a.start - b.start);
}

/** Bounded `<pinned_skills>` block. Empty when there is nothing to inject. */
export function renderPinnedSkillPreamble(items: readonly PinnedSkillInstructions[]): string {
  if (items.length === 0) return '';
  const lines = [
    '<pinned_skills>',
    'The owner pinned these skills for THIS TURN ONLY. Follow their instructions; they are not session state.',
  ];
  for (const item of items.slice(0, MAX_PINNED_SKILLS)) {
    lines.push('', `<skill slug="${item.slug}" name="${item.name}">`, item.instructions.trim());
    if (item.truncated) lines.push('[Truncated: skill file exceeds 32KB]');
    for (const asset of item.availableScripts) lines.push(`- Script (run via bash, do not read into context): ${asset}`);
    for (const asset of item.availableReferences) lines.push(`- Reference (read via file tools only if needed): ${asset}`);
    lines.push('</skill>');
  }
  lines.push('</pinned_skills>');
  const text = lines.join('\n');
  return text.length <= MAX_PINNED_CHARS
    ? text
    : `${text.slice(0, MAX_PINNED_CHARS - 80)}\n[Truncated: pinned skills exceeded the preamble budget]\n</pinned_skills>`;
}

export interface ApplyPinnedSkillsOptions {
  /** Chat-only sessions have no tools; pinning must not inject instructions there. */
  chatOnly?: boolean;
}

/**
 * Strip resolved pins from the owner's message and prepend the full instructions.
 * A leading slash command keeps the first line so command routing still matches it.
 */
export function applyPinnedSkills(
  text: string,
  items: readonly PinnedSkillInstructions[],
  options: ApplyPinnedSkillsOptions = {},
): string {
  if (options.chatOnly || items.length === 0) return text;
  const resolved = new Map(items.map((item) => [item.slug.toLowerCase(), item]));
  const knownSlugs = [...resolved.keys()];
  const tokens = parsePinnedSkillTokens(text, knownSlugs);
  if (tokens.length === 0) return text;
  const preamble = renderPinnedSkillPreamble(tokens.map((token) => resolved.get(token.slug.toLowerCase())!));

  let output = '';
  let cursor = 0;
  for (const token of tokens) {
    if (token.start < cursor) continue;
    output += text.slice(cursor, token.start);
    cursor = token.end;
  }
  output += text.slice(cursor);
  const body = tidy(output);
  if (!body) return preamble;
  if (body.startsWith('/')) {
    const lineEnd = body.indexOf('\n');
    if (lineEnd < 0) return `${body}\n\n${preamble}`;
    return `${body.slice(0, lineEnd)}\n\n${preamble}\n${body.slice(lineEnd + 1)}`;
  }
  return `${preamble}\n\n${body}`;
}
