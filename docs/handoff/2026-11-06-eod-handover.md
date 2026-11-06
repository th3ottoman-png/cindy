# Handover — 2026-11-06 EOD

## 1. Overview & Project Status

Cindy is a single-user private harness for local AI coding agents (Hermes, Claude Code, Codex, Pi).
As of 2026-11-06:
- **Phases 0 through 5**: Fully implemented and verified.
- **Debt Backlog**: All active items in `ROADMAP.md` §Debt are completely resolved and verified.
- **Visual Branding Assets**: Updated in commit `e6a11f3603` (`unit-tested`). Cybernetic avatar artwork generated into macOS `.icns`, Windows `.ico`, Dock icons, login/splash hero, header avatars, and preset icons.
- **Desktop Packaging & DMG**: Ad-hoc signed `.dmg` creation added to `apps/desktop/scripts/package-desktop.mjs` alongside `.zip`.
- **The 3 Un-parked Backlog Features**: All three requested backlog features have been implemented, tested, and pushed:
  1. **Item 1: Time-travel / Session Forking UI** (`unit-tested`, commit `11fa024714`):
     - Hermes agent advertises `capabilities.fork: { supported: true }`.
     - Assistant and User chat turns provide the Fork turn button.
     - Backend forks history at chosen message ID and prepares context rebuild markers for the child session.
     - Mounted `<GitBranch size={15} />` in `SessionContentHeader.tsx` opening `SessionBranchTreeDialog.tsx` to view lineage and switch across branches.
  2. **Item 2: Slash-Command Palette in Chat Composer** (`unit-tested`, commit `db7ef62416`):
     - Implemented `HermesAgent.listAgentCommands()` returning `/compact`.
     - Added `resolveHermesHome` hook and implemented `HermesAgent.listAgentSkills()` scanning global skills from `~/.hermes-cindy/skills` and repo skills from `<workingDir>/.hermes/skills`.
     - Integrated into `ChatInput` with `SlashCommandPalette.tsx` popover and `SlashCommandDecoration.ts` badge pills.
  3. **Item 3: Worktree Manager Dock, Artifacts Side-Drawer & Terminal Launchers** (`unit-tested`, commit `c04b5ca6d5`):
     - Registered `worktree-manager` plugin in Right Sidebar dock (`WorktreeManagerBody.tsx`) listing active Git worktrees with switch, reveal, terminal, and copy actions.
     - Registered `artifacts` plugin in Right Sidebar side-drawer (`ArtifactsTabBody.tsx`) inspecting files created in the conversation turns with preview, reveal, and copy.
     - Added quick header launcher buttons in `SessionContentHeader.tsx` for Terminal (`<Terminal size={15} />`), Worktrees (`<FolderGit2 size={15} />`), and Artifacts (`<Layers size={15} />`).
     - Added full localization across `en`, `ja`, `ko`, `zh-CN`, `zh-TW`, and synchronized `docs/design-rules/design-inventory.md`.

---

## 2. Recent Commits (git log -5)

- `c04b5ca6d5` — `Add Worktree Manager, Artifacts side-drawer, and header launchers` (Item 3)
- `db7ef62416` — `Support Hermes slash commands and skills in composer palette` (Item 2)
- `11fa024714` — `Support Hermes session forking and conversation branch tree navigation` (Item 1)
- `e6a11f3603` — `Update Cindy app icon, splash hero, and avatar visual assets` (Visual identity update)
- `3d30131aec` — `Resolve context window for custom endpoints outside models.dev`

---

## 3. Current State & What Can Be Done Next

1. **macOS Gatekeeper on Packaged DMG**:
   - Because Cindy is built and packaged locally without an Apple Developer ID certificate / notarization, macOS will flag ad-hoc built binaries (`apps/desktop/out/make/Cindy-<arch>.dmg` / `Cindy.app`) with the quarantine attribute when mounted or opened ("This Mac could not verify the app...").
   - To clear this locally:
     ```bash
     xattr -cr /Applications/Cindy.app
     # or on the mounted DMG volume:
     xattr -cr /Volumes/Cindy/Cindy.app
     ```
   - If the user wishes to configure a Developer ID certificate for code-signing, configure `CSC_LINK` / `CSC_KEY_PASSWORD` in the environment before packaging.
2. **Visual Identity Adjustments (Optional)**:
   - Visual assets from the cybernetic avatar were processed and replaced across the repository in commit `e6a11f3603`.
   - If the user provides additional artwork variations in the future:
     - Run `node apps/desktop/scripts/generate-mac-icns.mjs` to regenerate `apps/desktop/resources/icon.icns`.
     - Run `node apps/desktop/scripts/generate-win-ico.mjs` for Windows icon assets.
     - Assets are stored in `apps/desktop/resources/` and `apps/desktop/src/renderer/assets/`.
3. **Parked Items in ROADMAP.md**:
   - Remaining items parked in `ROADMAP.md` §Parked:
     - Automatic model cascade / cost-optimising router (currently intentionally parked because it conflicts with Phase 2.4 "no silent fallback").
     - Windows / Linux support (currently macOS-focused).

---

## 4. Key Verification Gates

Before every commit, always run under Node 22 (`export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`):
```bash
pnpm typecheck
pnpm test:runner
pnpm test:unit:related
pnpm check:test-hygiene
```
All four gates are confirmed green.
