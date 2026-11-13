/** @vitest-environment jsdom */
import { Editor } from '@tiptap/core';
import Document from '@tiptap/extension-document';
import Paragraph from '@tiptap/extension-paragraph';
import Text from '@tiptap/extension-text';
import { afterEach, describe, expect, it } from 'vitest';

import { detectTrigger } from '../ChatInput';

const editors: Editor[] = [];

function editorAtEnd(text: string): Editor {
  const editor = new Editor({
    extensions: [Document, Paragraph, Text],
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }],
    },
  });
  editor.commands.setTextSelection(editor.state.doc.content.size - 1);
  editors.push(editor);
  return editor;
}

afterEach(() => {
  while (editors.length > 0) editors.pop()?.destroy();
});

describe('detectTrigger @agent: ownership (ROADMAP 12.3, ADR 0011)', () => {
  it('hands ownership over at the colon: no file/agent panel for a teammate token', () => {
    expect(detectTrigger(editorAtEnd('ask @agent:expert:historian'))).toEqual({ kind: 'none' });
    expect(detectTrigger(editorAtEnd('@agent:imported:claude-user:historian.md'))).toEqual({ kind: 'none' });
    expect(detectTrigger(editorAtEnd('@agent:'))).toEqual({ kind: 'none' });
  });

  it('keeps 8.4 capability queries handed over too', () => {
    expect(detectTrigger(editorAtEnd('@skill:apple'))).toEqual({ kind: 'none' });
  });

  it('bare @ and pre-colon @agent still belong to the file/agent panel', () => {
    expect(detectTrigger(editorAtEnd('@historian'))).toMatchObject({ kind: 'at', query: 'historian' });
    expect(detectTrigger(editorAtEnd('@agent'))).toMatchObject({ kind: 'at', query: 'agent' });
  });

  it('an email is not a trigger', () => {
    expect(detectTrigger(editorAtEnd('mail me@agent:expert:x'))).toEqual({ kind: 'none' });
  });
});
