/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, lazy, Suspense, useEffect } from 'react';
import { Routes, Route, useNavigate, Link, useLocation } from 'react-router-dom';
import { useOnboarding } from './hooks/useOnboarding';
import { Blueprint, GenerationMode, PipelineType } from './engine/types';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Settings as SettingsIcon, BookOpen, MessageSquare, Terminal } from 'lucide-react';
import { GenerationProvider, useGeneration } from './context/GenerationContext';
import { GenerationBanner } from './components/GenerationBanner';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import DevPanel from './components/DevPanel';

const Landing      = lazy(() => import('./pages/Landing'));
const Generating   = lazy(() => import('./pages/Generating'));
const BlueprintView = lazy(() => import('./pages/Blueprint'));
const History      = lazy(() => import('./pages/History'));
const Compare      = lazy(() => import('./pages/Compare'));
const Settings     = lazy(() =>
  import('./pages/Settings').then(m => ({ default: m.Settings }))
);
const Onboarding   = lazy(() => import('./pages/Onboarding'));
const Chat         = lazy(() => import('./pages/Chat'));

const Loader = () => (
  <div className="flex items-center justify-center min-h-screen">
    <div className="animate-pulse text-rose-900 font-mono">Loading…</div>
  </div>
);

// ── Inner shell — has access to GenerationContext ──────────────────────────────

function AppShell({
  blueprint,
  setBlueprint,
  onReset,
}: {
  blueprint:    Blueprint | null;
  setBlueprint: (b: Blueprint) => void;
  onReset:      () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const ctx      = useGeneration();

  // ── Navigation handlers ────────────────────────────────────────────────────

  const handleStart = useCallback((p: string, m: GenerationMode, pt: PipelineType = 'blueprint') => {
    ctx.start(p, m, pt);
    navigate('/generating');
  }, [ctx, navigate]);

  const handleResume = useCallback(async (id: string) => {
    let prompt = '';
    let mode: GenerationMode = 'safe';
    try {
      const res = await fetch(`/api/v1/sessions/${id}`);
      if (res.ok) {
        const data = await res.json();
        if (data.session?.prompt) prompt = data.session.prompt;
        if (data.session?.mode)   mode   = data.session.mode;
      }
    } catch { /* use defaults — resume still works */ }
    ctx.resume(id, prompt, mode);
    navigate('/generating');
  }, [ctx, navigate]);

  const handleUpload = useCallback((b: Blueprint) => {
    setBlueprint(b);
    navigate('/blueprint');
  }, [setBlueprint, navigate]);

  const handleLoadFromHistory = useCallback((b: Blueprint) => {
    setBlueprint(b);
    navigate('/blueprint');
  }, [setBlueprint, navigate]);

  // ── Global keyboard shortcuts ──────────────────────────────────────────────
  useKeyboardShortcuts({
    'mod+k': () => navigate('/'),
    'mod+n': () => { onReset(); navigate('/'); },
    'mod+j': () => navigate('/chat'),
    'mod+h': () => navigate('/history'),
    'mod+,': () => navigate('/settings'),
    'mod+b': () => { if (blueprint) navigate('/blueprint'); },
    'mod+g': () => { if (ctx.active) navigate('/generating'); },
    'escape': () => {
      if (['/settings', '/history', '/compare'].includes(location.pathname)) {
        navigate(-1);
      }
    },
  });

  const hideNav = ['/settings', '/history', '/compare', '/chat'].includes(location.pathname);

  // Developer mode — read from settings API, cached in localStorage for speed
  const [devMode, setDevMode] = useState<boolean>(() => {
    try { return localStorage.getItem('atomic_dev_mode') === 'true'; } catch { return false; }
  });
  const [showDevPanel, setShowDevPanel] = useState(false);

  useEffect(() => {
    fetch('/api/v1/settings')
      .then(r => r.ok ? r.json() : null)
      .then((d: { settings?: { system?: { developerMode?: boolean } } } | null) => {
        const on = d?.settings?.system?.developerMode ?? false;
        setDevMode(on);
        try { localStorage.setItem('atomic_dev_mode', String(on)); } catch { /* ok */ }
      })
      .catch(() => { /* use cached value */ });
  }, []);

  // Active session id for DevPanel
  const sessionId = ctx.active?.sessionId ?? undefined;

  return (
    <div
      className="min-h-screen text-black font-sans selection:bg-rose-900/30 relative"
      style={{ background: '#f5f4f0' }}
    >
      {/* Top-right nav (hidden on full-page panel views) */}
      {!hideNav && (
        <div className="absolute top-6 right-6 z-50 flex items-center gap-2">
          <Link
            to="/chat"
            className="p-2 text-gray-400 hover:text-gray-600
                       hover:bg-gray-100 rounded-full transition-colors
                       flex items-center gap-2"
            title="Chat (Artemis / Curator / General)"
          >
            <MessageSquare className="w-5 h-5" />
            <span className="text-sm font-medium hidden sm:inline">Chat</span>
          </Link>
          <Link
            to="/history"
            className="p-2 text-gray-400 hover:text-gray-600
                       hover:bg-gray-100 rounded-full transition-colors
                       flex items-center gap-2"
            title="History (⌘H)"
          >
            <BookOpen className="w-5 h-5" />
            <span className="text-sm font-medium hidden sm:inline">History</span>
          </Link>
          <Link
            to="/settings"
            className="p-2 text-gray-400 hover:text-gray-600
                       hover:bg-gray-100 rounded-full transition-colors
                       flex items-center gap-2"
            title="Settings (⌘,)"
          >
            <SettingsIcon className="w-5 h-5" />
            <span className="text-sm font-medium hidden sm:inline">Settings</span>
          </Link>
          {/* Developer mode toggle */}
          {devMode && (
            <button
              onClick={() => setShowDevPanel(v => !v)}
              className={`p-2 rounded-full transition-colors flex items-center gap-2
                          ${showDevPanel
                            ? 'bg-gray-900 text-white'
                            : 'text-gray-400 hover:text-gray-600 hover:bg-gray-100'}`}
              title="Dev Panel (traces · events · metrics)"
            >
              <Terminal className="w-5 h-5" />
              <span className="text-sm font-medium hidden sm:inline">Dev</span>
            </button>
          )}
        </div>
      )}

      <Suspense fallback={<Loader />}>
        <Routes>
          <Route
            path="/"
            element={
              <ErrorBoundary label="Home">
                <Landing
                  onStart={handleStart}
                  onResume={handleResume}
                  onUpload={handleUpload}
                />
              </ErrorBoundary>
            }
          />
          <Route
            path="/generating"
            element={
              <ErrorBoundary label="Generation" onReset={onReset}>
                <Generating onReset={onReset} />
              </ErrorBoundary>
            }
          />
          <Route
            path="/blueprint"
            element={
              <ErrorBoundary label="Blueprint viewer" onReset={onReset}>
                {blueprint
                  ? <BlueprintView blueprint={blueprint} onReset={onReset} />
                  : <Landing
                      onStart={handleStart}
                      onResume={handleResume}
                      onUpload={handleUpload}
                    />
                }
              </ErrorBoundary>
            }
          />
          <Route
            path="/settings"
            element={
              <ErrorBoundary label="Settings">
                <Settings />
              </ErrorBoundary>
            }
          />
          <Route
            path="/history"
            element={
              <ErrorBoundary label="History">
                <History
                  onLoad={handleLoadFromHistory}
                  onBack={() => navigate(-1)}
                />
              </ErrorBoundary>
            }
          />
          <Route
            path="/compare"
            element={
              <ErrorBoundary label="Compare">
                <Compare />
              </ErrorBoundary>
            }
          />
          <Route
            path="/chat"
            element={
              <ErrorBoundary label="Chat">
                <Chat />
              </ErrorBoundary>
            }
          />
        </Routes>
      </Suspense>

      {/* Floating generation progress bar — visible on all non-/generating pages */}
      <GenerationBanner />

      {/* Developer panel — only when devMode is on and toggled open */}
      {devMode && showDevPanel && (
        <DevPanel sessionId={sessionId} onClose={() => setShowDevPanel(false)} />
      )}
    </div>
  );
}

// ── Root App — provides generation context ─────────────────────────────────────

export default function App() {
  const navigate = useNavigate();
  const { shouldShow, complete } = useOnboarding();

  const [blueprint, setBlueprint] = useState<Blueprint | null>(null);

  const handleComplete = useCallback((b: Blueprint) => {
    setBlueprint(b);
    navigate('/blueprint');
  }, [navigate]);

  const handleReset = useCallback(() => {
    setBlueprint(null);
    navigate('/');
  }, [navigate]);

  if (shouldShow) {
    return (
      <ErrorBoundary>
        <Suspense fallback={<Loader />}>
          <Onboarding onComplete={complete} />
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <GenerationProvider onComplete={handleComplete} onReset={handleReset}>
        <AppShell
          blueprint={blueprint}
          setBlueprint={setBlueprint}
          onReset={handleReset}
        />
      </GenerationProvider>
    </ErrorBoundary>
  );
}
