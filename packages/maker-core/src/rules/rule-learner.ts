import fs from 'node:fs';
import path from 'node:path';

export interface CorrectionDetection {
  isCorrection: boolean;
  matchedPattern?: string;
  suggestedRuleText: string;
  suggestedTitle: string;
  slug: string;
}

export interface RuleDraft {
  text: string;
  title?: string;
  learnedAt?: string;
}

export interface SaveRuleResult {
  success: boolean;
  filePath: string;
  content: string;
  target: 'vault' | 'soul';
  error?: string;
}

/**
 * Correction patterns reflecting explicit user interventions and preferences.
 */
const CORRECTION_PATTERNS: Array<{ regex: RegExp; name: string; extractor?: (match: RegExpExecArray, text: string) => string }> = [
  // 1. "no, don't / do not / never / stop ..."
  {
    regex: /^(?:no[,!\s]+)?(?:don't|do not|never|stop)\s+(.+)$/im,
    name: 'negative_imperative',
  },
  // 2. "wrong[,!] ...", "that's wrong...", "that was incorrect..."
  {
    regex: /^(?:that['’]?s\s+|that\s+was\s+)?(?:wrong|incorrect|not right)[,!\s]+(.+)$/im,
    name: 'explicit_wrong',
  },
  // 3. "use X instead", "prefer X instead of Y", "always use X"
  {
    regex: /(?:always\s+use|prefer|use)\s+(.+?)(?:\s+instead(?: of .*)?|\s+going forward|\s+from now on|[.!]|$)/im,
    name: 'preference_instead',
  },
  // 4. "please remember to / remember: / from now on, always ..."
  {
    regex: /(?:from now on(?:,\s*|\s+)|please remember to\s+|remember:\s*|rule:\s*)(.+)$/im,
    name: 'explicit_rule_prompt',
  },
  // 5. "I told you to / you should not / you must not"
  {
    regex: /(?:you (?:should not|must not|cannot)|i told you (?:not to|to))\s+(.+)$/im,
    name: 'boundary_enforcement',
  },
];

/**
 * Normalizes text to a clean URL/filename-friendly slug.
 */
export function slugifyRule(text: string, maxLen = 40): string {
  const clean = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return clean.slice(0, maxLen).replace(/-+$/, '') || 'learned-rule';
}

/**
 * Derives a human-readable title from extracted rule text.
 */
export function deriveRuleTitle(text: string, maxLen = 60): string {
  const trimmed = text.trim().replace(/^[-*•\s]+/, '');
  const firstSentence = trimmed.split(/[.!?\n]/)[0]?.trim() || trimmed;
  if (firstSentence.length <= maxLen) {
    return firstSentence.charAt(0).toUpperCase() + firstSentence.slice(1);
  }
  return firstSentence.slice(0, maxLen - 3).trim() + '...';
}

/**
 * Detects whether a message contains a user correction and extracts a rule candidate.
 */
export function detectCorrection(text: string): CorrectionDetection {
  if (!text || typeof text !== 'string') {
    return {
      isCorrection: false,
      suggestedRuleText: '',
      suggestedTitle: '',
      slug: '',
    };
  }

  const trimmed = text.trim();
  if (trimmed.length < 5) {
    return {
      isCorrection: false,
      suggestedRuleText: '',
      suggestedTitle: '',
      slug: '',
    };
  }

  for (const { regex, name, extractor } of CORRECTION_PATTERNS) {
    const match = regex.exec(trimmed);
    if (match) {
      let extracted = extractor ? extractor(match, trimmed) : (match[1] || match[0]);
      extracted = extracted.trim().replace(/^[-*•\s]+/, '');
      if (extracted.length >= 3) {
        // If the pattern was negative ("no, don't do X"), formulate clear rule sentence
        let ruleText = trimmed;
        if (ruleText.length > 200) {
          ruleText = ruleText.slice(0, 200).trim();
        }
        const title = deriveRuleTitle(extracted);
        const slug = slugifyRule(title);
        return {
          isCorrection: true,
          matchedPattern: name,
          suggestedRuleText: ruleText,
          suggestedTitle: title,
          slug,
        };
      }
    }
  }

  return {
    isCorrection: false,
    suggestedRuleText: '',
    suggestedTitle: '',
    slug: '',
  };
}

/**
 * Formats a rule for saving into the Notes Vault (`<vault>/Cindy/Rules/<slug>.md`).
 */
export function formatVaultRuleMarkdown(rule: RuleDraft): string {
  const dateStr = rule.learnedAt || new Date().toISOString();
  const title = rule.title || deriveRuleTitle(rule.text);
  return `---
title: ${JSON.stringify(title)}
type: learned-rule
source: correction
learned_at: ${dateStr}
---

# ${title}

${rule.text.trim()}

> *Learned automatically from user correction on ${dateStr.slice(0, 10)}.*
`;
}

/**
 * Saves a learned rule to the user's Notes Vault under `<vault>/Cindy/Rules/<slug>.md`.
 */
export async function saveRuleToVault(
  vaultDir: string,
  rule: RuleDraft,
): Promise<SaveRuleResult> {
  if (!vaultDir || !fs.existsSync(vaultDir)) {
    return {
      success: false,
      filePath: '',
      content: '',
      target: 'vault',
      error: `Notes vault directory does not exist: ${vaultDir}`,
    };
  }

  const title = rule.title || deriveRuleTitle(rule.text);
  const slug = slugifyRule(title);
  const rulesDir = path.join(vaultDir, 'Cindy', 'Rules');
  fs.mkdirSync(rulesDir, { recursive: true });

  const filePath = path.join(rulesDir, `${slug}.md`);

  // Path containment guard
  const rel = path.relative(vaultDir, filePath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return {
      success: false,
      filePath,
      content: '',
      target: 'vault',
      error: `Path traversal violation: ${filePath}`,
    };
  }

  const content = formatVaultRuleMarkdown({ ...rule, title });
  const tmpPath = path.join(rulesDir, `.${slug}.tmp-${Date.now()}`);

  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath);
    return {
      success: true,
      filePath,
      content,
      target: 'vault',
    };
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    return {
      success: false,
      filePath,
      content: '',
      target: 'vault',
      error: (err as Error).message,
    };
  }
}

/**
 * Appends a learned rule to Hermes `SOUL.md` under `## Rules & Corrections`.
 */
export async function saveRuleToSoul(
  hermesHomeDir: string,
  rule: RuleDraft,
): Promise<SaveRuleResult> {
  if (!hermesHomeDir || !fs.existsSync(hermesHomeDir)) {
    return {
      success: false,
      filePath: '',
      content: '',
      target: 'soul',
      error: `Hermes home directory does not exist: ${hermesHomeDir}`,
    };
  }

  const soulPath = path.join(hermesHomeDir, 'SOUL.md');
  const dateStr = (rule.learnedAt || new Date().toISOString()).slice(0, 10);
  const title = rule.title || deriveRuleTitle(rule.text);
  const formattedEntry = `- **${title}** (${dateStr}): ${rule.text.trim()}\n`;

  let currentContent = '';
  if (fs.existsSync(soulPath)) {
    currentContent = fs.readFileSync(soulPath, 'utf8');
  } else {
    currentContent = '# SOUL.md\n\nAgent personality, behavioral directives, and learned rules.\n\n';
  }

  let nextContent = '';
  const header = '## Rules & Corrections';
  if (currentContent.includes(header)) {
    // Append under existing header
    const index = currentContent.indexOf(header);
    const afterHeader = index + header.length;
    // Find next section or end of file
    const nextSectionIndex = currentContent.indexOf('\n## ', afterHeader);
    if (nextSectionIndex !== -1) {
      nextContent =
        currentContent.slice(0, nextSectionIndex).trimEnd() +
        '\n' +
        formattedEntry +
        '\n' +
        currentContent.slice(nextSectionIndex).trimStart();
    } else {
      nextContent = currentContent.trimEnd() + '\n' + formattedEntry;
    }
  } else {
    // Add header and entry at the end
    nextContent = currentContent.trimEnd() + `\n\n${header}\n\n` + formattedEntry;
  }

  const tmpPath = path.join(hermesHomeDir, `.SOUL.tmp-${Date.now()}`);
  try {
    fs.writeFileSync(tmpPath, nextContent, 'utf8');
    fs.renameSync(tmpPath, soulPath);
    return {
      success: true,
      filePath: soulPath,
      content: formattedEntry,
      target: 'soul',
    };
  } catch (err) {
    if (fs.existsSync(tmpPath)) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    return {
      success: false,
      filePath: soulPath,
      content: '',
      target: 'soul',
      error: (err as Error).message,
    };
  }
}
