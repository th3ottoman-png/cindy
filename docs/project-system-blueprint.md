# Cindy Project System & Enhanced "New Project" Screen Blueprint

**Status:** Proposed Architecture & Visual Specification  
**Goal:** Introduce a first-class Projects management system on the main Cindy page and sidebar, with a rich, detailed **"New Project" Dialog** based on the user's reference screenshot, elevated for power-user coding and research workflows.

---

## 1. Context & The Missing Affordances in Cindy

### The Current Gaps:
1. **Hidden "New Project" Entry:** In `ProjectsSection.tsx` / `MainListScopeHeader.tsx`, the `+` button in the header was previously removed. Users have no clear button on the sidebar to add a new project.
2. **Raw OS Picker Fallback:** Currently, attempting to create a project only triggers a raw macOS Finder directory picker (`window.electronAPI.showOpenDirectoryDialog()`), with no setup screen, name customization, or project scoping.
3. **Task Creation Visibility:** Adding new tasks/sessions to an existing project relies on hovering over a subtle `SquarePen` icon on the project row.

---

## 2. Visual & Functional Breakdown of the Enhanced "New Project" Screen

Inspired by the screenshot, elevated with Cindy's unique capabilities (local-first, multi-model, git-isolated, vault-connected):

```
┌────────────────────────────────────────────────────────────────────────┐
│  New project                                                        ✕  │
│  Configure a workspace, attach folders, and seed your project.        │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  PROJECT NAME                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ Cindy-Hermes                                                     │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                        │
│  FOLDERS                                                               │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ 📁 /Users/turko/=ai space=/=PROJECTS_MAIN=/Cindy   PRIMARY    ✕  │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  [ + Add folder ]   [ 📁 Choose existing ]   [ ➕ Create new folder ]   │
│                                                                        │
│  PROJECT PRESET & AGENT                                                │
│  ┌──────────────────────────┐  ┌─────────────────────────────────────┐ │
│  │ Type: 💻 Codebase / App ▾│  │ Agent: 🤖 Hermes (default)       ▾│ │
│  └──────────────────────────┘  └─────────────────────────────────────┘ │
│  ┌───────────────────────────────────────────────────────────────────┐ │
│  │ Model Route: ⚡ code (Frontier) | 🦙 local (LM Studio / Ollama) ▾ │ │
│  └───────────────────────────────────────────────────────────────────┘ │
│                                                                        │
│  PROJECT BRIEF & SCOPE                                                 │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │ What's this project about? (saved to IDEA.md)                     │  │
│  │                                                                  │  │
│  │                                                                  │  │
│  │                                                                 ✨│  │
│  └──────────────────────────────────────────────────────────────────┘  │
│  Suggestion chips:                                                     │
│  [ ⚡ CLI Tool ] [ 🌐 Full-stack App ] [ 🔌 MCP Server ]               │
│  [ 🔬 Deep Research ] [ 🧠 Obsidian Vault ] [ 🤖 Expert Agent ] [ 🔄 ] │
│                                                                        │
│  SCAFFOLDING OPTIONS                                                   │
│  ☑ Initialize Git repository (if not present)                         │
│  ☑ Create IDEA.md with project brief                                  │
│  ☑ Generate .gitignore & safety guardrails (AGENTS.md)                │
│  ☐ Link to Notes Vault (Bishi-memory/memory/Project — <Name>.md)      │
│                                                                        │
├────────────────────────────────────────────────────────────────────────┤
│                                            [ Cancel ]  [ Create Project ]
└────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Detailed Component Specifications

### A. Project Name & Alias
- Auto-populates from the selected folder basename (e.g. selecting `~/Projects/my-app` defaults name to `my-app`).
- Editable text field. Saves directly to Cindy's project alias table (`projectAliases.ts` in SQLite / localDb), so the sidebar displays the friendly name while preserving the physical path.

### B. Multi-Folder & Workspace Management
- **Primary Folder:** Marked with an indigo `PRIMARY` badge. This represents the root `workingDir` where Hermes / agent commands run by default.
- **Secondary Folders (`+ Add folder`):** Enables multi-root workspaces (like VS Code multi-root workspaces or monorepos with shared packages).
- **Directory Creation:** Includes a `Create new folder` option so the user doesn't have to switch to Finder or terminal to create a fresh directory before starting.

### C. Agent & Model Preset Selection
- **Agent Selector:** Pick the primary agent for the project (`Hermes`, `Claude Code`, `Codex`, `Pi`).
- **Model Route:** Assign a project-level default route (`code`, `fast`, or a specific local model from `providers.yaml`).
- **Expert Preset:** Attach an expert (e.g. `vault-researcher`, `general`, or custom expert from `~/.cindy-harness/experts/`).

### D. Project Scope (`IDEA.md` / `PROJECT.md`)
- A multiline markdown textarea capturing the project's purpose, architectural requirements, and constraints.
- **Inspirational Suggestion Pills (Click-to-fill):**
  - `⚡ CLI Tool`: *"A fast command-line utility built with TypeScript and Commander..."*
  - `🌐 Full-stack App`: *"A full-stack web application with React frontend and FastAPI/Node backend..."*
  - `🔌 MCP Server`: *"A custom Model Context Protocol server exposing tools for..."*
  - `🔬 Deep Research`: *"A comprehensive research and literature analysis project..."*
  - `🧠 Obsidian Vault`: *"A knowledge base structured with markdown notes and wikilinks..."*
  - `🤖 Expert Agent`: *"A specialized AI agent definition with custom tools and skills..."*
  - `🔄 Shuffle`: Rotates to new creative project templates.

### E. Scaffolding & Vault Integration
When `Create Project` is clicked:
1. **Directory Verification:** Ensures the directory exists (or creates it).
2. **Git Init:** If git is selected and no `.git` exists, runs `git init -b main`.
3. **`IDEA.md` Writing:** Writes the formatted idea text to `<workingDir>/IDEA.md`.
4. **Vault Project Note Linkage:** If selected, creates `<vault>/memory/Project — <Name>.md` (compatible with Cindy's Phase 7.4 Git-to-Vault sync).
5. **Immediate Launch:** Automatically opens a fresh session in Cindy scoped to this new project with the prompt pre-seeded:
   `"I've initialized project [Name] with the requirements in IDEA.md. Let's begin by reviewing the project scope and planning the initial architecture."`

---

## 4. UI Placements on Main Cindy Page & Sidebar

### 1. Sidebar Header (`MainListScopeHeader.tsx`)
- Add a prominent `+` button in the `group/sidebar-header` row (Tooltip: `"New Project"`).
- Keyboard shortcut: `Cmd+Shift+N` / `Ctrl+Shift+N`.

### 2. Projects Section Empty State (`ProjectsSection.tsx`)
When no projects exist or all are hidden:
- Render a welcoming card in the sidebar:
  ```
  📁 No projects yet
  Create a project to organize tasks, track git branches, and save ideas.
  [ + New Project ]
  ```

### 3. Project Node Task Affordance (`ProjectNode.tsx`)
- Keep the `SquarePen` icon on project hover, but also add a secondary quick-action:
  - Tooltip: `"New Task in <ProjectName>"`
  - Clicking navigates directly to `/cc-agent/new` with `workingDir` locked to that project.

### 4. Main Composer Workspace Picker (`FolderPickerPopover.tsx`)
- In `/cc-agent/new` (the main central page), add a prominent item at the top of the folder list:
  `[ ➕ New Project... ]` opening the `NewProjectDialog`.

---

## 5. Technical Implementation Steps

1. **`NewProjectDialog.tsx` Component:**
   - Create `apps/desktop/src/renderer/components/projects/NewProjectDialog.tsx` using Radix Dialog, matching Cindy's design system tokens (`--confirm-title`, `--confirm-desc`, etc.).
2. **Main Process IPC (`projectIpc.ts`):**
   - Add `maker:project:create` IPC handler: creates directory, writes `IDEA.md`, initializes git, and registers project alias in local SQLite DB.
3. **Sidebar Header Restoration:**
   - Update `MainListScopeHeader.tsx` to render the `+` button in the hover action group and wire `onCreateProject`.
4. **Empty State & Folder Picker Integration:**
   - Add empty state to `ProjectsSection.tsx` and entry point to `FolderPickerPopover.tsx`.
5. **Testing & Invariants:**
   - Add unit tests for `NewProjectDialog.test.tsx` and update `projectsSidebarSection.test.ts`.
