/**
 * Provider API-key env plumbing for the Hermes harness.
 *
 * Hermes reads provider credentials from env (`DEEPSEEK_API_KEY`,
 * `OPENROUTER_API_KEY`, …) or its own home auth store. Cindy's hermes-mgr
 * daemon runs with a deliberately minimal env (no secrets), and provider keys
 * are delivered per-session via `query/start` env instead — so both the start
 * path and model-catalog listing need one shared notion of "which env names
 * count as provider keys".
 *
 * Naming convention: `<PROVIDER upper-cased, non-alphanumerics → '_'>_API_KEY`
 * (deepseek → DEEPSEEK_API_KEY, z.ai → Z_AI_API_KEY). The known list covers the
 * providers Hermes's own fallback docs call out; unknown providers still work
 * through the same derivation.
 */

const KNOWN_PROVIDER_KEY_ENV = [
  'DEEPSEEK_API_KEY',
  'OPENROUTER_API_KEY',
  'ZAI_API_KEY',
  'Z_AI_API_KEY',
  'KIMI_API_KEY',
  'KIMI_CN_API_KEY',
  'MINIMAX_API_KEY',
  'MINIMAX_CN_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

export function hermesProviderApiKeyEnvName(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`;
}

/**
 * Copy the provider-key env vars that are present in this process' env
 * (optionally prioritizing one provider's derived name first). Returns only
 * non-empty values; never throws.
 */
export function collectHermesProviderEnv(provider?: string): Record<string, string> {
  const names = new Set<string>(KNOWN_PROVIDER_KEY_ENV);
  if (provider) names.add(hermesProviderApiKeyEnvName(provider));
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim()) out[name] = value;
  }
  return out;
}
