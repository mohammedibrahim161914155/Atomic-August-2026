import React, { Component, ErrorInfo, ReactNode } from 'react';
import { AlertCircle, RefreshCw, Home } from 'lucide-react';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  children:  ReactNode;
  /**
   * Optional custom fallback renderer. Receives the caught error and a reset
   * callback. Use this to show an inline / route-scoped error state instead
   * of the full-screen crash page.
   */
  fallback?: (error: Error, reset: () => void) => ReactNode;
  /** Called after the boundary resets its own state. */
  onReset?:  () => void;
  /**
   * Human-readable name shown in the inline (route-scoped) fallback UI.
   * Providing this prop automatically switches to the compact inline layout
   * instead of the full-screen layout.
   */
  label?:    string;
}

interface State {
  hasError: boolean;
  error:    Error | null;
}

// ── Component ─────────────────────────────────────────────────────────────────

/**
 * ErrorBoundary — catches render / lifecycle errors in the component subtree.
 *
 * Three usage patterns:
 *   1. Root boundary   — no extra props → full-screen crash page.
 *   2. Route boundary  — `label` prop   → compact inline error card per route.
 *   3. Custom fallback — `fallback` prop → caller controls the UI completely.
 *
 * Does NOT catch errors in event handlers, async functions, or SSR.
 * Wrap those separately with try / catch.
 */
export class ErrorBoundary extends Component<Props, State> {
  public state: State = { hasError: false, error: null };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, info: ErrorInfo) {
    if (process.env.NODE_ENV !== 'production') {
      console.error('[ErrorBoundary] Uncaught render error:', error, info.componentStack);
    } else {
      console.error('[ErrorBoundary]', error.message);
    }
  }

  private reset = () => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  private goHome = () => {
    this.setState({ hasError: false, error: null });
    window.location.href = '/';
  };

  public render() {
    if (!this.state.hasError) return this.props.children;

    const safeError = this.state.error ?? new Error('Unknown error');

    // ── Custom fallback ───────────────────────────────────────────────────────
    if (this.props.fallback) {
      return <>{this.props.fallback(safeError, this.reset)}</>;
    }

    // ── Route-scoped fallback (compact inline card) ───────────────────────────
    if (this.props.label) {
      return (
        <div className="flex flex-col items-center justify-center min-h-[50vh] p-8 text-center">
          <div className="max-w-sm w-full bg-white border border-red-200 rounded-2xl
                          p-6 shadow-sm space-y-4">
            <div className="flex items-center justify-center gap-2 text-red-500">
              <AlertCircle size={20} />
              <span className="font-semibold text-sm">{this.props.label} failed to load</span>
            </div>
            <p className="text-xs text-gray-500 leading-relaxed">
              Something went wrong rendering this page. You can try again or go back to the
              home screen.
            </p>
            {process.env.NODE_ENV !== 'production' && (
              <pre className="text-left text-[10px] bg-red-50 text-red-600 rounded-lg p-3
                              overflow-x-auto font-mono whitespace-pre-wrap break-all">
                {safeError.message}
              </pre>
            )}
            <div className="flex gap-2">
              <button
                onClick={this.reset}
                className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg
                           bg-gray-900 text-white text-xs font-semibold hover:bg-gray-700
                           transition-colors"
              >
                <RefreshCw size={12} /> Try again
              </button>
              <button
                onClick={this.goHome}
                className="flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg
                           border border-gray-200 text-gray-600 text-xs font-medium
                           hover:bg-gray-50 transition-colors"
              >
                <Home size={12} /> Home
              </button>
            </div>
          </div>
        </div>
      );
    }

    // ── Root fallback (full-screen) ───────────────────────────────────────────
    return (
      <div className="min-h-screen bg-[#0a0a08] flex items-center justify-center p-6 text-zinc-200">
        <div className="max-w-md w-full bg-[#121210] border border-red-500/30 rounded-xl
                        p-8 space-y-6">
          <div className="flex items-center gap-3 text-red-400">
            <AlertCircle size={32} />
            <h1 className="text-2xl font-serif font-bold">Application Error</h1>
          </div>
          <p className="text-sm text-zinc-400">
            An unexpected error occurred. Please refresh and try again, or return to the home
            screen.
          </p>
          <div className="p-4 bg-black/50 rounded-lg border border-[#2e2e2a] overflow-x-auto">
            <pre className="text-xs text-red-300 font-mono whitespace-pre-wrap break-all">
              {safeError.message}
            </pre>
          </div>
          <div className="flex gap-3">
            <button
              onClick={this.reset}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-lg
                         bg-zinc-700 text-white text-sm font-semibold hover:bg-zinc-600
                         transition-colors"
            >
              <RefreshCw size={15} /> Try again
            </button>
            <button
              onClick={this.goHome}
              className="flex-1 flex items-center justify-center gap-2 py-3 rounded-lg
                         bg-amber-500 text-black text-sm font-semibold hover:bg-amber-400
                         transition-colors"
            >
              <Home size={15} /> Go home
            </button>
          </div>
        </div>
      </div>
    );
  }
}
