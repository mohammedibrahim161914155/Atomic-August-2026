/**
 * src/components/PillarCard.tsx
 *
 * Per-Pillar Status Card with Intervention Controls — §13 of the v4 spec.
 *
 * Shows per-pillar status states with real-time updates via event bus,
 * and provides intervention points:
 *   - Pause any running sub-agent
 *   - Cancel and restart a specific sub-agent
 *   - Inject feedback before a sub-agent runs
 *   - Promote to Curator for immediate review
 *
 * Status states: idle / queued / running / complete / failed / retrying /
 *                improving / paused / skipped / low-confidence
 */

import React, { useState } from 'react';
import {
  CheckCircle, AlertCircle, Clock, Pause, Play, RotateCcw,
  SkipForward, ChevronDown, ChevronRight, MessageSquare, Zap,
  Loader, TrendingUp,
} from 'lucide-react';
import type { PillarStatus } from '../engine/systemState';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PillarCardData {
  id: string;
  name: string;
  status: PillarStatus;
  agentCount?: number;
  completedAgents?: number;
  failedAgents?: string[];
  qualityScore?: number;
  streamingPreview?: string;
  tokensUsed?: number;
  durationMs?: number;
  errorMessage?: string;
}

interface PillarCardProps {
  pillar: PillarCardData;
  sessionId: string;
  onPause?: (pillarId: string) => void;
  onResume?: (pillarId: string) => void;
  onCancel?: (pillarId: string) => void;
  onRerun?: (pillarId: string, feedback?: string) => void;
  onPromoteToCurator?: (pillarId: string) => void;
}

// ── Status config ──────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<PillarStatus, {
  label: string;
  icon: React.ReactNode;
  bgColor: string;
  textColor: string;
  borderColor: string;
  pulse: boolean;
}> = {
  idle: {
    label: 'Idle',
    icon: <Clock size={12} />,
    bgColor: 'bg-gray-50',
    textColor: 'text-gray-400',
    borderColor: 'border-gray-200',
    pulse: false,
  },
  queued: {
    label: 'Queued',
    icon: <Clock size={12} />,
    bgColor: 'bg-blue-50',
    textColor: 'text-blue-500',
    borderColor: 'border-blue-200',
    pulse: true,
  },
  running: {
    label: 'Running',
    icon: <Loader size={12} className="animate-spin" />,
    bgColor: 'bg-blue-50',
    textColor: 'text-blue-700',
    borderColor: 'border-blue-300',
    pulse: false,
  },
  complete: {
    label: 'Complete',
    icon: <CheckCircle size={12} />,
    bgColor: 'bg-green-50',
    textColor: 'text-green-700',
    borderColor: 'border-green-200',
    pulse: false,
  },
  failed: {
    label: 'Failed',
    icon: <AlertCircle size={12} />,
    bgColor: 'bg-red-50',
    textColor: 'text-red-700',
    borderColor: 'border-red-200',
    pulse: false,
  },
  retrying: {
    label: 'Retrying',
    icon: <RotateCcw size={12} className="animate-spin" />,
    bgColor: 'bg-amber-50',
    textColor: 'text-amber-700',
    borderColor: 'border-amber-200',
    pulse: true,
  },
  improving: {
    label: 'Improving',
    icon: <TrendingUp size={12} />,
    bgColor: 'bg-purple-50',
    textColor: 'text-purple-700',
    borderColor: 'border-purple-200',
    pulse: true,
  },
  paused: {
    label: 'Paused',
    icon: <Pause size={12} />,
    bgColor: 'bg-gray-50',
    textColor: 'text-gray-500',
    borderColor: 'border-gray-300',
    pulse: false,
  },
  skipped: {
    label: 'Skipped',
    icon: <SkipForward size={12} />,
    bgColor: 'bg-gray-50',
    textColor: 'text-gray-400',
    borderColor: 'border-gray-200',
    pulse: false,
  },
  'low-confidence': {
    label: 'Low Confidence',
    icon: <AlertCircle size={12} />,
    bgColor: 'bg-amber-50',
    textColor: 'text-amber-600',
    borderColor: 'border-amber-200',
    pulse: false,
  },
};

// ── Feedback modal ────────────────────────────────────────────────────────────

function FeedbackModal({
  pillarName,
  onSubmit,
  onCancel: onModalCancel,
}: {
  pillarName: string;
  onSubmit: (feedback: string) => void;
  onCancel: () => void;
}) {
  const [feedback, setFeedback] = useState('');

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-6">
        <h3 className="text-base font-semibold text-gray-900 mb-1">Inject Feedback</h3>
        <p className="text-sm text-gray-500 mb-4">
          This feedback will be added to the {pillarName} pillar&apos;s input context before it runs.
        </p>
        <textarea
          value={feedback}
          onChange={e => setFeedback(e.target.value)}
          placeholder="e.g. Focus on GDPR compliance. Use PostgreSQL with row-level security. Avoid microservices..."
          className="w-full h-28 text-sm border border-gray-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-gray-900/10"
          autoFocus
        />
        <div className="flex gap-2 mt-4">
          <button
            onClick={onModalCancel}
            className="flex-1 px-4 py-2 text-sm text-gray-600 bg-gray-100 rounded-lg hover:bg-gray-200 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => { if (feedback.trim()) onSubmit(feedback.trim()); }}
            disabled={!feedback.trim()}
            className="flex-1 px-4 py-2 text-sm text-white bg-gray-900 rounded-lg hover:bg-gray-800 disabled:opacity-40 transition-colors"
          >
            Inject & Re-run
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main PillarCard ───────────────────────────────────────────────────────────

export default function PillarCard({
  pillar,
  sessionId: _sessionId,
  onPause,
  onResume,
  // eslint-disable-next-line react/prop-types
  onCancel: _onCancel,
  onRerun,
  onPromoteToCurator,
}: PillarCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [showFeedback, setShowFeedback] = useState(false);
  const config = STATUS_CONFIG[pillar.status];

  const canPause = pillar.status === 'running' || pillar.status === 'queued';
  const canResume = pillar.status === 'paused';
  const canRerun = pillar.status === 'complete' || pillar.status === 'failed' || pillar.status === 'skipped' || pillar.status === 'low-confidence';
  const canPromote = pillar.status === 'complete' || pillar.status === 'low-confidence';
  const showActions = canPause || canResume || canRerun || canPromote;

  return (
    <>
      {showFeedback && (
        <FeedbackModal
          pillarName={pillar.name}
          onSubmit={(feedback) => {
            setShowFeedback(false);
            onRerun?.(pillar.id, feedback);
          }}
          onCancel={() => setShowFeedback(false)}
        />
      )}

      <div className={`rounded-xl border transition-all duration-300 overflow-hidden ${config.borderColor} ${config.bgColor}`}>
        {/* Header row */}
        <div className="flex items-center gap-3 px-4 py-3">
          {/* Status icon */}
          <div className={`${config.textColor} ${config.pulse ? 'animate-pulse' : ''}`}>
            {config.icon}
          </div>

          {/* Pillar name */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-800">{pillar.name}</span>
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${config.bgColor} ${config.textColor} border ${config.borderColor}`}>
                {config.label}
              </span>
              {pillar.status === 'low-confidence' && (
                <span className="text-[9px] text-amber-600 bg-amber-100 px-1.5 py-0.5 rounded-full border border-amber-200">
                  fallback output
                </span>
              )}
            </div>
            {/* Progress sub-line */}
            {pillar.agentCount !== undefined && pillar.status === 'running' && (
              <p className="text-xs text-gray-400 mt-0.5">
                {pillar.completedAgents ?? 0} of {pillar.agentCount} agents complete
              </p>
            )}
            {pillar.qualityScore !== undefined && pillar.status === 'complete' && (
              <p className="text-xs text-gray-400 mt-0.5">
                Quality score: <span className="text-gray-600 font-medium">{pillar.qualityScore}</span>/100
                {pillar.durationMs && ` · ${Math.round(pillar.durationMs / 1000)}s`}
              </p>
            )}
            {pillar.errorMessage && pillar.status === 'failed' && (
              <p className="text-xs text-red-500 mt-0.5 truncate">{pillar.errorMessage}</p>
            )}
          </div>

          {/* Tokens indicator */}
          {pillar.tokensUsed !== undefined && pillar.tokensUsed > 0 && (
            <span className="text-[10px] text-gray-400 font-mono shrink-0">
              {pillar.tokensUsed.toLocaleString()}t
            </span>
          )}

          {/* Actions */}
          {showActions && (
            <div className="flex items-center gap-1 shrink-0">
              {canPause && onPause && (
                <button
                  onClick={() => onPause(pillar.id)}
                  className="p-1.5 rounded-lg hover:bg-white/60 transition-colors text-gray-500 hover:text-gray-700"
                  title="Pause this pillar"
                >
                  <Pause size={12} />
                </button>
              )}
              {canResume && onResume && (
                <button
                  onClick={() => onResume(pillar.id)}
                  className="p-1.5 rounded-lg hover:bg-white/60 transition-colors text-gray-500 hover:text-gray-700"
                  title="Resume this pillar"
                >
                  <Play size={12} />
                </button>
              )}
              {canRerun && (
                <>
                  <button
                    onClick={() => onRerun?.(pillar.id)}
                    className="p-1.5 rounded-lg hover:bg-white/60 transition-colors text-gray-500 hover:text-gray-700"
                    title="Re-run this pillar"
                  >
                    <RotateCcw size={12} />
                  </button>
                  <button
                    onClick={() => setShowFeedback(true)}
                    className="p-1.5 rounded-lg hover:bg-white/60 transition-colors text-gray-500 hover:text-gray-700"
                    title="Re-run with feedback injection"
                  >
                    <MessageSquare size={12} />
                  </button>
                </>
              )}
              {canPromote && onPromoteToCurator && (
                <button
                  onClick={() => onPromoteToCurator(pillar.id)}
                  className="p-1.5 rounded-lg hover:bg-white/60 transition-colors text-purple-500 hover:text-purple-700"
                  title="Promote to Curator for immediate review"
                >
                  <Zap size={12} />
                </button>
              )}
            </div>
          )}

          {/* Expand/collapse for stream preview */}
          {(pillar.streamingPreview || pillar.failedAgents?.length) && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="p-1 text-gray-400 hover:text-gray-600 transition-colors"
            >
              {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          )}
        </div>

        {/* Progress bar for running state */}
        {pillar.status === 'running' && pillar.agentCount && (
          <div className="px-4 pb-2">
            <div className="h-0.5 bg-blue-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-400 rounded-full transition-all duration-500"
                style={{ width: `${Math.round(((pillar.completedAgents ?? 0) / pillar.agentCount) * 100)}%` }}
              />
            </div>
          </div>
        )}

        {/* Expanded content */}
        {expanded && (
          <div className="border-t border-current/10 px-4 py-3">
            {pillar.streamingPreview && (
              <pre className="text-[11px] text-gray-600 font-mono whitespace-pre-wrap break-words leading-relaxed max-h-32 overflow-auto">
                {pillar.streamingPreview}
              </pre>
            )}
            {pillar.failedAgents && pillar.failedAgents.length > 0 && (
              <div className="mt-2">
                <p className="text-[10px] text-red-500 font-mono uppercase tracking-widest mb-1">Failed Agents</p>
                <div className="flex flex-wrap gap-1">
                  {pillar.failedAgents.map(a => (
                    <span key={a} className="text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded font-mono">{a}</span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
