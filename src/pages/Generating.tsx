/**
 * src/pages/Generating.tsx
 *
 * Live generation progress view — §13 of the v4 spec.
 *
 * Reads from GenerationContext for overall progress + per-pillar statuses.
 * Renders:
 *   - Per-pillar status cards with real-time states
 *   - Intervention controls (pause/resume/cancel/rerun/feedback/promote)
 *   - Global progress track + percentage
 *   - Stop (graceful) and Terminate (hard cancel) buttons
 *   - Error recovery options
 *
 * Generation survives navigation — this page is just a view into GenerationContext.
 */

import { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertCircle, Square, History, RotateCcw, ChevronDown, ChevronUp } from 'lucide-react';
import { useGeneration, type ActiveGeneration } from '../context/GenerationContext';
import { PILLAR_COUNT } from '../engine/types';
import PillarCard, { type PillarCardData } from '../components/PillarCard';
import type { PillarStatus } from '../engine/systemState';

// ── Pillar name map ────────────────────────────────────────────────────────────

const PILLAR_NAMES: Record<string, string> = {
  planning:    'Planning',
  production:  'Production',
  edge_cases:  'Edge Cases',
  integration: 'Integration',
  security:    'Security',
  quality:     'Quality',
  completeness:'Completeness',
};

const PILLAR_ORDER = Object.keys(PILLAR_NAMES);

// ── Default pillars for display before SSE statuses arrive ────────────────────

function buildDefaultPillars(): PillarCardData[] {
  return PILLAR_ORDER.map(id => ({
    id,
    name: PILLAR_NAMES[id] ?? id,
    status: 'idle' as PillarStatus,
  }));
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Generating({ onReset }: { onReset: () => void }) {
  const navigate = useNavigate();
  const { active, statusMessage, pct, stop, terminate } = useGeneration();

  const [pillars, setPillars] = useState<PillarCardData[]>(buildDefaultPillars());
  const [showPillars, setShowPillars] = useState(true);

  // Redirect to landing if no active generation
  useEffect(() => {
    if (!active) navigate('/', { replace: true });
  }, [active, navigate]);

  // Sync pillar statuses from GenerationContext's live pillarStatuses map
  useEffect(() => {
    if (!active) return;

    // GenerationContext emits pillarStatuses via the active object
    const rawStatuses: Record<string, PillarStatus> =
      (active as unknown as { pillarStatuses?: Record<string, PillarStatus> }).pillarStatuses ?? {};

    const rawCounts: Record<string, { completed: number; total: number; failed: string[] }> =
      (active as unknown as {
        pillarAgentCounts?: Record<string, { completed: number; total: number; failed: string[] }>
      }).pillarAgentCounts ?? {};

    const rawStreams: Record<string, string> =
      (active as unknown as { pillarStreams?: Record<string, string> }).pillarStreams ?? {};

    const rawScores: Record<string, number> =
      (active as unknown as { pillarQualityScores?: Record<string, number> }).pillarQualityScores ?? {};

    const rawTokens: Record<string, number> =
      (active as unknown as { pillarTokens?: Record<string, number> }).pillarTokens ?? {};

    const rawDurations: Record<string, number> =
      (active as unknown as { pillarDurations?: Record<string, number> }).pillarDurations ?? {};

    const rawErrors: Record<string, string> =
      (active as unknown as { pillarErrors?: Record<string, string> }).pillarErrors ?? {};

    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data-load kickoff (intentional)
    setPillars(
      PILLAR_ORDER.map(id => {
        const counts = rawCounts[id];
        return {
          id,
          name: PILLAR_NAMES[id] ?? id,
          status: rawStatuses[id] ?? 'idle',
          agentCount: counts?.total,
          completedAgents: counts?.completed,
          failedAgents: counts?.failed,
          streamingPreview: rawStreams[id],
          qualityScore: rawScores[id],
          tokensUsed: rawTokens[id],
          durationMs: rawDurations[id],
          errorMessage: rawErrors[id],
        } satisfies PillarCardData;
      })
    );
  }, [active]);

  const handlePause = useCallback(async (pillarId: string) => {
    if (!active?.sessionId) return;
    try {
      await fetch(`/api/v1/sessions/${active.sessionId}/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pillarId, action: 'pause' }),
      });
    } catch { /* ignore */ }
  }, [active]);

  const handleResume = useCallback(async (pillarId: string) => {
    if (!active?.sessionId) return;
    try {
      await fetch(`/api/v1/sessions/${active.sessionId}/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pillarId, action: 'resume' }),
      });
    } catch { /* ignore */ }
  }, [active]);

  const handleCancel = useCallback(async (pillarId: string) => {
    if (!active?.sessionId) return;
    try {
      await fetch(`/api/v1/sessions/${active.sessionId}/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pillarId, action: 'cancel' }),
      });
    } catch { /* ignore */ }
  }, [active]);

  const handleRerun = useCallback(async (pillarId: string, feedback?: string) => {
    if (!active?.sessionId) return;
    // blueprintId may come from the active object via SSE events (not in the base type)
    const blueprintId = (active as ActiveGeneration & { blueprintId?: string }).blueprintId;
    try {
      await fetch('/api/v1/rerun-pillar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: active.sessionId,
          blueprintId,
          pillar: pillarId,
          feedbackInjection: feedback,
        }),
      });
    } catch { /* ignore */ }
  }, [active]);

  const handlePromoteToCurator = useCallback(async (pillarId: string) => {
    if (!active?.sessionId) return;
    const blueprintId = (active as ActiveGeneration & { blueprintId?: string }).blueprintId;
    try {
      await fetch(`/api/v1/curator/${active.sessionId}/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pillarId, blueprintId }),
      });
    } catch { /* ignore */ }
  }, [active]);

  if (!active) return null;

  const isFinished = active.stopped || !!active.error;
  const completedCount = pillars.filter(p => p.status === 'complete').length;
  const runningCount = pillars.filter(p => p.status === 'running' || p.status === 'retrying' || p.status === 'improving').length;
  const failedCount = pillars.filter(p => p.status === 'failed').length;

  return (
    <div
      className="min-h-screen flex flex-col items-center p-6 md:p-10"
      style={{ background: '#f5f4f0' }}
    >
      <div className="w-full max-w-2xl">

        {/* Label */}
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400
                      font-mono mb-6 text-center">
          {active.stopped
            ? 'Generation Stopped'
            : active.error
              ? 'Generation Failed'
              : 'Generating Blueprint'}
        </p>

        {/* Prompt card */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm p-5 mb-6">
          <p className="text-[13px] italic text-gray-600 leading-relaxed line-clamp-3">
            &ldquo;{active.prompt}&rdquo;
          </p>
        </div>

        {/* Overall status row */}
        <div className="flex items-center gap-4 mb-6">
          {/* Spinner / stop indicator */}
          <div className="shrink-0">
            {isFinished ? (
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center"
                style={{ background: active.error ? '#fef2f2' : '#f3f4f6' }}
              >
                {active.error
                  ? <AlertCircle size={16} className="text-red-500" />
                  : <Square size={14} className="text-gray-400" />
                }
              </div>
            ) : (
              <div className="w-8 h-8 border-2 border-gray-200 border-t-gray-800
                              rounded-full animate-spin" />
            )}
          </div>

          {/* Status text */}
          <div className="flex-1 min-w-0">
            <p className="text-base font-semibold text-gray-800 truncate">
              {statusMessage}
            </p>
            <p className="text-xs text-gray-400">
              {active.stopped
                ? 'Pipeline cancelled. Partial results were not saved.'
                : active.error
                  ? active.error
                  : runningCount > 0
                    ? `${runningCount} pillar${runningCount > 1 ? 's' : ''} running · ${completedCount}/${PILLAR_COUNT} complete`
                    : `${completedCount} of ${PILLAR_COUNT} stages complete`
              }
            </p>
          </div>

          {/* Summary badges */}
          {!isFinished && (
            <div className="flex items-center gap-1.5 shrink-0">
              {completedCount > 0 && (
                <span className="text-[10px] bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">
                  ✓ {completedCount}
                </span>
              )}
              {runningCount > 0 && (
                <span className="text-[10px] bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium animate-pulse">
                  ↻ {runningCount}
                </span>
              )}
              {failedCount > 0 && (
                <span className="text-[10px] bg-red-100 text-red-700 px-2 py-0.5 rounded-full font-medium">
                  ✗ {failedCount}
                </span>
              )}
            </div>
          )}
        </div>

        {/* Global progress track — hide when stopped/errored */}
        {!isFinished && (
          <div className="mb-6">
            <div className="flex gap-1">
              {Array.from({ length: PILLAR_COUNT }).map((_, i) => (
                <div
                  key={i}
                  className={`flex-1 h-1 rounded-full transition-all duration-500 ${
                    i < active.completedStages
                      ? 'bg-gray-900'
                      : i === active.completedStages
                        ? 'bg-gray-400 animate-pulse'
                        : 'bg-gray-200'
                  }`}
                />
              ))}
            </div>
            <div className="flex justify-between mt-1.5 text-[10px] text-gray-400 font-mono">
              <span>0%</span>
              <span>{pct}%</span>
              <span>100%</span>
            </div>
          </div>
        )}

        {/* Per-pillar status cards */}
        {!isFinished && (
          <div className="mb-6">
            <button
              onClick={() => setShowPillars(v => !v)}
              className="flex items-center gap-2 text-[11px] text-gray-400 hover:text-gray-600
                         font-mono uppercase tracking-widest mb-3 w-full"
            >
              {showPillars ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              Pillar Status
            </button>

            {showPillars && (
              <div className="space-y-2">
                {pillars.map(pillar => (
                  <PillarCard
                    key={pillar.id}
                    pillar={pillar}
                    sessionId={active.sessionId ?? ''}
                    onPause={handlePause}
                    onResume={handleResume}
                    onCancel={handleCancel}
                    onRerun={handleRerun}
                    onPromoteToCurator={handlePromoteToCurator}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Action buttons ─────────────────────────────────────────────────── */}

        {isFinished ? (
          <div className="flex gap-3 justify-center">
            <button
              onClick={onReset}
              className="flex items-center gap-2 px-4 py-2 bg-gray-900 text-white
                         text-sm font-medium rounded-xl hover:bg-gray-700 transition-colors"
            >
              <RotateCcw size={14} />
              Start over
            </button>
            <button
              onClick={() => navigate('/history')}
              className="flex items-center gap-2 px-4 py-2 bg-white text-gray-700
                         text-sm font-medium rounded-xl border border-gray-200
                         hover:bg-gray-50 transition-colors"
            >
              <History size={14} />
              View history
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-6 mt-2">
            <button
              onClick={stop}
              disabled={active.isStopping}
              className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800
                         border border-gray-200 hover:border-gray-400
                         rounded-xl px-4 py-2 transition-colors disabled:opacity-40"
              title="Stop the pipeline after the current stage completes"
            >
              <Square size={13} />
              {active.isStopping ? 'Stopping…' : 'Stop generation'}
            </button>

            <button
              onClick={terminate}
              className="text-xs text-gray-400 hover:text-rose-600
                         transition-colors underline underline-offset-2"
              title="Cancel immediately and go back"
            >
              Cancel &amp; discard
            </button>
          </div>
        )}

      </div>
    </div>
  );
}
