# ADR 0002 — Keep i18n and brand-terminology checks as advisory, not gates

- **Status:** Accepted
- **Date:** 2026-10-29
- **Decider:** roadmap 0.10 (resolves the ROADMAP §Debt row "i18n parity check vs English-only UI")

## Context

The runtime is locked to English (`b9e7ea7f3c`). Upstream ships `pnpm check:i18n`,
`check:i18n-glossary` and `check:brand-terminology`, and upstream CI runs the first two
(`.github/workflows/ci.yml`). The Debt row asked us to either remove the i18n gate or record a
decision to keep it.

## Decision

Keep the scripts and the CI workflow file untouched, and keep them **advisory**:

- They are not part of the default gate set in `AGENTS.md` §2 (`typecheck`, `test:runner`,
  `test:unit:related`, `check:test-hygiene`), so a failure never blocks a commit.
- No translations are added for new strings (English-only by decision).
- Nothing is deleted: ADR 0001 forbids deleting upstream files, and `.github/` is read by
  `hardcoded-color-audit.test.mjs`.

## Consequences

- Zero maintenance cost for the owner: the checks can be run (`pnpm check:i18n`) when curious.
- If a future change makes one of them fail the default gate, that is a regression against this ADR.
- Revisit only if non-English UI is ever reintroduced.
