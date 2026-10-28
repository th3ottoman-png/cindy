/**
 * Provider model-catalog listing for the Hermes home's active route.
 *
 * `GET {base_url}/models` is the one OpenAI-compatible endpoint every Hermes
 * provider speaks (DeepSeek, Nous inference, custom endpoints), so the model
 * picker can enumerate real ids instead of a hand-maintained list. The
 * Bearer key is supplied per request by the desktop (its own env) — the
 * daemon never stores it.
 */

export interface ProviderModelList {
  models: string[];
  error?: string;
}

/** Parse an OpenAI-compatible `/models` response body into sorted ids. */
export function parseProviderModelsResponse(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const ids = new Set<string>();
  for (const entry of data) {
    const id =
      typeof entry === 'string' ? entry : (entry as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id.trim()) ids.add(id.trim());
  }
  return [...ids].sort((a, b) => a.localeCompare(b));
}

export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
  timeoutMs = 8_000,
): Promise<ProviderModelList> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const response = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { models: [], error: `HTTP ${response.status}` };
    }
    const body: unknown = await response.json();
    return { models: parseProviderModelsResponse(body) };
  } catch (error) {
    return {
      models: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
