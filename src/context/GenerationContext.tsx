/**
 * src/context/GenerationContext.tsx
 *
 * Global SSE generation state — lives at App level so it survives navigation.
 * Any page can read progress; the GenerationBanner shows on non-/generating pages.
 */

import {
  createContext, useContext, useRef, useState, useCallback, useEffect,
  type ReactNode,
} from 'react';
import {
  startGeneration as sseStart,
  resumeGeneration as sseResume,
} from '../lib/sse';
import {
  type EngineEvent, type Blueprint, type GenerationMode, type PipelineType, PILLAR_COUNT,
} from '../engine/types';

// ── State shape ───────────────────────────────────────────────────────────────

export interface ActiveGeneration {
  sessionId:       string | null;
  prompt:          string;
  mode:            GenerationMode;
  pipelineType:    PipelineType;
  completedStages: number;
  stagesStarted:   number;
  prosecutorFired: boolean;
  synthesizerFired:boolean;
  hasGovernor:     boolean;
  error:           string | null;
  isStopping:      boolean;
  stopped:         boolean;
}

export interface GenerationContextValue {
  active:        ActiveGeneration | null;
  statusMessage: string;
  pct:           number;
  start:   (prompt: string, mode: GenerationMode, pipelineType?: PipelineType) => void;
  resume:  (sessionId: string, prompt: string, mode: GenerationMode) => void;
  stop:    () => void;
  terminate: () => void;
  dismiss: () => void;
}

// ── Context ───────────────────────────────────────────────────────────────────

const GenerationContext = createContext<GenerationContextValue | null>(null);

export function useGeneration(): GenerationContextValue {
  const ctx = useContext(GenerationContext);
  if (!ctx) throw new Error('useGeneration must be used inside GenerationProvider');
  return ctx;
}

// ── Provider ──────────────────────────────────────────────────────────────────

interface ProviderProps {
  children:   ReactNode;
  onComplete: (blueprint: Blueprint) => void;
  onReset:    () => void;
}

const PIPELINE_LABELS: Record<PipelineType, string> = {
  'blueprint':      'Blueprint',
  'feature-creator':'Feature',
  'tool-builder':   'Tool',
  'agent-builder':  'Agent',
};

function computeStatus(a: ActiveGeneration): string {
  if (a.stopped)            return 'Generation stopped';
  if (a.error)              return 'Generation failed';
  const label = PIPELINE_LABELS[a.pipelineType] ?? 'Blueprint';
  if (a.synthesizerFired)   return `Assembling your ${label.toLowerCase()} blueprint…`;
  if (a.prosecutorFired)    return 'Reviewing for gaps…';
  if (a.stagesStarted >= PILLAR_COUNT - 1) return 'Finalising analysis…';
  if (a.stagesStarted >= Math.floor(PILLAR_COUNT / 2) + 1) return 'Running deep analysis…';
  if (a.stagesStarted >= 2) return `Examining your ${label.toLowerCase()}…`;
  if (a.stagesStarted >= 1) return 'Analysing requirements…';
  if (a.hasGovernor)        return 'Understanding your requirements…';
  return 'Starting…';
}

const INITIAL: ActiveGeneration = {
  sessionId: null, prompt: '', mode: 'fast', pipelineType: 'blueprint',
  completedStages: 0, stagesStarted: 0,
  prosecutorFired: false, synthesizerFired: false, hasGovernor: false,
  error: null, isStopping: false, stopped: false,
};

export function GenerationProvider({ children, onComplete, onReset }: ProviderProps) {
  const [active, setActive]   = useState<ActiveGeneration | null>(null);
  const cancelRef             = useRef<(() => void) | null>(null);
  const onCompleteRef         = useRef(onComplete);
  const onResetRef            = useRef(onReset);

  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { onResetRef.current    = onReset;    }, [onReset]);

  // ── Event handler (stable reference) ───────────────────────────────────────

  const handleEvent = useCallback((e: EngineEvent) => {
    if (e.type === 'complete') {
      cancelRef.current = null;
      setActive(null);
      if ((e as Record<string, unknown>)['blueprint']) {
        onCompleteRef.current((e as Record<string, unknown>)['blueprint'] as Blueprint);
      }
      return;
    }

    setActive(prev => {
      if (!prev) return prev;
      switch (e.type) {
        case 'session_start':    return { ...prev, sessionId: (e as Record<string, unknown>)['sessionId'] as string ?? prev.sessionId };
        case 'stage_start':     return { ...prev, stagesStarted:   prev.stagesStarted   + 1 };
        case 'stage_complete':  return { ...prev, completedStages: prev.completedStages + 1 };
        case 'prosecutor_start':return { ...prev, prosecutorFired:  true };
        case 'synthesizer_start':return { ...prev, synthesizerFired: true };
        case 'governor_start':  return { ...prev, hasGovernor:       true };
        case 'error':           return { ...prev, error: (e as Record<string, unknown>)['message'] as string ?? 'Generation failed' };
        default:                return prev;
      }
    });
  }, []);

  // ── Public API ─────────────────────────────────────────────────────────────

  const start = useCallback((prompt: string, mode: GenerationMode, pipelineType: PipelineType = 'blueprint') => {
    cancelRef.current?.();
    setActive({ ...INITIAL, prompt, mode, pipelineType });
    cancelRef.current = sseStart(prompt, mode, handleEvent, pipelineType);
  }, [handleEvent]);

  const resume = useCallback((sessionId: string, prompt: string, mode: GenerationMode) => {
    cancelRef.current?.();
    setActive({ ...INITIAL, sessionId, prompt, mode, pipelineType: 'blueprint' });
    cancelRef.current = sseResume(sessionId, handleEvent);
  }, [handleEvent]);

  const stop = useCallback(() => {
    setActive(prev => prev ? { ...prev, isStopping: true } : null);

    const currentSessionId = (() => {
      let id: string | null = null;
      setActive(prev => { id = prev?.sessionId ?? null; return prev; });
      return id;
    })();

    if (currentSessionId) {
      fetch(`/api/v1/sessions/${currentSessionId}/abort`, { method: 'POST' }).catch(() => {});
    }

    cancelRef.current?.();
    cancelRef.current = null;
    setActive(prev =>
      prev ? { ...prev, isStopping: false, stopped: true, error: null } : null
    );
  }, []);

  const terminate = useCallback(() => {
    setActive(prev => {
      if (prev?.sessionId) {
        fetch(`/api/v1/sessions/${prev.sessionId}/abort`, { method: 'POST' }).catch(() => {});
      }
      return null;
    });
    cancelRef.current?.();
    cancelRef.current = null;
    onResetRef.current();
  }, []);

  const dismiss = useCallback(() => {
    cancelRef.current?.();
    cancelRef.current = null;
    setActive(null);
  }, []);

  // ── Derived values ─────────────────────────────────────────────────────────

  const statusMessage = active ? computeStatus(active) : '';
  const pct = active ? Math.round((active.completedStages / PILLAR_COUNT) * 100) : 0;

  return (
    <GenerationContext.Provider value={{ active, statusMessage, pct, start, resume, stop, terminate, dismiss }}>
      {children}
    </GenerationContext.Provider>
  );
}
