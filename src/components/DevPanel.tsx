/**
 * src/components/DevPanel.tsx
 *
 * Developer Mode Observability Panel — §2.2 of the v4 spec.
 * Accessible in dev mode (settings toggle). Shows live traces, performance
 * metrics per pillar, token usage, event bus history, and error log.
 *
 * Toggle: developer mode in System Settings → shows floating panel
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Activity, Cpu, Zap, AlertCircle, Clock, RotateCcw,
  ChevronDown, ChevronRight, Eye, Radio,
} from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TraceEntry {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  category: string;
  agentId?: string;
  pillarId?: string;
  sessionId: string;
  event: string;
  data: Record<string, unknown>;
  durationMs?: number;
  tokenCount?: number;
  model?: string;
  error?: { name: string; message: string; stack?: string };
}

interface EventEntry {
  id: string;
  type: string;
  timestamp: string;
  sessionId: string;
  traceId: string;
  payload: unknown;
}

interface MetricsSummary {
  totalTraces: number;
  errorCount: number;
  avgDurationMs: number;
  totalTokens: number;
  uniquePillars: string[];
  uniqueAgents: string[];
}

// ── Sub-components ────────────────────────────────────────────────────────────

const LEVEL_COLORS: Record<string, string> = {
  debug: 'text-gray-400',
  info: 'text-blue-400',
  warn: 'text-amber-400',
  error: 'text-red-400',
};

const LEVEL_BG: Record<string, string> = {
  debug: 'bg-gray-800',
  info: 'bg-blue-950',
  warn: 'bg-amber-950',
  error: 'bg-red-950',
};

function TraceRow({ entry, expanded, onToggle }: {
  entry: TraceEntry;
  expanded: boolean;
  onToggle: () => void;
}) {
  const time = new Date(entry.timestamp).toLocaleTimeString('en-US', { hour12: false, millisecond: 'numeric' } as Intl.DateTimeFormatOptions);

  return (
    <div className={`border-b border-white/5 ${LEVEL_BG[entry.level] ?? 'bg-gray-900'}`}>
      <button
        onClick={onToggle}
        className="w-full text-left px-3 py-1.5 flex items-start gap-2 hover:bg-white/5 transition-colors"
      >
        <span className="text-gray-600 font-mono text-[10px] mt-0.5 shrink-0 w-20">{time}</span>
        <span className={`font-mono text-[10px] uppercase shrink-0 w-10 ${LEVEL_COLORS[entry.level] ?? 'text-gray-400'}`}>
          {entry.level}
        </span>
        <span className="text-gray-400 font-mono text-[10px] shrink-0 w-20">{entry.category}</span>
        <span className="text-gray-200 text-[11px] flex-1 text-left truncate">{entry.event}</span>
        {entry.durationMs !== undefined && (
          <span className="text-gray-500 font-mono text-[10px] shrink-0">{entry.durationMs}ms</span>
        )}
        {entry.tokenCount !== undefined && (
          <span className="text-purple-400 font-mono text-[10px] shrink-0">{entry.tokenCount}t</span>
        )}
        {expanded ? <ChevronDown size={10} className="text-gray-600 shrink-0 mt-0.5" /> : <ChevronRight size={10} className="text-gray-600 shrink-0 mt-0.5" />}
      </button>
      {expanded && (
        <div className="px-3 pb-2 ml-32">
          <pre className="text-[10px] text-gray-300 font-mono whitespace-pre-wrap break-all bg-black/30 rounded p-2 max-h-40 overflow-auto">
            {JSON.stringify({ data: entry.data, model: entry.model, error: entry.error }, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

function EventRow({ event }: { event: EventEntry }) {
  const time = new Date(event.timestamp).toLocaleTimeString('en-US', { hour12: false });
  return (
    <div className="border-b border-white/5 px-3 py-1 flex items-center gap-2 text-[10px] font-mono hover:bg-white/5">
      <span className="text-gray-600 w-20 shrink-0">{time}</span>
      <span className="text-blue-300 w-48 shrink-0 truncate">{event.type}</span>
      <span className="text-gray-500 w-24 shrink-0 truncate">{event.sessionId.slice(0, 8)}</span>
      <span className="text-gray-600 flex-1 truncate">{JSON.stringify(event.payload).slice(0, 80)}</span>
    </div>
  );
}

// ── Main DevPanel ──────────────────────────────────────────────────────────────

interface DevPanelProps {
  sessionId?: string;
  onClose: () => void;
}

export default function DevPanel({ sessionId, onClose }: DevPanelProps) {
  const [tab, setTab] = useState<'traces' | 'events' | 'metrics' | 'tokenBudget'>('traces');
  const [traces, setTraces] = useState<TraceEntry[]>([]);
  const [events, setEvents] = useState<EventEntry[]>([]);
  const [metrics, setMetrics] = useState<MetricsSummary | null>(null);
  const [tokenUsage, setTokenUsage] = useState<{ totalBudget: number; consumed: number; remaining: number; utilizationPct: number; perAgent: Array<{ agentId: string; tokens: number }> } | null>(null);
  const [expandedTrace, setExpandedTrace] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [filterLevel, setFilterLevel] = useState<string>('all');
  const [loading, setLoading] = useState(false);
  const tracesEndRef = useRef<HTMLDivElement>(null);

  const fetchData = useCallback(async () => {
    if (loading) return;
    setLoading(true);
    try {
      const [tracesRes, eventsRes] = await Promise.all([
        fetch(`/api/v1/observability/traces${sessionId ? `?sessionId=${sessionId}` : ''}&limit=200`),
        fetch(`/api/v1/event-bus/history${sessionId ? `?sessionId=${sessionId}` : ''}&limit=100`),
      ]);

      if (tracesRes.ok) {
        const data = await tracesRes.json() as { traces: TraceEntry[]; metrics: MetricsSummary };
        setTraces(data.traces ?? []);
        setMetrics(data.metrics ?? null);
      }
      if (eventsRes.ok) {
        const data = await eventsRes.json() as { events: EventEntry[] };
        setEvents(data.events ?? []);
      }

      // Fetch token usage if session is available
      if (sessionId) {
        const budgetRes = await fetch(`/api/v1/token-budget/${sessionId}`);
        if (budgetRes.ok) {
          const data = await budgetRes.json() as typeof tokenUsage;
          setTokenUsage(data);
        }
      }
    } catch {
      // Silently fail — dev panel should not interfere with app
    } finally {
      setLoading(false);
    }
  }, [sessionId, loading]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data-load kickoff (intentional)
    void fetchData();
  }, [sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => { void fetchData(); }, 2000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  useEffect(() => {
    if (tab === 'traces' && autoRefresh) {
      tracesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [traces, tab, autoRefresh]);

  const filteredTraces = filterLevel === 'all'
    ? traces
    : traces.filter(t => t.level === filterLevel);

  return (
    <div
      className="fixed bottom-4 right-4 w-[720px] max-h-[480px] rounded-xl shadow-2xl flex flex-col z-50 overflow-hidden"
      style={{ background: '#0d0d0d', border: '1px solid rgba(255,255,255,0.1)' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-white/10 shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full bg-green-400 animate-pulse" />
          <span className="text-white font-mono text-xs font-semibold">Atomic Dev Panel</span>
          {sessionId && (
            <span className="text-gray-500 font-mono text-[10px] bg-gray-800 px-1.5 py-0.5 rounded">
              {sessionId.slice(0, 8)}
            </span>
          )}
          <span className={`font-mono text-[9px] px-1.5 py-0.5 rounded ${autoRefresh ? 'bg-green-900 text-green-400' : 'bg-gray-800 text-gray-500'}`}>
            {autoRefresh ? '● LIVE' : '○ PAUSED'}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setAutoRefresh(v => !v)}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            title={autoRefresh ? 'Pause refresh' : 'Resume live refresh'}
          >
            <Radio size={12} className={autoRefresh ? 'text-green-400' : 'text-gray-500'} />
          </button>
          <button
            onClick={() => void fetchData()}
            className="p-1 rounded hover:bg-white/10 transition-colors"
            title="Refresh now"
          >
            <RotateCcw size={12} className="text-gray-400" />
          </button>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 transition-colors">
            <X size={12} className="text-gray-400" />
          </button>
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex border-b border-white/10 shrink-0">
        {(
          [
            { id: 'traces', label: 'Traces', icon: Activity },
            { id: 'events', label: 'Events', icon: Zap },
            { id: 'metrics', label: 'Metrics', icon: Cpu },
            { id: 'tokenBudget', label: 'Tokens', icon: Eye },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-[11px] font-mono transition-colors border-b-2 ${
              tab === id
                ? 'border-blue-400 text-blue-400'
                : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            <Icon size={10} />
            {label}
            {id === 'traces' && traces.length > 0 && (
              <span className="bg-gray-700 text-gray-300 text-[9px] px-1 rounded-full">{traces.length}</span>
            )}
          </button>
        ))}

        {tab === 'traces' && (
          <div className="ml-auto flex items-center gap-1 px-3">
            <select
              value={filterLevel}
              onChange={e => setFilterLevel(e.target.value)}
              className="bg-gray-900 text-gray-400 text-[10px] font-mono border border-white/10 rounded px-1 py-0.5"
            >
              {['all', 'debug', 'info', 'warn', 'error'].map(l => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {tab === 'traces' && (
          <div>
            {filteredTraces.length === 0 ? (
              <div className="flex items-center justify-center h-24 text-gray-600 text-xs font-mono">
                {loading ? 'Loading traces...' : 'No traces yet'}
              </div>
            ) : (
              filteredTraces.map(entry => (
                <TraceRow
                  key={entry.spanId}
                  entry={entry}
                  expanded={expandedTrace === entry.spanId}
                  onToggle={() => setExpandedTrace(v => v === entry.spanId ? null : entry.spanId)}
                />
              ))
            )}
            <div ref={tracesEndRef} />
          </div>
        )}

        {tab === 'events' && (
          <div>
            {events.length === 0 ? (
              <div className="flex items-center justify-center h-24 text-gray-600 text-xs font-mono">
                No events yet
              </div>
            ) : (
              [...events].reverse().map(event => (
                <EventRow key={event.id} event={event} />
              ))
            )}
          </div>
        )}

        {tab === 'metrics' && metrics && (
          <div className="p-4 grid grid-cols-2 gap-3">
            {[
              { label: 'Total Traces', value: metrics.totalTraces, color: 'text-blue-400' },
              { label: 'Errors', value: metrics.errorCount, color: metrics.errorCount > 0 ? 'text-red-400' : 'text-green-400' },
              { label: 'Avg Duration', value: `${metrics.avgDurationMs}ms`, color: 'text-amber-400' },
              { label: 'Total Tokens', value: metrics.totalTokens.toLocaleString(), color: 'text-purple-400' },
            ].map(({ label, value, color }) => (
              <div key={label} className="bg-gray-900 rounded-lg p-3 border border-white/5">
                <p className="text-gray-500 text-[10px] font-mono uppercase tracking-widest mb-1">{label}</p>
                <p className={`text-xl font-mono font-bold ${color}`}>{value}</p>
              </div>
            ))}

            {metrics.uniquePillars.length > 0 && (
              <div className="col-span-2 bg-gray-900 rounded-lg p-3 border border-white/5">
                <p className="text-gray-500 text-[10px] font-mono uppercase tracking-widest mb-2">Active Pillars</p>
                <div className="flex flex-wrap gap-1.5">
                  {metrics.uniquePillars.map(p => (
                    <span key={p} className="bg-blue-900/40 text-blue-300 text-[10px] font-mono px-2 py-0.5 rounded">{p}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {tab === 'metrics' && !metrics && (
          <div className="flex items-center justify-center h-24 text-gray-600 text-xs font-mono">
            No metrics available yet
          </div>
        )}

        {tab === 'tokenBudget' && tokenUsage && (
          <div className="p-4">
            {/* Budget bar */}
            <div className="mb-4">
              <div className="flex justify-between text-[10px] font-mono mb-1">
                <span className="text-gray-400">Token Budget</span>
                <span className={tokenUsage.utilizationPct > 80 ? 'text-amber-400' : 'text-green-400'}>
                  {tokenUsage.utilizationPct}% used
                </span>
              </div>
              <div className="h-2 bg-gray-800 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${tokenUsage.utilizationPct > 90 ? 'bg-red-500' : tokenUsage.utilizationPct > 80 ? 'bg-amber-500' : 'bg-green-500'}`}
                  style={{ width: `${tokenUsage.utilizationPct}%` }}
                />
              </div>
              <div className="flex justify-between text-[9px] font-mono text-gray-600 mt-1">
                <span>{tokenUsage.consumed.toLocaleString()} consumed</span>
                <span>{tokenUsage.remaining.toLocaleString()} remaining</span>
              </div>
            </div>

            {/* Per-agent breakdown */}
            <p className="text-gray-500 text-[10px] font-mono uppercase tracking-widest mb-2">Per Agent</p>
            <div className="space-y-1.5">
              {tokenUsage.perAgent.map(({ agentId, tokens }) => (
                <div key={agentId} className="flex items-center gap-2">
                  <span className="text-gray-400 font-mono text-[10px] w-32 truncate">{agentId}</span>
                  <div className="flex-1 h-1.5 bg-gray-800 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-purple-500 rounded-full"
                      style={{ width: `${Math.round((tokens / tokenUsage.totalBudget) * 100)}%` }}
                    />
                  </div>
                  <span className="text-purple-400 font-mono text-[10px] w-16 text-right">{tokens.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'tokenBudget' && !tokenUsage && (
          <div className="flex items-center justify-center h-24 text-gray-600 text-xs font-mono">
            {sessionId ? 'No token data yet' : 'No active session'}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-1.5 border-t border-white/10 shrink-0">
        <div className="flex items-center gap-1">
          {loading && <Clock size={10} className="text-gray-500 animate-spin" />}
          <span className="text-gray-600 font-mono text-[9px]">
            {loading ? 'Fetching...' : `${new Date().toLocaleTimeString('en-US', { hour12: false })}`}
          </span>
        </div>
        <div className="flex items-center gap-3 text-[9px] font-mono text-gray-600">
          <span>{traces.length} traces</span>
          <span>{events.length} events</span>
          {metrics?.errorCount !== undefined && metrics.errorCount > 0 && (
            <span className="text-red-400 flex items-center gap-1">
              <AlertCircle size={8} />
              {metrics.errorCount} errors
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
