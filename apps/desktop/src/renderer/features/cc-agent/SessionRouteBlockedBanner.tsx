import { useCallback, useEffect, useRef, useState } from 'react';
import {
  assessRoute,
  resolveTaskRoute,
  type ProbeLike,
  type ProviderFileEntry,
  type RouteAlternative,
  type RouteHealth,
  type RouteResolution,
  type RoutingFile,
} from '@cindy/model-providers';

import { Button } from '@/components/ui/button';
import { ErrorNotice } from '@/components/ui/error-notice';
import { WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { makerChatStore } from '@/lib/makerChatStore';
import * as sessionService from '@/lib/sessionService';

export function formatRouteAlternativeLabel(alt: RouteAlternative): string {
  const suffix = alt.paid ? ' (paid)' : ' (local)';
  return `Use ${alt.routeName} (${alt.provider}/${alt.model})${suffix} instead`;
}

/**
 * Resolve and assess the active session's harness route (ROADMAP 2.4b).
 *
 * Returns `null` when `routing.yaml` has no routes/rules configured or when a
 * custom session model does not map to a configured `routing.yaml` route.
 * Never auto-substitutes an alternative route.
 */
export function assessSessionRouteHealth(params: {
  sessionModel?: string | null;
  agentKind?: string | null;
  routing: RoutingFile;
  providers: ProviderFileEntry[];
  probes: ProbeLike[];
}): RouteHealth | null {
  const { sessionModel, agentKind, routing, providers, probes } = params;
  if (!routing || !routing.routes || Object.keys(routing.routes).length === 0) {
    return null;
  }

  const trimmedModel = sessionModel?.trim();
  if (trimmedModel && trimmedModel !== 'hermes-default') {
    const matchedEntry = Object.entries(routing.routes).find(
      ([routeName, target]) => routeName === trimmedModel || target.model === trimmedModel,
    );
    if (!matchedEntry) {
      return null;
    }
    const [routeName, target] = matchedEntry;
    const resolution: RouteResolution = {
      ok: true,
      taskClass: 'chat.session',
      routeName,
      target,
    };
    return assessRoute(resolution, routing, providers, probes);
  }

  if (agentKind === 'hermes') {
    return null;
  }

  if (!('chat.default' in (routing.rules ?? {}))) {
    return null;
  }
  const resolution = resolveTaskRoute(routing, 'chat.default');
  return assessRoute(resolution, routing, providers, probes);
}

/**
 * Pure presentation component for a blocked session route with one-click
 * "Use X instead" buttons (ROADMAP 2.4b).
 *
 * Local alternatives appear before paid ones (`assessRoute` order), and paid
 * alternatives are explicitly labelled `(paid)`. Nothing is ever auto-selected.
 */
export function SessionRouteBlockedBannerView({
  health,
  switchingRoute,
  onSelectAlternative,
  onDismiss,
  style,
  className,
}: {
  health: RouteHealth | null;
  switchingRoute?: string | null;
  onSelectAlternative: (alt: RouteAlternative) => void;
  onDismiss?: () => void;
  style?: React.CSSProperties;
  className?: string;
}) {
  if (!health || health.ok) return null;

  return (
    <div
      data-testid="session-route-blocked-banner"
      className={className ?? 'mx-1 shrink-0'}
      style={style ?? WINDOW_NO_DRAG_STYLE}
    >
      <ErrorNotice
        message={health.message}
        description="Automatic fallback is disabled (no silent fallback to another or paid provider)."
        onDismiss={onDismiss}
        actions={
          health.alternatives.length > 0 ? (
            <div
              data-testid="session-route-alternatives"
              className="flex flex-wrap items-center gap-1.5"
            >
              {health.alternatives.map((alt) => (
                <Button
                  key={alt.routeName}
                  type="button"
                  size="sm"
                  compact
                  variant="secondary"
                  disabled={switchingRoute != null}
                  data-testid={`use-route-alternative-${alt.routeName}`}
                  data-route-paid={alt.paid ? 'true' : 'false'}
                  onClick={() => onSelectAlternative(alt)}
                >
                  {formatRouteAlternativeLabel(alt)}
                </Button>
              ))}
            </div>
          ) : (
            <span
              data-testid="session-route-no-alternatives"
              className="text-12 text-[var(--text-tertiary)]"
            >
              No healthy alternative routes available in routing.yaml.
            </span>
          )
        }
      />
    </div>
  );
}

/**
 * Signature of the chat-store fields that can change a session's route health
 * (ROADMAP 2.4b). Streaming text deltas leave it unchanged, so a store
 * notification on every token does not re-probe the local endpoints. A turn
 * starting or ending, an error being set or cleared, and a retry all change it.
 */
export function routeHealthTriggerSignature(snapshot: {
  error?: string | null;
  agentStatus?: { isRunning?: boolean } | null;
}): string {
  return `${snapshot.error ?? ''}|${snapshot.agentStatus?.isRunning === true ? 'running' : 'idle'}`;
}

export function SessionRouteBlockedBanner({
  sessionId,
  agentKind,
  sessionModel,
  onModelChange,
  style,
  className,
}: {
  sessionId: string;
  agentKind: string;
  sessionModel?: string | null;
  onModelChange?: (model: string) => void;
  style?: React.CSSProperties;
  className?: string;
}) {
  const [health, setHealth] = useState<RouteHealth | null>(null);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [switchingRoute, setSwitchingRoute] = useState<string | null>(null);
  const [optimisticModel, setOptimisticModel] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const evaluationSeq = useRef(0);

  useEffect(() => {
    setOptimisticModel(null);
  }, [sessionModel]);

  const effectiveSessionModel = optimisticModel ?? sessionModel;

  const evaluate = useCallback(async (targetModel?: string | null) => {
    const seq = ++evaluationSeq.current;
    const clear = () => {
      if (seq === evaluationSeq.current) setHealth(null);
    };
    if (agentKind !== 'hermes') {
      clear();
      return;
    }
    const api = window.electronAPI?.maker?.providers;
    if (!api?.list || !api?.discover || !api?.getRouting) {
      clear();
      return;
    }
    try {
      const [providersRes, routingRes, probes] = await Promise.all([
        api.list(),
        api.getRouting(),
        api.discover(),
      ]);
      const next = assessSessionRouteHealth({
        sessionModel: targetModel !== undefined ? targetModel : effectiveSessionModel,
        agentKind,
        routing: routingRes,
        providers: providersRes.providers ?? [],
        probes: probes ?? [],
      });
      if (seq !== evaluationSeq.current) return;
      setHealth(next);
    } catch {
      clear();
    }
  }, [agentKind, effectiveSessionModel]);

  const requestEvaluation = useCallback(() => setRevision((n) => n + 1), []);

  // A provider can die after this component mounted. Without these, the
  // no-silent-fallback notice stayed invisible at the exact moment the fallback
  // was refused (2.4b-live re-run 2026-11-04). Re-probe when a turn starts or
  // ends, when providers.yaml/routing.yaml change, and on refocus so a recovered
  // endpoint clears the banner without a renderer reload.
  useEffect(() => {
    if (!sessionId) return undefined;
    let last = routeHealthTriggerSignature(makerChatStore.getSnapshot(sessionId));
    return makerChatStore.subscribe(sessionId, () => {
      const next = routeHealthTriggerSignature(makerChatStore.getSnapshot(sessionId));
      if (next === last) return;
      last = next;
      requestEvaluation();
    });
  }, [requestEvaluation, sessionId]);

  useEffect(() => {
    const onProvidersChanged = window.electronAPI?.maker?.onProvidersChanged;
    if (!onProvidersChanged) return undefined;
    return onProvidersChanged(requestEvaluation);
  }, [requestEvaluation]);

  useEffect(() => {
    const onFocus = () => requestEvaluation();
    const onVisible = () => {
      if (document.visibilityState === 'visible') requestEvaluation();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [requestEvaluation]);

  useEffect(() => {
    void evaluate();
  }, [evaluate, revision]);

  const handleSelectAlternative = useCallback(
    async (alt: RouteAlternative) => {
      setSwitchingRoute(alt.routeName);
      try {
        await window.electronAPI?.maker?.setModel?.(sessionId, alt.model, alt.provider);
        await sessionService.update(sessionId, {
          model: alt.model,
          providerId: alt.provider,
        });
        setOptimisticModel(alt.model);
        onModelChange?.(alt.model);
        await evaluate(alt.model);
      } finally {
        setSwitchingRoute(null);
      }
    },
    [evaluate, onModelChange, sessionId],
  );

  if (agentKind !== 'hermes' || !health || health.ok) return null;
  const currentKey = `${sessionId}:${effectiveSessionModel ?? ''}:${health.reason}:${health.message}`;
  if (dismissedKey === currentKey) return null;

  return (
    <SessionRouteBlockedBannerView
      health={health}
      switchingRoute={switchingRoute}
      onSelectAlternative={(alt) => void handleSelectAlternative(alt)}
      onDismiss={() => setDismissedKey(currentKey)}
      style={style}
      className={className}
    />
  );
}
