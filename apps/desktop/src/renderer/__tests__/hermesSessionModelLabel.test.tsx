import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { HermesSessionModelLabel } from '../features/cc-agent/HermesSessionModelLabel';

describe('HermesSessionModelLabel', () => {
  it('shows the model for a Hermes session', () => {
    const html = renderToStaticMarkup(
      <HermesSessionModelLabel agentKind="hermes" model="deepseek-v4-pro" />,
    );
    expect(html).toContain('deepseek-v4-pro');
    expect(html).toContain('hermes-session-model');
  });

  it('renders nothing for other agents or an empty model', () => {
    expect(renderToStaticMarkup(<HermesSessionModelLabel agentKind="codex" model="gpt" />)).toBe('');
    expect(renderToStaticMarkup(<HermesSessionModelLabel agentKind="hermes" model="" />)).toBe('');
    expect(renderToStaticMarkup(<HermesSessionModelLabel agentKind="hermes" model={null} />)).toBe('');
  });
});
