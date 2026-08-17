/**
 * src/components/VersionHistory.tsx
 *
 * Blueprint Version History Panel
 *
 * Displays the full version history for a blueprint with:
 *   - Version list (browsable, filterable by author/type)
 *   - Click any version to preview (read-only)
 *   - Restore creates a new version — never destructive
 *   - Integrity hash display per version
 *   - Inline diff summary between any two adjacent versions
 */

import React, { useState, useEffect } from 'react';
import { GitBranch, RotateCcw, Shield, ChevronDown, ChevronRight, Eye, AlertTriangle } from 'lucide-react';

// ── Types ──────────────────────────────────────────────────────────────────────

type VersionAuthor = 'curator' | 'pipeline' | 'user' | 'pillar_subagent';
type VersionChangeType = 'full' | 'pillar' | 'checkpoint' | 'restore';

interface DiffSection {
  path:    string;
  before?: string;
  after?:  string;
}

interface BlueprintDiff {
  added:     DiffSection[];
  removed:   DiffSection[];
  modified:  DiffSection[];
  unchanged: number;
}

interface VersionSummary {
  id:              string;
  blueprintId:     string;
  versionNumber:   number;
  parentVersion:   number | null;
  timestamp:       string;
  author:          VersionAuthor;
  authorDetail:    string;
  changeSummary:   string;
  changeType:      VersionChangeType;
  affectedPillars: string[];
  diff:            BlueprintDiff;
  integrityHash:   string;
}

interface Props {
  blueprintId: string;
  currentVersionNumber?: number;
  onRestore?: (versionNumber: number) => void;
  onPreview?: (versionNumber: number) => void;
  className?: string;
}

// ── Author badge config ────────────────────────────────────────────────────────

const AUTHOR_CONFIG: Record<VersionAuthor, { label: string; color: string }> = {
  curator:        { label: 'Curator',   color: 'bg-rose-100 text-rose-700' },
  pipeline:       { label: 'Pipeline',  color: 'bg-violet-100 text-violet-700' },
  user:           { label: 'User',      color: 'bg-blue-100 text-blue-700' },
  pillar_subagent:{ label: 'Pillar',    color: 'bg-amber-100 text-amber-700' },
};

const CHANGE_TYPE_ICON: Record<VersionChangeType, React.ReactNode> = {
  full:        <GitBranch size={12} />,
  pillar:      <ChevronRight size={12} />,
  checkpoint:  <Shield size={12} />,
  restore:     <RotateCcw size={12} />,
};

// ── Component ─────────────────────────────────────────────────────────────────

export function VersionHistory({ blueprintId, currentVersionNumber, onRestore, onPreview, className = '' }: Props) {
  const [versions, setVersions]         = useState<VersionSummary[]>([]);
  const [isLoading, setIsLoading]       = useState(true);
  const [error, setError]               = useState<string | null>(null);
  const [expandedId, setExpandedId]     = useState<string | null>(null);
  const [restoringId, setRestoringId]   = useState<string | null>(null);
  const [integrityMap, setIntegrityMap] = useState<Record<string, boolean>>({});
  const [filterAuthor, setFilterAuthor] = useState<VersionAuthor | 'all'>('all');
  const [filterType, setFilterType]     = useState<VersionChangeType | 'all'>('all');

  useEffect(() => {
    if (!blueprintId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data-load kickoff (intentional)
    setIsLoading(true);
    setError(null);
    fetch(`/api/v1/blueprints/${blueprintId}/versions`)
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((data: { versions: VersionSummary[] }) => setVersions(data.versions ?? []))
      .catch((err: Error) => setError(err.message))
      .finally(() => setIsLoading(false));
  }, [blueprintId]);

  const verifyIntegrity = async (version: VersionSummary) => {
    try {
      const res = await fetch(
        `/api/v1/blueprints/${blueprintId}/versions/${version.versionNumber}/integrity`
      );
      const data = await res.json() as { valid: boolean };
      setIntegrityMap(prev => ({ ...prev, [version.id]: data.valid }));
    } catch { /* best-effort */ }
  };

  const handleRestore = async (version: VersionSummary) => {
    if (version.versionNumber === 1) return; // V1 is always read-only reference
    setRestoringId(version.id);
    try {
      const res = await fetch(
        `/api/v1/blueprints/${blueprintId}/versions/${version.versionNumber}/restore`,
        { method: 'POST' }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { newVersion: VersionSummary };
      setVersions(prev => [data.newVersion, ...prev]);
      onRestore?.(data.newVersion.versionNumber);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Restore failed');
    } finally {
      setRestoringId(null);
    }
  };

  const filtered = versions.filter(v => {
    if (filterAuthor !== 'all' && v.author !== filterAuthor) return false;
    if (filterType !== 'all' && v.changeType !== filterType) return false;
    return true;
  });

  if (isLoading) return (
    <div className={`flex items-center justify-center py-12 text-sm text-gray-400 ${className}`}>
      <div className="animate-pulse">Loading version history…</div>
    </div>
  );

  if (error) return (
    <div className={`flex items-center gap-2 p-4 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 ${className}`}>
      <AlertTriangle size={14} />
      <span>Failed to load versions: {error}</span>
    </div>
  );

  return (
    <div className={`space-y-4 ${className}`}>

      {/* Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <span className="text-xs font-medium text-gray-500">Filter:</span>
        <select
          value={filterAuthor}
          onChange={e => setFilterAuthor(e.target.value as VersionAuthor | 'all')}
          className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-gray-300"
        >
          <option value="all">All authors</option>
          <option value="curator">Curator</option>
          <option value="pipeline">Pipeline</option>
          <option value="user">User</option>
          <option value="pillar_subagent">Pillar</option>
        </select>
        <select
          value={filterType}
          onChange={e => setFilterType(e.target.value as VersionChangeType | 'all')}
          className="text-xs border border-gray-200 rounded-lg px-2 py-1 bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-gray-300"
        >
          <option value="all">All types</option>
          <option value="full">Full run</option>
          <option value="pillar">Pillar update</option>
          <option value="checkpoint">Checkpoint</option>
          <option value="restore">Restore</option>
        </select>
        <span className="text-xs text-gray-400 ml-auto">{filtered.length} version{filtered.length !== 1 ? 's' : ''}</span>
      </div>

      {filtered.length === 0 && (
        <div className="text-center py-8 text-sm text-gray-400">
          No versions match the current filter.
        </div>
      )}

      {/* Version list */}
      <div className="space-y-2">
        {filtered.map(version => {
          const isExpanded   = expandedId === version.id;
          const isRestoring  = restoringId === version.id;
          const isCurrent    = version.versionNumber === currentVersionNumber;
          const authorConf   = AUTHOR_CONFIG[version.author];
          const integrityOk  = integrityMap[version.id];
          const diffCount    = version.diff.added.length + version.diff.removed.length + version.diff.modified.length;

          return (
            <div
              key={version.id}
              className={`bg-white border rounded-xl overflow-hidden transition-all
                ${isCurrent ? 'border-rose-300 shadow-sm' : 'border-gray-200'}`}
            >
              {/* Version header */}
              <div
                className="px-4 py-3 flex items-center gap-3 cursor-pointer hover:bg-gray-50 transition-colors"
                onClick={() => setExpandedId(isExpanded ? null : version.id)}
              >
                <div className="flex items-center gap-1.5 text-gray-400 shrink-0">
                  {CHANGE_TYPE_ICON[version.changeType]}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <span className="text-xs font-mono font-bold text-gray-900">v{version.versionNumber}</span>
                    {isCurrent && (
                      <span className="text-[10px] font-semibold bg-rose-900 text-white px-1.5 py-0.5 rounded-full">
                        CURRENT
                      </span>
                    )}
                    {version.versionNumber === 1 && (
                      <span className="text-[10px] font-semibold bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded-full">
                        ORIGINAL
                      </span>
                    )}
                    <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${authorConf.color}`}>
                      {authorConf.label}
                    </span>
                  </div>
                  <p className="text-xs text-gray-600 truncate">{version.changeSummary}</p>
                </div>

                <div className="flex items-center gap-3 shrink-0">
                  <div className="text-right">
                    <div className="text-[10px] text-gray-400">{formatRelativeTime(version.timestamp)}</div>
                    {diffCount > 0 && (
                      <div className="text-[10px] text-gray-400">
                        {diffCount} change{diffCount !== 1 ? 's' : ''}
                      </div>
                    )}
                  </div>
                  {isExpanded ? <ChevronDown size={14} className="text-gray-400" /> : <ChevronRight size={14} className="text-gray-400" />}
                </div>
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div className="border-t border-gray-100 px-4 py-4 space-y-4">

                  {/* Author detail + timestamp */}
                  <div className="flex items-start gap-6 text-xs text-gray-600">
                    <div>
                      <span className="font-medium text-gray-500 block mb-0.5">Author</span>
                      {version.authorDetail}
                    </div>
                    <div>
                      <span className="font-medium text-gray-500 block mb-0.5">Timestamp</span>
                      {new Date(version.timestamp).toLocaleString()}
                    </div>
                    {version.affectedPillars.length > 0 && (
                      <div>
                        <span className="font-medium text-gray-500 block mb-0.5">Affected Pillars</span>
                        {version.affectedPillars.join(', ')}
                      </div>
                    )}
                  </div>

                  {/* Diff summary */}
                  {diffCount > 0 && (
                    <div className="space-y-1">
                      <span className="text-xs font-medium text-gray-500">Changes</span>
                      <div className="flex items-center gap-3 text-xs">
                        {version.diff.added.length > 0 && (
                          <span className="text-emerald-600">+{version.diff.added.length} added</span>
                        )}
                        {version.diff.modified.length > 0 && (
                          <span className="text-amber-600">~{version.diff.modified.length} modified</span>
                        )}
                        {version.diff.removed.length > 0 && (
                          <span className="text-red-600">-{version.diff.removed.length} removed</span>
                        )}
                        <span className="text-gray-400">{version.diff.unchanged} unchanged</span>
                      </div>
                    </div>
                  )}

                  {/* Integrity hash */}
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-medium text-gray-500">Integrity</span>
                    <code className="text-[10px] font-mono text-gray-400 truncate max-w-[200px]">
                      {version.integrityHash.slice(0, 16)}…
                    </code>
                    <button
                      onClick={() => verifyIntegrity(version)}
                      className="text-[10px] text-blue-600 hover:underline"
                    >
                      Verify
                    </button>
                    {integrityOk !== undefined && (
                      <span className={`text-[10px] font-semibold ${integrityOk ? 'text-emerald-600' : 'text-red-600'}`}>
                        {integrityOk ? '✓ Valid' : '✗ Corrupted'}
                      </span>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => onPreview?.(version.versionNumber)}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs border border-gray-200
                                 rounded-lg text-gray-600 hover:bg-gray-50 transition-colors"
                    >
                      <Eye size={12} /> Preview
                    </button>
                    {!isCurrent && version.versionNumber !== 1 && (
                      <button
                        onClick={() => handleRestore(version)}
                        disabled={isRestoring}
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-gray-900 text-white
                                   rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors"
                      >
                        <RotateCcw size={12} />
                        {isRestoring ? 'Restoring…' : 'Restore this version'}
                      </button>
                    )}
                    {version.versionNumber === 1 && (
                      <span className="text-[10px] text-gray-400 flex items-center gap-1">
                        <Shield size={10} /> Original version — permanently preserved
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days  = Math.floor(diff / 86400000);
  if (diff < 60000)       return 'just now';
  if (mins < 60)          return `${mins}m ago`;
  if (hours < 24)         return `${hours}h ago`;
  return `${days}d ago`;
}
