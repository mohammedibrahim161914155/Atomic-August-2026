/**
 * src/components/GenerationBanner.tsx
 *
 * Floating sticky bottom bar — visible on every page EXCEPT /generating.
 * Shows live progress, stop and terminate buttons, and navigates to /generating on click.
 * Answers the user's UX question: the in-progress session should NOT live at the
 * bottom of the Landing page list. It should be a persistent viewport-fixed widget.
 */

import { useGeneration } from '../context/GenerationContext';
import { useLocation, useNavigate } from 'react-router-dom';
import { PILLAR_COUNT } from '../engine/types';
import { Loader2, X, Square } from 'lucide-react';

export function GenerationBanner() {
  const { active, statusMessage, pct, stop, terminate } = useGeneration();
  const location = useLocation();
  const navigate  = useNavigate();

  if (!active || location.pathname === '/generating') return null;

  const segments = PILLAR_COUNT;

  return (
    <div
      className="fixed bottom-0 left-0 right-0 z-50 border-t border-white/10 shadow-2xl"
      style={{ background: '#1c1612' }}
    >
      {/* Thin progress bar along the very top edge */}
      <div className="h-0.5 bg-white/10 w-full">
        <div
          className="h-full bg-rose-500 transition-all duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none"
        onClick={() => navigate('/generating')}
        role="button"
        aria-label="View generation progress"
      >
        {/* Spinner or stopped indicator */}
        {active.stopped ? (
          <Square className="w-3.5 h-3.5 text-gray-500 shrink-0" />
        ) : (
          <Loader2 className="w-3.5 h-3.5 text-rose-400 animate-spin shrink-0" />
        )}

        {/* Status + prompt */}
        <div className="flex-1 min-w-0">
          <p className="text-[11px] font-medium text-white leading-none mb-0.5">
            {statusMessage}
          </p>
          <p className="text-[10px] text-gray-500 truncate leading-none">
            {active.prompt}
          </p>
        </div>

        {/* Segment track — compact version */}
        <div className="hidden sm:flex gap-px shrink-0">
          {Array.from({ length: segments }).map((_, i) => (
            <div
              key={i}
              className={`w-1.5 h-1.5 rounded-sm transition-colors duration-300 ${
                i < active.completedStages
                  ? 'bg-rose-500'
                  : i === active.completedStages
                    ? 'bg-rose-500/40 animate-pulse'
                    : 'bg-white/10'
              }`}
            />
          ))}
        </div>

        <span className="text-[10px] font-mono text-gray-500 shrink-0 hidden sm:block">
          {pct}%
        </span>

        {/* Stop button (graceful — stays on page, shows stopped state) */}
        {!active.stopped && (
          <button
            onClick={(e) => { e.stopPropagation(); stop(); }}
            className="text-[10px] font-medium text-gray-400 hover:text-white
                       border border-white/15 hover:border-white/40
                       rounded px-2 py-1 transition-colors shrink-0"
            title="Stop generation (keeps progress)"
          >
            Stop
          </button>
        )}

        {/* Terminate / dismiss button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            void terminate();
          }}
          className="text-gray-500 hover:text-white transition-colors shrink-0 p-1
                     rounded hover:bg-white/10"
          title={active.stopped ? 'Dismiss' : 'Cancel generation'}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
