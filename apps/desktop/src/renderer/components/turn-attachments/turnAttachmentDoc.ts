import type { JSONContent } from '@tiptap/core';

/**
 * Draft-document text editing for turn-scoped `@` attachments (ROADMAP 8.4).
 *
 * The composer stores a Tiptap JSON document. An attachment token lives inside
 * one text node, so inserting or removing one must not rebuild the whole
 * document: file mentions, quotes and pasted-text chips are atomic nodes that a
 * plain-text round-trip would destroy.
 *
 * `composerPlainText` and `replaceComposerTextRange` share one offset walker on
 * purpose. The trigger position is computed from the plain text and then used
 * to edit the document, so the two must agree exactly or the edit lands in the
 * wrong place.
 */

/** A mention chip contributes its visible label to the plain text. */
function chipLabel(node: JSONContent): string | null {
  const label = (node.attrs as { label?: unknown } | undefined)?.label;
  return typeof label === 'string' ? label : null;
}

function isBlockBoundary(node: JSONContent): boolean {
  return node.type === 'paragraph' || node.type === 'heading';
}

/**
 * Plain text of a draft document. Paragraph and heading boundaries count as
 * one newline, hard breaks as one newline, mention chips as their label.
 */
function walkPlainText(doc: JSONContent | null | undefined): string {
  if (!doc) return '';
  const parts: string[] = [];
  const walk = (node: JSONContent) => {
    if (node.type === 'text') {
      parts.push(node.text ?? '');
      return;
    }
    if (node.type === 'hardBreak') {
      parts.push('\n');
      return;
    }
    const label = chipLabel(node);
    if (label !== null) {
      parts.push(label);
      return;
    }
    node.content?.forEach(walk);
    if (isBlockBoundary(node)) parts.push('\n');
  };
  walk(doc);
  return parts.join('');
}

/** Trimmed text, for chips, tests and anything the owner reads. */
export function composerPlainText(doc: JSONContent | null | undefined): string {
  return walkPlainText(doc).trim();
}

/**
 * Text used to detect a live `@` query. Only trailing newlines are removed:
 * the space after a finished token must survive, because that space is the
 * only thing that separates `@skill:search_notes ` (done) from
 * `@skill:search` (still being typed). Trimming it would reopen the panel on
 * the token that was just written.
 */
export function composerTriggerText(doc: JSONContent | null | undefined): string {
  return walkPlainText(doc).replace(/\n+$/, '');
}

/**
 * Replace `[start, end)` of the plain text with `replacement`, preserving every
 * other node by identity. Returns null when the range crosses a node boundary
 * or falls outside the document, so the caller can skip the rewrite instead of
 * corrupting the draft.
 */
export function replaceComposerTextRange(
  doc: JSONContent | null | undefined,
  start: number,
  end: number,
  replacement: string,
): JSONContent | null {
  if (!doc || start < 0 || end < start) return null;

  let offset = 0;
  let changed = false;

  const walk = (node: JSONContent): JSONContent => {
    if (changed) return node;

    if (node.type === 'text') {
      const text = node.text ?? '';
      const nodeStart = offset;
      const nodeEnd = offset + text.length;
      offset = nodeEnd;
      if (start >= nodeStart && end <= nodeEnd) {
        const nextText =
          text.slice(0, start - nodeStart) + replacement + text.slice(end - nodeStart);
        changed = true;
        return { ...node, text: nextText };
      }
      return node;
    }

    if (node.type === 'hardBreak') {
      offset += 1;
      return node;
    }

    const label = chipLabel(node);
    if (label !== null) {
      offset += label.length;
      return node;
    }

    let next = node;
    if (node.content && node.content.length > 0) {
      const content = node.content.map(walk);
      if (content.some((child, index) => child !== node.content?.[index])) {
        next = { ...node, content };
      }
    }
    if (isBlockBoundary(node)) offset += 1;
    return next;
  };

  const result = walk(doc);
  return changed ? result : null;
}
