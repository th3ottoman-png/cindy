import React, { useCallback, useEffect, useState } from 'react';
import { ClipboardCopy, Loader2, ScrollText, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

import {
  compareSessionManifests,
  groupSessionManifest,
  parseSessionManifest,
  reproduceSessionManifest,
  serializeSessionManifest,
  sessionManifestKindSummary,
  type SessionManifest,
} from '@cindy/maker-core/session-manifest';

import { applySessionManifestToDraft } from './sessionManifestApply';
import { collectSessionManifest } from './sessionManifestFacts';
import { takePendingManifestPins } from './sessionManifestPins';

/**
 * ROADMAP 8.2 Session manifest strip. Shows everything that affects what the
 * agent does, with the file behind every chip. AGENTS.md section 6.4 calls this
 * "no hidden state". Copy as YAML is a strict subset that round-trips through
 * the pure module, so a session can be reproduced from plain files.
 */
export interface SessionManifestStripProps {
  sessionId: string;
  agentKind: string;
  model: string | null;
  providerId: string | null;
  permissionMode: string | null;
}

const EMPTY_MANIFEST: SessionManifest = {
  version: 1,
  session: { id: '', agentKind: '', model: '', providerId: null, permissionMode: 'default' },
  capabilities: [],
};

export function SessionManifestStrip({
  sessionId,
  agentKind,
  model,
  providerId,
  permissionMode,
}: SessionManifestStripProps) {
  const navigate = useNavigate();
  const [manifest, setManifest] = useState<SessionManifest>(EMPTY_MANIFEST);
  const [loading, setLoading] = useState(true);
  const [selectedKind, setSelectedKind] = useState<string | null>(null);
  const [loadOpen, setLoadOpen] = useState(false);
  const [yamlText, setYamlText] = useState('');
  const [result, setResult] = useState('');
  const [copied, setCopied] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    void collectSessionManifest({ id: sessionId, agentKind, model, providerId, permissionMode })
      .then((next) => {
        if (!alive) return;
        setManifest(next);
        setYamlText(serializeSessionManifest(next));
        setLoading(false);
      })
      .catch(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [sessionId, agentKind, model, providerId, permissionMode, reloadToken]);

  // A manifest reproduced from another session pins its notes onto this one.
  useEffect(() => {
    const notes = takePendingManifestPins(sessionId);
    if (!notes?.length) return;
    let alive = true;
    void (async () => {
      for (const note of notes) {
        try {
          await window.electronAPI?.maker?.vault?.pinNote(sessionId, note);
        } catch {
          /* A missing note must not break the strip. */
        }
      }
      if (alive) setReloadToken((token) => token + 1);
    })();
    return () => {
      alive = false;
    };
  }, [sessionId]);

  useEffect(() => {
    const maker = window.electronAPI?.maker;
    if (!maker) return undefined;
    const offExperts = maker.experts?.onSessionEvent?.(() => setReloadToken((token) => token + 1));
    const offPins = maker.vault?.onPinnedChanged?.((payload) => {
      if (payload?.sessionId === sessionId) setReloadToken((token) => token + 1);
    });
    return () => {
      offExperts?.();
      offPins?.();
    };
  }, [sessionId]);

  const groups = React.useMemo(() => groupSessionManifest(manifest), [manifest]);
  const summary = React.useMemo(() => sessionManifestKindSummary(manifest), [manifest]);
  const selected = groups.find((group) => group.kind === selectedKind);

  const handleCopy = useCallback(async () => {
    const yaml = serializeSessionManifest(manifest);
    setYamlText(yaml);
    setResult('');
    try {
      await navigator.clipboard?.writeText(yaml);
      setCopied(true);
    } catch {
      setCopied(false);
      setResult('Clipboard unavailable. The YAML is in the Load YAML box below.');
    }
  }, [manifest]);

  const parseCurrent = useCallback((): SessionManifest | null => {
    const parsed = parseSessionManifest(yamlText);
    if (!parsed.ok) {
      setResult(`Invalid manifest YAML: ${parsed.error}`);
      return null;
    }
    return parsed.manifest;
  }, [yamlText]);

  const handleCompare = useCallback(() => {
    const parsed = parseCurrent();
    if (!parsed) return;
    const fresh = reproduceSessionManifest(parsed, `fresh:${sessionId}`);
    const comparison = compareSessionManifests(manifest, fresh);
    setResult(
      comparison.same
        ? `Same capability set: ${manifest.capabilities.length} capabilities, fingerprint ${comparison.fingerprintA}. Fresh session id ${fresh.session.id}.`
        : `Different capability set. Added: ${comparison.added.join(', ') || 'none'}. Removed: ${comparison.removed.join(', ') || 'none'}.`,
    );
  }, [manifest, parseCurrent, sessionId]);

  const handleReproduce = useCallback(() => {
    const parsed = parseCurrent();
    if (!parsed) return;
    const recipe = applySessionManifestToDraft(parsed, sessionId);
    setResult(
      `Fresh task recipe: expert ${recipe.expertSlug ?? 'none'}, model ${recipe.model || 'none'}, access ${recipe.permissionMode}, ${recipe.pinnedNotes.length} pinned notes queued, ${recipe.capabilityIds.length} capabilities.`,
    );
  }, [parseCurrent, sessionId]);

  return (
    <div
      data-testid="session-manifest-strip"
      data-session-id={sessionId}
      className="shrink-0 border-b border-[var(--border-subtle,#333)] bg-[var(--background-secondary,#1e1e24)] text-xs"
    >
      <div className="flex flex-wrap items-center gap-1.5 px-3 py-1.5">
        <ScrollText size={13} className="shrink-0 text-[var(--text-secondary,#888)]" />
        <span className="mr-1 shrink-0 font-medium text-[var(--text-primary,#fff)]">
          Session manifest
        </span>
        {loading && (
          <Loader2
            size={12}
            className="shrink-0 animate-spin text-[var(--text-secondary,#888)]"
            data-testid="manifest-loading"
          />
        )}
        {summary.map(({ kind, count }) => (
          <button
            key={kind}
            type="button"
            data-testid="manifest-kind-chip"
            data-kind={kind}
            data-count={count}
            onClick={() => setSelectedKind(selectedKind === kind ? null : kind)}
            className={`shrink-0 rounded border px-1.5 py-0.5 transition-colors ${
              selectedKind === kind
                ? 'border-[var(--border-strong,#555)] bg-[var(--surface-active,#2c2d36)] text-[var(--text-primary,#fff)]'
                : 'border-[var(--border-subtle,#333)] text-[var(--text-secondary,#aaa)] hover:text-[var(--text-primary,#fff)]'
            }`}
          >
            {kind} <span className="opacity-70">{count}</span>
          </button>
        ))}
        <span
          data-testid="manifest-count"
          className="shrink-0 text-[var(--text-placeholder)]"
        >
          {manifest.capabilities.length} capabilities
        </span>
        <button
          type="button"
          data-testid="manifest-copy-yaml"
          onClick={() => void handleCopy()}
          className="ml-auto inline-flex shrink-0 items-center gap-1 rounded border border-[var(--border-subtle,#333)] px-2 py-0.5 text-[var(--text-secondary,#aaa)] hover:text-[var(--text-primary,#fff)]"
        >
          <ClipboardCopy size={12} />
          {copied ? 'Copied' : 'Copy as YAML'}
        </button>
        <button
          type="button"
          data-testid="manifest-toggle-load"
          onClick={() => {
            setLoadOpen((open) => !open);
            setResult('');
          }}
          className="shrink-0 rounded border border-[var(--border-subtle,#333)] px-2 py-0.5 text-[var(--text-secondary,#aaa)] hover:text-[var(--text-primary,#fff)]"
        >
          {loadOpen ? 'Hide YAML' : 'Load YAML'}
        </button>
      </div>

      {selectedKind && (
        <div
          data-testid="manifest-provenance"
          data-kind={selectedKind}
          className="border-t border-[var(--border-subtle,#2a2a30)] bg-[var(--background-primary,#141418)] px-3 py-2"
        >
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-medium text-[var(--text-primary,#fff)]">Why is this on?</span>
            <span className="text-[var(--text-secondary,#999)]">{selectedKind}</span>
            <button
              type="button"
              aria-label="Close provenance"
              onClick={() => setSelectedKind(null)}
              className="ml-auto rounded p-0.5 text-[var(--text-secondary,#888)] hover:text-[var(--text-primary,#fff)]"
            >
              <X size={12} />
            </button>
          </div>
          <div className="space-y-1">
            {(selected?.items ?? []).length === 0 && (
              <div className="px-2 py-1 text-[var(--text-placeholder)]">
                Nothing of this kind is active in this session.
              </div>
            )}
            {(selected?.items ?? []).map((row) => (
              <div
                key={row.id}
                data-testid="manifest-capability"
                data-id={row.id}
                data-source={row.file}
                data-line={row.line ?? ''}
                className="rounded px-2 py-1.5 text-[var(--text-secondary,#bbb)]"
              >
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-medium text-[var(--text-primary,#fff)]">{row.label}</span>
                  <code className="text-[11px] text-[var(--text-secondary,#999)]">
                    {row.file}
                    {row.line ? `:${row.line}` : ''}
                  </code>
                  {row.locator && (
                    <span className="text-[11px] text-[var(--text-placeholder)]">{row.locator}</span>
                  )}
                </div>
                <div className="mt-0.5 text-[11px]">
                  {row.reason} · {row.trust} · {row.declaredInterface}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {loadOpen && (
        <div
          data-testid="manifest-load-panel"
          className="border-t border-[var(--border-subtle,#2a2a30)] bg-[var(--background-primary,#141418)] px-3 py-2"
        >
          <textarea
            data-testid="manifest-yaml"
            aria-label="Session manifest YAML"
            value={yamlText}
            onChange={(event) => setYamlText(event.target.value)}
            spellCheck={false}
            className="h-28 w-full resize-y rounded border border-[var(--border-subtle,#333)] bg-[var(--background-secondary,#1e1e24)] p-2 font-mono text-[11px] text-[var(--text-primary,#fff)] outline-none"
          />
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="manifest-compare"
              onClick={handleCompare}
              className="rounded border border-[var(--border-subtle,#333)] px-2 py-0.5 text-[var(--text-secondary,#aaa)] hover:text-[var(--text-primary,#fff)]"
            >
              Compare
            </button>
            <button
              type="button"
              data-testid="manifest-reproduce"
              onClick={handleReproduce}
              className="rounded border border-[var(--border-subtle,#333)] px-2 py-0.5 text-[var(--text-secondary,#aaa)] hover:text-[var(--text-primary,#fff)]"
            >
              New task from manifest
            </button>
            <button
              type="button"
              data-testid="manifest-open-draft"
              onClick={() => navigate('/cc-agent/new')}
              className="rounded border border-[var(--border-subtle,#333)] px-2 py-0.5 text-[var(--text-secondary,#aaa)] hover:text-[var(--text-primary,#fff)]"
            >
              Open new task
            </button>
            {result && (
              <span data-testid="manifest-result" className="text-[var(--text-secondary,#aaa)]">
                {result}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
