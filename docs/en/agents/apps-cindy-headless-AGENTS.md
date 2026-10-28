> **English translation** of `apps/cindy-headless/AGENTS.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Cindy Headless

Before modifying, syncing, or packaging this module, first read UPDATE_AND_PACKAGE.zh-CN.md.
The default packaging entry point is pnpm --filter cindy-headless package:release, which produces the Linux x64 formal full package.
Generated bundles, releases, runtime binaries, credentials, and run records are not committed to the source repo; when distributing, keep the archive together with manifest/SHA256.
For day-to-day iteration you may first run pnpm --filter cindy-headless verify; commit/PR gates follow the root AGENTS.md and development-workflow.md, with no exemption from full gates involving dependency locks or test scheduling.
