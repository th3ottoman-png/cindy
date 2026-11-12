import React, { useCallback, useEffect, useState } from 'react';
import {
  Server,
  Play,
  Square,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Globe,
  Cpu,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import type {
  ServiceView,
  StartResult,
} from '../../../../../main/local-services/serviceSupervisor';

function formatUptime(uptimeMs?: number): string {
  if (uptimeMs === undefined) return '';
  const s = Math.floor(uptimeMs / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function LocalServicesPanel() {
  const [services, setServices] = useState<ServiceView[]>([]);
  const [loading, setLoading] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [expandedLogs, setExpandedLogs] = useState<string | null>(null);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [showStartForm, setShowStartForm] = useState(false);
  const [formName, setFormName] = useState('');
  const [formCommand, setFormCommand] = useState('');
  const [formCwd, setFormCwd] = useState('');
  const [formPort, setFormPort] = useState('');

  const api = window.electronAPI?.maker?.localServices;

  const fetchServices = useCallback(async () => {
    if (!api) return;
    setLoading(true);
    try {
      const res = await api.list();
      if (res && Array.isArray(res.services)) setServices(res.services);
    } catch (err) {
      console.error('Failed to fetch local services:', err);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void fetchServices();
    const unsub = api?.onChanged?.(() => {
      void fetchServices();
    });
    return () => unsub?.();
  }, [fetchServices, api]);

  const handleStop = async (svc: ServiceView) => {
    if (!api) return;
    setActing(svc.id);
    try {
      const res =
        svc.source === 'supervised'
          ? await api.stop({ id: svc.id })
          : await api.terminate({ pid: svc.pid ?? 0, command: svc.command });
      if (res?.ok) toast.info(res.forced ? `Stopped ${svc.name} (forced)` : `Stopped ${svc.name}`);
      else toast.warning(res?.error || `Failed to stop ${svc.name}`);
      await fetchServices();
    } catch (err) {
      toast.error(`Error stopping service: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActing(null);
    }
  };

  const handleRestart = async (svc: ServiceView) => {
    if (!api || svc.source !== 'supervised') return;
    setActing(svc.id);
    try {
      const res: StartResult = await api.restart({ id: svc.id });
      if (res?.ok) toast.success(`Restarted ${svc.name}`);
      else toast.warning(res?.error || `Failed to restart ${svc.name}`);
      await fetchServices();
    } catch (err) {
      toast.error(`Error restarting service: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActing(null);
    }
  };

  const handleToggleLogs = async (svc: ServiceView) => {
    if (expandedLogs === svc.id) {
      setExpandedLogs(null);
      return;
    }
    if (!api || svc.source !== 'supervised') return;
    try {
      const res = await api.logs({ id: svc.id, limit: 50 });
      setLogLines(res?.lines ?? []);
      setExpandedLogs(svc.id);
    } catch (err) {
      toast.error(`Error loading logs: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleStart = async () => {
    if (!api) return;
    const port = formPort.trim() === '' ? undefined : Number(formPort.trim());
    if (formPort.trim() !== '' && !Number.isInteger(port)) {
      toast.warning('Port must be an integer.');
      return;
    }
    setActing('new');
    try {
      const res = await api.start({
        name: formName.trim(),
        command: formCommand.trim(),
        ...(formCwd.trim() ? { cwd: formCwd.trim() } : {}),
        ...(port !== undefined ? { port } : {}),
      });
      if (res?.ok) {
        toast.success(`Started ${formName.trim()}`);
        setFormName('');
        setFormCommand('');
        setFormCwd('');
        setFormPort('');
        setShowStartForm(false);
      } else {
        toast.warning(res?.error || 'Failed to start service');
      }
      await fetchServices();
    } catch (err) {
      toast.error(`Error starting service: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setActing(null);
    }
  };

  return (
    <div className="border-b border-border/40 bg-muted/10">
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <Server size={14} className="text-primary" />
          <span className="font-semibold text-xs tracking-wide uppercase text-foreground">
            Active Services
          </span>
          {services.filter((s) => s.running).length > 0 && (
            <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
              {services.filter((s) => s.running).length} running
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setShowStartForm((v) => !v)}
            aria-label="Start a new dev service"
            title="Start a new dev service"
            className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium bg-primary/10 text-primary hover:bg-primary/20 border border-primary/20 transition"
          >
            <Play size={10} />
            New
          </button>
          <button
            type="button"
            onClick={() => void fetchServices()}
            disabled={loading}
            aria-label="Refresh active services"
            className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted/50 transition"
          >
            <RotateCcw size={12} className={cn(loading && 'animate-spin')} />
          </button>
        </div>
      </div>

      {showStartForm && (
        <div className="mx-3 mb-2 p-2 rounded border border-border/40 bg-card/60 flex flex-col gap-1.5">
          <input
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            placeholder="Name (e.g. web)"
            aria-label="Service name"
            className="px-2 py-1 rounded text-xs bg-muted/40 border border-border/40 text-foreground placeholder:text-[var(--text-placeholder)]"
          />
          <input
            value={formCommand}
            onChange={(e) => setFormCommand(e.target.value)}
            placeholder="Command (e.g. npx vite --port 5173)"
            aria-label="Service command"
            className="px-2 py-1 rounded text-xs font-mono bg-muted/40 border border-border/40 text-foreground placeholder:text-[var(--text-placeholder)]"
          />
          <div className="flex gap-1.5">
            <input
              value={formCwd}
              onChange={(e) => setFormCwd(e.target.value)}
              placeholder="Working dir (optional)"
              aria-label="Working directory"
              className="flex-1 px-2 py-1 rounded text-xs font-mono bg-muted/40 border border-border/40 text-foreground placeholder:text-[var(--text-placeholder)]"
            />
            <input
              value={formPort}
              onChange={(e) => setFormPort(e.target.value)}
              placeholder="Port"
              aria-label="Expected port"
              inputMode="numeric"
              className="w-20 px-2 py-1 rounded text-xs font-mono bg-muted/40 border border-border/40 text-foreground placeholder:text-[var(--text-placeholder)]"
            />
          </div>
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => setShowStartForm(false)}
              className="px-2 py-0.5 rounded text-[11px] text-muted-foreground hover:text-foreground border border-border/40 transition"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={acting === 'new' || !formName.trim() || !formCommand.trim()}
              className="px-2 py-0.5 rounded text-[11px] font-medium bg-primary/15 text-primary hover:bg-primary/25 border border-primary/25 transition disabled:opacity-50"
            >
              Start
            </button>
          </div>
        </div>
      )}

      <div className="px-3 pb-2 space-y-1.5 max-h-64 overflow-y-auto">
        {services.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/70 py-1">
            No local dev servers detected. Servers started by agent bash commands appear here automatically.
          </p>
        ) : (
          services.map((svc) => {
            const busy = acting === svc.id;
            return (
              <div
                key={svc.id}
                className={cn(
                  'rounded-lg border p-2 flex flex-col gap-1.5',
                  svc.running
                    ? 'border-emerald-500/40 bg-emerald-500/5'
                    : 'border-border/50 bg-card/60',
                )}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {svc.source === 'supervised' ? (
                      <Cpu size={12} className="text-blue-400 shrink-0" />
                    ) : (
                      <Globe size={12} className="text-amber-400 shrink-0" />
                    )}
                    <span className="font-medium text-xs truncate" title={svc.command}>
                      {svc.name}
                    </span>
                    {svc.source === 'discovered' && (
                      <span
                        className="px-1 rounded text-[10px] bg-amber-500/15 text-amber-300 border border-amber-500/25 shrink-0"
                        title="Started outside the supervisor (e.g. by an agent bash command)"
                      >
                        external
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {svc.ports.map((p) => (
                      <span
                        key={p}
                        className="px-1.5 py-0.2 rounded text-[10px] font-mono bg-muted/60 border border-border/40 text-foreground"
                      >
                        :{p}
                      </span>
                    ))}
                    {svc.uptimeMs !== undefined && (
                      <span className="text-[10px] text-muted-foreground">up {formatUptime(svc.uptimeMs)}</span>
                    )}
                  </div>
                </div>
                {svc.pid !== undefined && (
                  <p className="text-[10px] font-mono text-muted-foreground/70 truncate" title={svc.command}>
                    pid {svc.pid} · {svc.command}
                  </p>
                )}
                <div className="flex items-center gap-1.5">
                  {svc.manageable && svc.running && (
                    <button
                      type="button"
                      onClick={() => void handleStop(svc)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-rose-500/10 text-rose-400 hover:bg-rose-500/20 border border-rose-500/20 transition disabled:opacity-50"
                    >
                      <Square size={10} />
                      {svc.source === 'supervised' ? 'Stop' : 'Terminate'}
                    </button>
                  )}
                  {svc.source === 'supervised' && (
                    <button
                      type="button"
                      onClick={() => void handleRestart(svc)}
                      disabled={busy}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-medium bg-blue-500/10 text-blue-400 hover:bg-blue-500/20 border border-blue-500/20 transition disabled:opacity-50"
                    >
                      <RotateCcw size={10} />
                      Restart
                    </button>
                  )}
                  {svc.source === 'supervised' && (
                    <button
                      type="button"
                      onClick={() => void handleToggleLogs(svc)}
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] text-muted-foreground hover:text-foreground hover:bg-muted/50 border border-border/40 transition"
                    >
                      {expandedLogs === svc.id ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                      Logs
                    </button>
                  )}
                </div>
                {expandedLogs === svc.id && (
                  <pre className="text-[10px] font-mono text-muted-foreground bg-muted/40 rounded p-1.5 max-h-32 overflow-y-auto whitespace-pre-wrap break-all">
                    {logLines.length > 0 ? logLines.join('\n') : '(no output yet)'}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
