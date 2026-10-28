import type { AgentKind } from '@cindy/model-providers';

/** Shared engine colors for model settings and the compact picker. */
export const MODEL_HARNESS_COLOR: Readonly<Record<AgentKind, string>> = {
  'claude-code': 'var(--engine-badge-cc)',
  codex: 'var(--engine-badge-codex)',
  pi: 'var(--engine-badge-pi)',
  // hermes M2b 接入中:先复用中性 cc 徽章色,独立 token 留给 step 4。
  hermes: 'var(--engine-badge-cc)',
};
