> **English translation** of `packages/model-providers/AGENTS.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Model catalog maintenance entry point

Before adding a model or modifying windows, prices, reasoning tiers, or defaults, first read
[`../../docs/dev-rules/model-catalog-maintenance.md`](../../dev-rules/model-catalog-maintenance.md).

This package's built-in catalog is the client-side fallback (兜底); it cannot replace the Cindy Server's published catalog. First verify the public catalog interface,
the currently effective registry revision, and the actual routing, then decide whether to modify Server data, client compatibility code,
or both. Pi's native catalog has an independent source; public API configuration is not derived from the subscription registry.
