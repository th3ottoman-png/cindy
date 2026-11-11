# Handover — Cindy Phase 11 & Project System (2026-11-11)

> **Superseded.** Written before 11.1 through 11.4 shipped. The live handover is
> `2026-11-11-phase11-eod-handover.md`; its "What is Next: 11.1" section is out of date.
> Kept for the 11.12 project-system record only.

## Executive Summary

This session accomplished two major milestones:
1. **Curated Skills Audit & Phase 11 Blueprint:** Audited 55 skills from `davidondrej/skills`. Authored complete blueprint (`phase-11-blueprint.md`) translating Category A & B skills plus `effective-agent-skills` into native, first-class desktop harness features for Cindy (Phases 11.1–11.11). Owner decisions incorporated:
   - 11.1: Dual activation (autonomous `activate_skill` MCP tool + deterministic `@skill:<name>` in composer).
   - 11.4: Multi-Model Council Review with interactive model selector (up to 3 models, local/API mix, saved in `routing.yaml`).
2. **First-Class Project Creation & Sidebar Workspace Section (Phase 11.12 - `live-proven`):**
   - **Backend IPC (`apps/desktop/src/main/maker-ipc/projectCreate.ts`):** `maker:project:create` initializes folder directories, runs `git init -b main`, writes `IDEA.md`, creates `.gitignore`, registers project alias in local SQLite DB (`localDb`), and creates a matching project note in the Notes Vault (`memory/Project — <Name>.md`).
   - **Enhanced Modal (`NewProjectDialog.tsx`):** Provides workspace name, multi-folder manager with `PRIMARY` badge, idea/scope prompt with 8 professional developer presets (Code Reviewer, Full-Stack App, Debug & Diagnostics, Backend Service, Dev CLI Tool, MCP Server, Agent Harness, Test Automation), agent/model selection, and immediate task handoff into `/cc-agent/new`.
   - **Sidebar PROJECTS Section (`ProjectsSection.tsx`):** Added a dedicated, collapsible "PROJECTS" section header with dynamic workspace folder count badge (`Projects (4)`), always-visible `+` button triggering `NewProjectDialog`, and `localStorage` persistence (`'cindy:sidebar:projects-collapsed'`).

---

## State of the Repository

- **Git Branch:** `main` (clean, synced with `origin/main` through commit `b0b45f561`).
- **Dev App Status:** Running on port 9222.
- **Pre-commit Gates Status (Node 22):**
  - `pnpm typecheck` — 0 errors across 37 workspace packages.
  - `pnpm test:runner` — 608 passed, 0 failed, 2 skipped.
  - `pnpm test:unit:related` — 100% green.
  - `pnpm check:test-hygiene` — 361 files within baseline, pass.

---

## Key Files Touched & Reference Locations

- `apps/desktop/src/renderer/features/cc-agent/sidebar/sections/ProjectsSection.tsx`: Collapsible "PROJECTS" section with count badge and always-visible `+` button.
- `apps/desktop/src/renderer/components/projects/NewProjectDialog.tsx`: New project creation modal with professional developer suggestion presets.
- `apps/desktop/src/main/maker-ipc/projectCreate.ts`: Project creation service & scaffolding logic.
- `apps/desktop/src/renderer/__tests__/projectsSidebarSection.test.ts`: Header invariant tests.
- `apps/desktop/src/renderer/components/projects/__tests__/NewProjectDialog.test.tsx`: Dialog unit tests.
- `docs/phase-11-blueprint.md`: Detailed architectural blueprint for tasks 11.1 through 11.11.
- `docs/project-system-blueprint.md`: Blueprint for the project workspace system.

---

## What is Next: Phase 11.1

The top open row in `ROADMAP.md` is **11.1: 3-Tier Progressive Skill Loading Engine (`effective-agent-skills`)**.

### Goal
Replace eager loading of all `SKILL.md` files (which wastes context tokens on every turn) with a 3-tier progressive disclosure engine:
1. **Tier 1 (Discovery):** Only names and descriptions (~50 tokens per skill) are compiled into system context or session manifest.
2. **Tier 2 (Dual Activation):**
   - **Model Self-Discovery:** Autonomous tool `activate_skill(skill_name)` on `cindy_skills` MCP server loads full `SKILL.md` into turn context on demand.
   - **User Deterministic Pinning:** Composer token `@skill:<name>` or slash command pins the skill directly into turn preamble.
3. **Tier 3 (Execution):** Scripts and reference files executed on demand without flooding context.
