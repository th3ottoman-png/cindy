import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { MobileAgentMark } from '@/components/MobileAgentMark';

vi.mock('react-native-svg', () => ({
  default: ({ children, accessible: _accessible, ...props }: any) => createElement('svg', props, children),
  G: ({ children, ...props }: any) => createElement('g', props, children),
  Path: (props: any) => createElement('path', props),
}));
vi.mock('@/theme', () => ({ iconSize: { sm: 16 }, iconStroke: { medium: 2.2 } }));

// Production component entry; ROADMAP 0.4 closes the untested Hermes glyph gap.
// Minimal failure input: agentKind=hermes must not emit Claude's single path.
// Unit tier; the focused three-file run took 648ms before this render conversion.
describe('MobileAgentMark', () => {
  it('renders the Hermes wing geometry instead of the Claude glyph fallback', () => {
    const html = renderToStaticMarkup(
      createElement(MobileAgentMark, { agentKind: 'hermes', color: '#123456' }),
    );

    expect(html).toContain('viewBox="0 0 24 24"');
    expect(html).toContain('stroke="#123456"');
    expect(html.match(/<path/g)).toHaveLength(5);
    for (const path of [
      'M3.2 8.4c3.4.2 6 1.9 7.6 4.6',
      'M20.8 8.4c-3.4.2-6 1.9-7.6 4.6',
      'M12 6.2v12.2',
      'M6.2 12.4c2.6.1 4.6 1.4 5.8 3.4',
      'M17.8 12.4c-2.6.1-4.6 1.4-5.8 3.4',
    ]) {
      expect(html).toContain(`d="${path}"`);
    }
  });
});
