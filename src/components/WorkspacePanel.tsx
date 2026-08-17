/**
 * src/components/WorkspacePanel.tsx
 *
 * Agent Workspace Panel — §4 of the v4 spec.
 * Each workspace has a dedicated UI panel showing committed output in real time.
 *
 * Features:
 *   - Live streaming — tokens stream directly from sub-agent generators
 *   - Committed output shown when workspace is finalized
 *   - Snapshot history accessible per workspace
 *   - Permission indicator (shows which roles can read/write this workspace)
 *   - Validation status badge (passed/failed/pending)
 */

import React, { useState, useEffect, useRef } from 'react';
import { Clock, CheckCircle, AlertCircle, Eye, Lock, Layers, ChevronDown, ChevronRight } from 'lucide-react';
import ReactMarkdown from 'react-markdown';

// ── Types ─────────────────────────────────────────────────────────────────────

type WorkspaceStatus = 'idle' | 'streaming' | 'committed' | 'validation_failed';

interface WorkspaceSnapshot {
  id: string;
  snapshotVersion: number;
  snapshotAt: string;
  reason: string;
}

interface WorkspacePanelProps {
  workspaceId: string;
  label: string;
  sessionId: string;
  /** Live streaming content (cleared when committed) */
  streamingContent?: string;
  /** Status of this workspace */
  status: WorkspaceStatus;
  /** Validation completeness score 0–1 */
  completenessScore?: number;
  /** Quality flags */
  qualityFlags?: Array<{ code: string; severity: string; message: string }>;
  /** Collapsed by default */
  defaultCollapsed?: boolean;
  /** Icon to show in header */
  icon?: React.ReactNode;
  /** Accent color class (tailwind bg- class) */
  accentColor?: string;
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ status, completenessScore }: { status: WorkspaceStatus; completenessScore?: number }) {
  const configs: Record<WorkspaceStatus, { icon: React.ReactNode; label: string; classes: string }> = {
    idle: {
      icon: <Clock size={10} />,
      label: 'Idle',
      classes: 'bg-gray-100 text-gray-500',
    },
    streaming: {
      icon: <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />,
      label: 'Streaming',
      classes: 'bg-blue-50 text-blue-700',
    },
    committed: {
      icon: <CheckCircle size={10} />,
      label: completenessScore !== undefined
        ? `Committed · ${Math.round(completenessScore * 100)}%`
        : 'Committed',
      classes: completenessScore !== undefined && completenessScore < 0.6
        ? 'bg-amber-50 text-amber-700'
        : 'bg-green-50 text-green-700',
    },
    validation_failed: {
      icon: <AlertCircle size={10} />,
      label: 'Validation Failed',
      classes: 'bg-red-50 text-red-700',
    },
  };

  const { icon, label, classes } = configs[status];

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${classes}`}>
      {icon}
      {label}
    </span>
  );
}

// ── Completeness bar ──────────────────────────────────────────────────────────

function CompletenessBar({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  const color = pct >= 80 ? 'bg-green-500' : pct >= 60 ? 'bg-amber-500' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all duration-500`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-gray-400 font-mono w-8 text-right">{pct}%</span>
    </div>
  );
}

// ── Main WorkspacePanel ───────────────────────────────────────────────────────

export default function WorkspacePanel({
  workspaceId,
  label,
  sessionId,
  streamingContent,
  status,
  completenessScore,
  qualityFlags = [],
  defaultCollapsed = false,
  icon,
  accentColor = 'bg-gray-900',
}: WorkspacePanelProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const [snapshots, setSnapshots] = useState<WorkspaceSnapshot[]>([]);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [content, setContent] = useState<string | null>(null);
  const [loadingContent, setLoadingContent] = useState(false);
  const streamRef = useRef<HTMLDivElement>(null);

  const criticalFlags = qualityFlags.filter(f => f.severity === 'critical');
  const warningFlags = qualityFlags.filter(f => f.severity === 'warning');

  useEffect(() => {
    if (streamRef.current && status === 'streaming') {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [streamingContent, status]);

  useEffect(() => {
    if (status === 'committed' && !collapsed && !content) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- async data-load kickoff (intentional)
      setLoadingContent(true);
      fetch(`/api/v1/workspaces/${sessionId}/${encodeURIComponent(workspaceId)}`)
        .then(r => r.ok ? r.json() : null)
        .then((data: { content: unknown } | null) => {
          if (data?.content) {
            setContent(
              typeof data.content === 'string'
                ? data.content
                : JSON.stringify(data.content, null, 2)
            );
          }
        })
        .catch(() => null)
        .finally(() => setLoadingContent(false));
    }
  }, [status, collapsed, content, sessionId, workspaceId]);

  const loadSnapshots = async () => {
    try {
      const res = await fetch(`/api/v1/workspaces/${sessionId}/${encodeURIComponent(workspaceId)}/snapshots`);
      if (res.ok) {
        const data = await res.json() as { snapshots: WorkspaceSnapshot[] };
        setSnapshots(data.snapshots ?? []);
        setShowSnapshots(true);
      }
    } catch { /* ignore */ }
  };

  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden bg-white">
      {/* Header */}
      <button
        onClick={() => setCollapsed(v => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-gray-50 transition-colors"
      >
        <div className={`w-6 h-6 rounded-md ${accentColor} flex items-center justify-center text-white shrink-0`}>
          {icon ?? <Layers size={12} />}
        </div>
        <span className="text-sm font-semibold text-gray-800 flex-1 text-left">{label}</span>
        <StatusBadge status={status} completenessScore={completenessScore} />
        {status === 'committed' && (
          <button
            onClick={e => { e.stopPropagation(); void loadSnapshots(); }}
            className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors"
            title="View snapshot history"
          >
            <Eye size={12} />
          </button>
        )}
        <span className="text-gray-400">
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </span>
      </button>

      {!collapsed && (
        <div className="border-t border-gray-100">
          {/* Quality flags */}
          {(criticalFlags.length > 0 || warningFlags.length > 0) && (
            <div className="px-4 py-2 border-b border-gray-100 space-y-1">
              {criticalFlags.map(f => (
                <div key={f.code} className="flex items-start gap-2 text-xs text-red-700 bg-red-50 rounded px-2 py-1">
                  <AlertCircle size={10} className="mt-0.5 shrink-0" />
                  <span>{f.message}</span>
                </div>
              ))}
              {warningFlags.map(f => (
                <div key={f.code} className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 rounded px-2 py-1">
                  <AlertCircle size={10} className="mt-0.5 shrink-0" />
                  <span>{f.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* Completeness score */}
          {completenessScore !== undefined && status === 'committed' && (
            <div className="px-4 py-2 border-b border-gray-100">
              <p className="text-[10px] text-gray-400 font-mono uppercase tracking-widest mb-1">Completeness</p>
              <CompletenessBar score={completenessScore} />
            </div>
          )}

          {/* Streaming content */}
          {status === 'streaming' && (
            <div
              ref={streamRef}
              className="p-4 max-h-64 overflow-auto bg-gray-50"
            >
              <p className="text-[10px] text-gray-400 font-mono uppercase tracking-widest mb-2 flex items-center gap-1">
                <div className="w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                Live output
              </p>
              <pre className="text-xs text-gray-700 font-mono whitespace-pre-wrap break-words leading-relaxed">
                {streamingContent ?? ''}
                <span className="inline-block w-0.5 h-3 bg-blue-500 animate-pulse ml-0.5 align-middle" />
              </pre>
            </div>
          )}

          {/* Committed content */}
          {status === 'committed' && (
            <div className="p-4 max-h-80 overflow-auto">
              {loadingContent ? (
                <div className="flex items-center justify-center h-16 text-gray-400 text-sm">
                  Loading workspace content...
                </div>
              ) : content ? (
                <div className="prose prose-sm max-w-none text-gray-700">
                  <ReactMarkdown>{content}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-gray-400 italic">No content available</p>
              )}
            </div>
          )}

          {/* Idle state */}
          {status === 'idle' && (
            <div className="flex items-center justify-center h-16 px-4">
              <p className="text-sm text-gray-400 italic">
                Waiting for agent to begin…
              </p>
            </div>
          )}

          {/* Validation failed */}
          {status === 'validation_failed' && (
            <div className="p-4 bg-red-50">
              <div className="flex items-start gap-2">
                <Lock size={14} className="text-red-500 mt-0.5 shrink-0" />
                <div>
                  <p className="text-sm font-medium text-red-700">Output blocked by validation gate</p>
                  <p className="text-xs text-red-600 mt-0.5">
                    The agent&apos;s output did not meet the schema requirements for this workspace.
                    The sub-agent is retrying or awaiting intervention.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Snapshot history */}
          {showSnapshots && (
            <div className="border-t border-gray-100 px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-[10px] text-gray-400 font-mono uppercase tracking-widest">Snapshot History</p>
                <button onClick={() => setShowSnapshots(false)} className="text-gray-400 hover:text-gray-600">
                  <ChevronDown size={12} />
                </button>
              </div>
              {snapshots.length === 0 ? (
                <p className="text-xs text-gray-400">No snapshots</p>
              ) : (
                <div className="space-y-1">
                  {snapshots.map(s => (
                    <div key={s.id} className="flex items-center justify-between text-xs text-gray-600 bg-gray-50 rounded px-2 py-1">
                      <span className="font-mono">v{s.snapshotVersion}</span>
                      <span className="text-gray-400">{s.reason}</span>
                      <span className="text-gray-400">{new Date(s.snapshotAt).toLocaleTimeString()}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
