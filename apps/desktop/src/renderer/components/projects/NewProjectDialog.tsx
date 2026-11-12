/**
 * NewProjectDialog — Enhanced New Project & Workspace Setup Modal
 *
 * Implements a rich project creation dialog based on the workspace
 * setup pattern: name, multi-folder management, idea brief with suggestion
 * pills (saved to IDEA.md), agent/model presets, and scaffolding options.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import {
  Folder,
  Plus,
  X,
  RefreshCw,
  GitBranch,
  FileCode2,
  BookOpen,
  Sparkles,
  Bot,
  Layers,
  Terminal,
} from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { patchDraft as patchNewMakerDraft, switchVendor } from '@/state/newMakerDraft';
import { plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { NEW_MAKER_DRAFT_KEY } from '@/features/cc-agent/newMakerDraftKeys';
import type { MakerVendor } from '@/lib/ccAgent.types';

export interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultPath?: string;
  onProjectCreated?: (result: { projectKey: string; workingDir: string; name: string }) => void;
}

interface IdeaTemplate {
  label: string;
  emoji: string;
  template: string;
  preset: string;
}

const IDEA_PRESETS: readonly IdeaTemplate[] = [
  {
    label: 'Code Reviewer',
    emoji: '🔍',
    template: 'An automated static analysis and code review harness that audits pull requests, ASTs, and style invariants.',
    preset: 'expert',
  },
  {
    label: 'Full-Stack App',
    emoji: '⚡',
    template: 'A modern full-stack web application with responsive UI, authenticated REST/GraphQL API, and database persistence.',
    preset: 'app',
  },
  {
    label: 'Debug & Diagnostics',
    emoji: '🩺',
    template: 'A diagnostic and profiling tool for capturing stack traces, memory leaks, performance bottlenecks, and network traffic.',
    preset: 'cli',
  },
  {
    label: 'Backend Service',
    emoji: '🛡️',
    template: 'A high-throughput backend microservice with type-safe schema validation, rate-limiting, and health checks.',
    preset: 'app',
  },
  {
    label: 'Dev CLI Tool',
    emoji: '💻',
    template: 'A fast command-line developer utility for workflow automation, file batching, and system administration.',
    preset: 'cli',
  },
  {
    label: 'MCP Server',
    emoji: '🔌',
    template: 'A Model Context Protocol server exposing custom tools, resources, and live data streams to AI agents.',
    preset: 'mcp',
  },
  {
    label: 'Agent Harness',
    emoji: '🤖',
    template: 'A specialized autonomous agent system with domain tools, memory synthesis, and automated verification loops.',
    preset: 'expert',
  },
  {
    label: 'Test Automation',
    emoji: '🧪',
    template: 'An end-to-end integration and smoke testing suite with automated assertions and CI reporting.',
    preset: 'cli',
  },
];

export function NewProjectDialog({
  open,
  onOpenChange,
  defaultPath = '',
  onProjectCreated,
}: NewProjectDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [projectName, setProjectName] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [ideaText, setIdeaText] = useState('');
  const [vendor, setVendor] = useState<MakerVendor>('hermes');
  const [initGit, setInitGit] = useState(true);
  const [createIdeaFile, setCreateIdeaFile] = useState(true);
  const [createGitIgnore, setCreateGitIgnore] = useState(true);
  const [linkVault, setLinkVault] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [presetOffset, setPresetOffset] = useState(0);

  const userEditedName = useRef(false);

  useEffect(() => {
    if (open) {
      if (defaultPath) {
        setFolders([defaultPath]);
        const base = defaultPath.split(/[/\\]/).filter(Boolean).pop() || '';
        if (!userEditedName.current) setProjectName(base);
      } else {
        setFolders([]);
        if (!userEditedName.current) setProjectName('');
      }
      setIsSubmitting(false);
    }
  }, [open, defaultPath]);

  const handleNameChange = (val: string) => {
    userEditedName.current = val.trim().length > 0;
    setProjectName(val);
  };

  const handleAddFolder = async () => {
    try {
      const result = await window.electronAPI.showOpenDirectoryDialog();
      if (result.canceled || !result.path) return;
      const newPath = result.path;
      setFolders((prev) => {
        if (prev.includes(newPath)) return prev;
        const next = [...prev, newPath];
        if (!userEditedName.current && next.length === 1) {
          const base = newPath.split(/[/\\]/).filter(Boolean).pop() || '';
          setProjectName(base);
        }
        return next;
      });
    } catch (err) {
      toast.error('Failed to open directory dialog');
    }
  };

  const handleRemoveFolder = (targetPath: string) => {
    setFolders((prev) => prev.filter((p) => p !== targetPath));
  };

  const handleSelectTemplate = (tpl: IdeaTemplate) => {
    setIdeaText(tpl.template);
    if (!userEditedName.current && !projectName) {
      setProjectName(tpl.label);
    }
  };

  const handleShufflePresets = () => {
    setPresetOffset((prev) => (prev + 3) % IDEA_PRESETS.length);
  };

  const visiblePresets = [
    ...IDEA_PRESETS.slice(presetOffset, presetOffset + 6),
    ...IDEA_PRESETS.slice(0, Math.max(0, presetOffset + 6 - IDEA_PRESETS.length)),
  ].slice(0, 6);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (folders.length === 0) {
      toast.warning('Please select at least one folder for the project.');
      return;
    }

    const primaryFolder = folders[0];
    const finalName = projectName.trim() || primaryFolder.split(/[/\\]/).filter(Boolean).pop() || 'Untitled Project';

    setIsSubmitting(true);
    try {
      const result = await window.electronAPI.createProject({
        name: finalName,
        primaryPath: primaryFolder,
        additionalPaths: folders.slice(1),
        ideaText,
        agentKind: vendor,
        initGit,
        createIdeaFile,
        createGitIgnore,
        linkVault,
      });

      if (!result.ok) {
        toast.error(result.error || 'Failed to create project');
        setIsSubmitting(false);
        return;
      }

      // Update draft and prefill seed message if idea provided
      patchNewMakerDraft({ workingDir: result.workingDir });
      // A vendor written through patchDraft is undone by the stored default-tuple rebase (seen
      // live: Hermes chosen, Codex opened); switchVendor is the store's supported path.
      switchVendor(vendor);

      // Existing files are never overwritten (main process); say so instead of failing silently.
      const skipped = result.skippedFiles ?? [];
      if (skipped.length > 0) {
        toast.warning(`Kept existing files, not overwritten: ${skipped.join(', ')}`);
      }
      const ideaWritten = result.createdFiles.includes('IDEA.md');

      if (ideaText.trim()) {
        const seedPrompt = `Project **${result.name}** initialized.\n\n### Project Idea & Scope${ideaWritten ? ' (from IDEA.md)' : ''}\n${ideaText.trim()}\n\nLet's begin by reviewing the project scope and planning the initial implementation.`;
        saveDraft(NEW_MAKER_DRAFT_KEY, {
          text: plainTextToTiptapDoc(seedPrompt),
          attachments: [],
          focusAtEnd: true,
        });
      }

      toast.success(`Project "${result.name}" created`);
      onProjectCreated?.(result);
      onOpenChange(false);

      // Navigate to new task composer with this project active
      navigate('/cc-agent/new');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Error creating project');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[10000] bg-black/60 backdrop-blur-sm" />
        <Dialog.Content
          onPointerDownOutside={(e) => e.preventDefault()}
          className={cn(
            'fixed left-1/2 top-1/2 z-[10001] -translate-x-1/2 -translate-y-1/2',
            'w-[min(540px,calc(100vw-32px))] max-h-[90vh] overflow-y-auto',
            'rounded-xl border border-[var(--border-subtle)] bg-[var(--background-modal,#1c1e24)]',
            'p-6 shadow-2xl outline-none text-[var(--foreground)]',
          )}
        >
          <div className="flex items-start justify-between">
            <div>
              <Dialog.Title className="text-18 font-semibold tracking-tight text-[var(--confirm-title)]">
                {t('ccAgent.newProject.title', 'New project')}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-13 text-[var(--confirm-desc)] leading-normal">
                {t('ccAgent.newProject.subtitle', 'Name a workspace and add one or more folders.')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded-md p-1.5 text-[var(--sidebar-list-muted)] hover:text-[var(--foreground)] hover:bg-[var(--sidebar-item-hover)] transition-colors"
                aria-label="Close"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <form onSubmit={handleSubmit} className="mt-5 flex flex-col gap-4">
            {/* Project Name */}
            <div className="flex flex-col gap-1.5">
              <label className="text-12 font-medium text-[var(--foreground-muted)] uppercase tracking-wider">
                {t('ccAgent.newProject.nameLabel', 'Project name')}
              </label>
              <input
                type="text"
                value={projectName}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="e.g. Cindy-Hermes"
                className={cn(
                  'h-9 w-full rounded-md px-3 text-14',
                  'bg-[var(--input-background,#14161a)] border border-[var(--input-border,#2e323b)]',
                  'text-[var(--foreground)] placeholder:text-[var(--text-placeholder)]',
                  'focus:outline-none focus:border-[var(--focus-ring)] transition-colors',
                )}
              />
            </div>

            {/* Folders Section */}
            <div className="flex flex-col gap-2">
              <label className="text-12 font-medium text-[var(--foreground-muted)] uppercase tracking-wider">
                {t('ccAgent.newProject.foldersLabel', 'Folders')}
              </label>

              {folders.length > 0 ? (
                <div className="flex flex-col gap-1.5">
                  {folders.map((folderPath, idx) => (
                    <div
                      key={folderPath}
                      className={cn(
                        'flex items-center justify-between gap-2 px-3 py-2 rounded-md text-13',
                        'bg-[var(--input-background,#14161a)] border border-[var(--input-border,#2e323b)]',
                      )}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <Folder size={15} className="shrink-0 text-[var(--status-bar-accent)]" />
                        <span className="truncate font-mono text-12 text-[var(--foreground)]" title={folderPath}>
                          {folderPath}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {idx === 0 && (
                          <span className="px-1.5 py-0.5 text-10 font-semibold uppercase tracking-wider rounded bg-[var(--status-bar-accent)]/20 text-[var(--status-bar-accent)]">
                            Primary
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => handleRemoveFolder(folderPath)}
                          className="text-[var(--sidebar-list-muted)] hover:text-red-400 p-0.5 rounded transition-colors"
                          aria-label={`Remove folder ${folderPath}`}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-3 text-center border border-dashed border-[var(--border-subtle)] rounded-md text-12 text-[var(--foreground-muted)]">
                  No folders added yet. Select a folder to begin.
                </div>
              )}

              <div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={handleAddFolder}
                  className="flex items-center gap-1.5 text-12 border-[var(--input-border,#2e323b)] bg-[var(--input-background,#14161a)] text-[var(--foreground)] hover:bg-[var(--sidebar-item-hover)]"
                >
                  <Plus size={14} />
                  <span>{t('ccAgent.newProject.addFolder', '+ Add folder')}</span>
                </Button>
              </div>
            </div>

            {/* Agent / Preset selection */}
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="flex flex-col gap-1.5">
                <label className="text-11 font-medium text-[var(--foreground-muted)] uppercase tracking-wider flex items-center gap-1">
                  <Bot size={13} />
                  <span>{t('ccAgent.newProject.agentLabel', 'Agent')}</span>
                </label>
                <select
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value as MakerVendor)}
                  className={cn(
                    'h-8 rounded-md px-2 text-12 bg-[var(--input-background,#14161a)]',
                    'border border-[var(--input-border,#2e323b)] text-[var(--foreground)]',
                    'focus:outline-none focus:border-[var(--focus-ring)]',
                  )}
                >
                  <option value="hermes">Hermes (First-class)</option>
                  <option value="cc">Claude Code</option>
                  <option value="codex">Codex CLI</option>
                  <option value="pi">Pi</option>
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-11 font-medium text-[var(--foreground-muted)] uppercase tracking-wider flex items-center gap-1">
                  <Layers size={13} />
                  <span>{t('ccAgent.newProject.routeLabel', 'Model Route')}</span>
                </label>
                <select
                  defaultValue="code"
                  className={cn(
                    'h-8 rounded-md px-2 text-12 bg-[var(--input-background,#14161a)]',
                    'border border-[var(--input-border,#2e323b)] text-[var(--foreground)]',
                    'focus:outline-none focus:border-[var(--focus-ring)]',
                  )}
                >
                  <option value="code">⚡ code (Frontier Coding)</option>
                  <option value="fast">🦙 fast (Local LM Studio/Ollama)</option>
                  <option value="summary">📝 summary</option>
                  <option value="default">🌐 default route</option>
                </select>
              </div>
            </div>

            {/* Idea Section */}
            <div className="flex flex-col gap-1.5 pt-1">
              <div className="flex items-center justify-between">
                <label className="text-12 font-medium text-[var(--foreground-muted)] uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles size={13} className="text-amber-400" />
                  <span>{t('ccAgent.newProject.ideaLabel', 'Idea')}</span>
                </label>
                <span className="text-11 text-[var(--foreground-muted)]">
                  saved to IDEA.md
                </span>
              </div>
              <textarea
                value={ideaText}
                onChange={(e) => setIdeaText(e.target.value)}
                placeholder={t('ccAgent.newProject.ideaPlaceholder', "What's this project about? (saved to IDEA.md)")}
                rows={3}
                className={cn(
                  'w-full rounded-md p-3 text-13 resize-y min-h-[76px]',
                  'bg-[var(--input-background,#14161a)] border border-[var(--input-border,#2e323b)]',
                  'text-[var(--foreground)] placeholder:text-[var(--text-placeholder)]',
                  'focus:outline-none focus:border-[var(--focus-ring)] transition-colors',
                )}
              />

              {/* Inspiration suggestion pills */}
              <div className="flex flex-wrap items-center gap-1.5 pt-1">
                {visiblePresets.map((tpl) => (
                  <button
                    key={tpl.label}
                    type="button"
                    onClick={() => handleSelectTemplate(tpl)}
                    className={cn(
                      'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-12',
                      'bg-[var(--input-background,#14161a)] border border-[var(--border-subtle)]',
                      'text-[var(--foreground-muted)] hover:text-[var(--foreground)] hover:border-[var(--focus-ring)]',
                      'transition-colors',
                    )}
                  >
                    <span>{tpl.emoji}</span>
                    <span>{tpl.label}</span>
                  </button>
                ))}
                <button
                  type="button"
                  onClick={handleShufflePresets}
                  className="p-1 rounded-full text-[var(--foreground-muted)] hover:text-[var(--foreground)] transition-colors"
                  title="Shuffle suggestions"
                  aria-label="Shuffle suggestions"
                >
                  <RefreshCw size={13} />
                </button>
              </div>
            </div>

            {/* Scaffolding Checkboxes */}
            <div className="flex flex-col gap-2 pt-2 border-t border-[var(--border-subtle)] text-12 text-[var(--foreground-muted)]">
              <label className="inline-flex items-center gap-2 cursor-pointer select-none hover:text-[var(--foreground)]">
                <input
                  type="checkbox"
                  checked={initGit}
                  onChange={(e) => setInitGit(e.target.checked)}
                  className="rounded border-[var(--input-border)] text-[var(--status-bar-accent)] focus:ring-0"
                />
                <GitBranch size={13} />
                <span>Initialize Git repository (if not already initialized)</span>
              </label>

              <label className="inline-flex items-center gap-2 cursor-pointer select-none hover:text-[var(--foreground)]">
                <input
                  type="checkbox"
                  checked={createIdeaFile}
                  onChange={(e) => setCreateIdeaFile(e.target.checked)}
                  className="rounded border-[var(--input-border)] text-[var(--status-bar-accent)] focus:ring-0"
                />
                <FileCode2 size={13} />
                <span>Create IDEA.md with project brief</span>
              </label>

              <label className="inline-flex items-center gap-2 cursor-pointer select-none hover:text-[var(--foreground)]">
                <input
                  type="checkbox"
                  checked={createGitIgnore}
                  onChange={(e) => setCreateGitIgnore(e.target.checked)}
                  className="rounded border-[var(--input-border)] text-[var(--status-bar-accent)] focus:ring-0"
                />
                <Terminal size={13} />
                <span>Generate clean .gitignore</span>
              </label>

              <label className="inline-flex items-center gap-2 cursor-pointer select-none hover:text-[var(--foreground)]">
                <input
                  type="checkbox"
                  checked={linkVault}
                  onChange={(e) => setLinkVault(e.target.checked)}
                  className="rounded border-[var(--input-border)] text-[var(--status-bar-accent)] focus:ring-0"
                />
                <BookOpen size={13} />
                <span>Link to Notes Vault (creates Project note in Bishi-memory)</span>
              </label>
            </div>

            {/* Footer Buttons */}
            <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-[var(--border-subtle)]">
              <Dialog.Close asChild>
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  disabled={isSubmitting}
                >
                  {t('ccAgent.newProject.cancel', 'Cancel')}
                </Button>
              </Dialog.Close>

              <Button
                type="submit"
                variant="primary"
                size="md"
                disabled={folders.length === 0 || isSubmitting}
                className="bg-blue-600 hover:bg-blue-500 text-white font-medium px-4"
              >
                {isSubmitting ? 'Creating...' : t('ccAgent.newProject.create', 'Create')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
