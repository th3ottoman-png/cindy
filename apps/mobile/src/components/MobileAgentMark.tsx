/**
 * MobileAgentMark —— Claude Code / Codex CLI / Pi / Hermes 的 Agent 身份 mark。
 * 不用于 Anthropic / OpenAI provider 或模型品牌；后两者由 MobileProviderMark 负责。
 */
import type { AgentKind } from '@cindy/model-providers/types';
import Svg, { G, Path } from 'react-native-svg';

import { iconSize, iconStroke } from '@/theme';

import {
  CLAUDE_AGENT_PATH,
  CODEX_AGENT_FLOWER_PATH,
  CODEX_AGENT_PROMPT_PATH,
} from './vendorIconPaths';

// Brand geometry in the shared 24-unit viewBox, matching Desktop PiMark / CodexMark.
const PI_STROKE = 2.4;
const CODEX_PROMPT_STROKE = 0.5;
const CODEX_SMALL_STROKE = 2;
const CODEX_LARGE_STROKE = 1.6;

export interface MobileAgentMarkProps {
  agentKind: AgentKind;
  color: string;
  size?: number;
}

/** 单色 CLI mark；颜色由宿主的主题 / 状态 token 决定。 */
export function MobileAgentMark({ agentKind, color, size = iconSize.sm }: MobileAgentMarkProps) {
  const codexStrokeWidth = size <= iconSize.sm ? CODEX_SMALL_STROKE : CODEX_LARGE_STROKE;
  return (
    <Svg accessible={false} height={size} viewBox="0 0 24 24" width={size}>
      {agentKind === 'hermes' ? (
        <G fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth={iconStroke.medium}>
          <Path d="M3.2 8.4c3.4.2 6 1.9 7.6 4.6" />
          <Path d="M20.8 8.4c-3.4.2-6 1.9-7.6 4.6" />
          <Path d="M12 6.2v12.2" />
          <Path d="M6.2 12.4c2.6.1 4.6 1.4 5.8 3.4" />
          <Path d="M17.8 12.4c-2.6.1-4.6 1.4-5.8 3.4" />
        </G>
      ) : agentKind === 'pi' ? (
        // Keep all three strokes in one native path. Separate horizontal/vertical
        // paths have degenerate bounds and can disappear in the iOS SVG renderer.
        <Path
          d="M3.6 6.6h16.8 M8.4 6.6v11.8 M15.6 6.6v9.6c0 1.5.9 2.2 2.4 2.2"
          fill="none"
          stroke={color}
          strokeWidth={PI_STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : agentKind === 'codex' ? (
        <G transform="translate(12 12) scale(1.1) translate(-12 -12)">
          <Path
            d={`${CODEX_AGENT_FLOWER_PATH}z`}
            fill="none"
            stroke={color}
            strokeLinejoin="round"
            strokeWidth={codexStrokeWidth}
          />
          <Path
            d={CODEX_AGENT_PROMPT_PATH}
            fill={color}
            stroke={color}
            strokeLinejoin="round"
            strokeWidth={CODEX_PROMPT_STROKE}
          />
        </G>
      ) : (
        <Path clipRule="evenodd" d={CLAUDE_AGENT_PATH} fill={color} fillRule="evenodd" />
      )}
    </Svg>
  );
}
