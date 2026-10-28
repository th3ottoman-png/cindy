> **English translation** of `apps/mobile/AGENTS.md` at commit `7c5bd270c9` (translated 2026-10-27). The Chinese original is authoritative; if the original changes upstream, re-translate.

# Mobile: Agent work entry point

This file applies to `apps/mobile/`; the data, authorization, cross-device protocol,
product, design, and delivery rules of [the root AGENTS](../../../AGENTS.md) still apply. For code, shared criteria, and test entry points see
[the repo map](../../dev-rules/repo-map.md#按用户行为定位).

- When developing, debugging, or verifying Mobile, you must first read [Mobile development](../../dev-rules/mobile-development.md).
- Before modifying this module's native configuration, native dependencies, config plugins, or native modules (`app.json`,
  `app.config.js`, `eas.json`, `package.json`, `plugins/`, `modules/`, etc. — inputs that
  enter the runtime fingerprint), you must first read the "cold-update boundary" (「冷更边界」) section of [Mobile development](../../dev-rules/mobile-development.md):
  **unless necessary, you must not commit changes that alter the fingerprint**; PRs that trigger a cold update (冷更) are on the same level as technology-framework
  changes and can merge only after the repo-designated gatekeeper (把关人) explicitly confirms the cold update — regardless of change size, and regardless of who
  submitted it; the submitter's identity is not an exception.
- Before adding or modifying text on the Mobile UI, you must first consult
  §3 "typography quick reference" (「文字规范速查」) of [the Mobile design guide](../../../apps/mobile/docs/mobile-design-guide.md): first pick the role, then copy the whole row verbatim — font size,
  line height, font weight, and font color; the four rules — five neutral text-color tiers, light text does not pair with bold weight, 11 font-size tiers, and line height is mandatory — are guarded by
  `typographyTokenDiscipline.test.ts`; whether the role was chosen correctly is caught by review.
