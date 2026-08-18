/**
 * src/pages/Blueprint.tsx
 *
 * Blueprint viewer — Claude-inspired design:
 * dark header bar, warm off-white body, white section cards, light TOC sidebar.
 * Preserves all functionality: rating, notes, pillar re-run, export (MD/JSON/HTML).
 */

import { useState, memo, useCallback, useRef, useEffect } from 'react';
import { Blueprint } from '../engine/types';
import Markdown from 'react-markdown';
import {
  Copy, Download, RefreshCw, ChevronDown, ChevronRight,
  AlertTriangle, Star, MessageSquare, Printer,
  BookOpen, Layers, History, X,
} from 'lucide-react';
import { VersionHistory } from '../components/VersionHistory';
import { startRerunPillar } from '../lib/sse';
import { EngineEvent } from '../engine/types';
import {
  pluginRegistry,
  initBuiltInPlugins,
  toSdkBlueprint,
} from '../plugins';

// ── Helpers ───────────────────────────────────────────────────────────────────

const MemoizedMarkdown = memo(function MemoizedMarkdown({ content }: { content: string }) {
  return <Markdown>{content}</Markdown>;
});

function sectionTitle(key: string) {
  return key.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function qualityLabel(score: number) {
  if (score >= 90) return { color: 'text-emerald-600', bg: 'bg-emerald-50 border-emerald-200', label: 'Excellent' };
  if (score >= 80) return { color: 'text-amber-600',   bg: 'bg-amber-50 border-amber-200',   label: 'Good' };
  return                 { color: 'text-red-600',      bg: 'bg-red-50 border-red-200',       label: 'Needs work' };
}

// ── Star Rating ───────────────────────────────────────────────────────────────

interface StarRatingProps {
  rating:      number | undefined;
  blueprintId: string;
  onRate:      (r: number | null) => void;
}

function StarRating({ rating, blueprintId, onRate }: StarRatingProps) {
  const [hovered, setHovered] = useState<number | null>(null);
  const [saving,  setSaving]  = useState(false);

  const handleClick = async (star: number) => {
    const newRating = rating === star ? null : star;
    setSaving(true);
    try {
      const res = await fetch(`/api/v1/blueprints/${blueprintId}/rating`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: newRating }),
      });
      if (res.ok) onRate(newRating);
    } finally { setSaving(false); }
  };

  const display = hovered ?? rating ?? 0;

  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(s => (
        <button
          key={s}
          onClick={() => handleClick(s)}
          onMouseEnter={() => setHovered(s)}
          onMouseLeave={() => setHovered(null)}
          disabled={saving}
          className="p-0.5 transition-transform hover:scale-110 disabled:opacity-50"
        >
          <Star
            size={15}
            className={display >= s ? 'text-amber-400 fill-amber-400' : 'text-gray-300 hover:text-amber-300'}
          />
        </button>
      ))}
    </div>
  );
}

// ── Section Note ──────────────────────────────────────────────────────────────

interface SectionNoteProps {
  blueprintId: string;
  sectionKey:  string;
  initialNote: string;
}

function SectionNote({ blueprintId, sectionKey, initialNote }: SectionNoteProps) {
  const [open,   setOpen]   = useState(false);
  const [note,   setNote]   = useState(initialNote);
  const [saved,  setSaved]  = useState(true);
  const [saving, setSaving] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleChange = (val: string) => {
    setNote(val); setSaved(false);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      setSaving(true);
      try {
        await fetch(`/api/v1/blueprints/${blueprintId}/note`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sectionKey, note: val }),
        });
        setSaved(true);
      } finally { setSaving(false); }
    }, 800);
  };

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  return (
    <div className="mt-5 pt-5 border-t border-gray-100">
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 text-xs transition-colors ${
          note ? 'text-amber-600 hover:text-amber-700' : 'text-gray-400 hover:text-gray-600'
        }`}
      >
        <MessageSquare size={12} />
        {note ? 'View note' : 'Add note'}
        {note && <span className="w-1.5 h-1.5 rounded-full bg-amber-400 inline-block ml-0.5" />}
      </button>

      {open && (
        <div className="mt-2">
          <textarea
            value={note}
            onChange={e => handleChange(e.target.value)}
            placeholder={`Notes for ${sectionTitle(sectionKey)}…`}
            rows={4}
            className="w-full text-sm border border-gray-200 rounded-xl p-3 resize-y
                       focus:outline-none focus:ring-2 focus:ring-gray-900/10 focus:border-gray-300
                       placeholder-gray-400 text-gray-800 bg-gray-50"
          />
          <div className="text-[10px] text-gray-400 mt-1">
            {saving ? 'Saving…' : saved ? '✓ Saved' : 'Unsaved changes'}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

interface Props {
  blueprint:   Blueprint;
  onReset:     () => void;
  savedNotes?: Record<string, string>;
}

export default function BlueprintView({ blueprint, onReset, savedNotes = {} }: Props) {
  const [expandedPillars,  setExpandedPillars]  = useState<Record<string, boolean>>({});
  const [currentBlueprint, setCurrentBlueprint] = useState(blueprint);
  const [rating,           setRating]           = useState<number | undefined>(undefined);
  const [rerunningPillar,  setRerunningPillar]  = useState<string | null>(null);
  const [rerunError,       setRerunError]       = useState<string | null>(null);
  const [exportingHtml,    setExportingHtml]    = useState(false);
  const [sidebarOpen,        setSidebarOpen]        = useState(true);
  const [showVersionHistory, setShowVersionHistory] = useState(false);
  const [pluginNotice,       setPluginNotice]       = useState<string | null>(null);
  const [pushingTo,          setPushingTo]          = useState<string | null>(null);
  const cancelRerunRef = useRef<(() => void) | null>(null);

  // v2.4.0 — register the built-in client plugins (Markdown / Linear / Notion
  // exporters) once when the blueprint view mounts. `register()` is idempotent,
  // so this is safe across repeated mounts.
  useEffect(() => {
    initBuiltInPlugins();
    // Give the export pipeline the live blueprint so runExport produces a
    // version-aware document instead of a stale snapshot. The engine's
    // internal blueprint shape is adapted to the SDK blueprint model used by
    // the client plugin platform.
    pluginRegistry.setBlueprint(toSdkBlueprint(blueprint));
  }, [blueprint]);

  const togglePillar = useCallback((p: string) => {
    setExpandedPillars(prev => ({ ...prev, [p]: !prev[p] }));
  }, []);

  const downloadMd = useCallback(async () => {
    // v2.4.0 — Markdown export is now routed through the hardened plugin
    // registry (runExport runs the 'built-in/export-markdown' plugin, which
    // executes registered transforms and honors plugin enable state). If the
    // plugin registry is unavailable for any reason we fall back to the plain
    // inline rendering so export is never broken.
    try {
      const exported = await pluginRegistry.runExport('built-in/export-markdown');
      const md = exported instanceof Blob
        ? await exported.text()
        : (exported ?? String(exported ?? ''));
      if (md) {
        triggerDownload(URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), `blueprint-${currentBlueprint.id}.md`);
        setPluginNotice('Exported via plugin pipeline');
      } else {
        throw new Error('empty export');
      }
    } catch {
      let md = `# ${currentBlueprint.intent?.product_name ?? 'Blueprint'}\n\n`;
      md += `**Generated:** ${new Date(currentBlueprint.created_at).toLocaleString()}\n`;
      md += `**Quality Score:** ${currentBlueprint.quality_score}/100\n\n`;
      md += `> ${currentBlueprint.prompt}\n\n---\n\n`;
      Object.entries(currentBlueprint.sections).forEach(([key, content]) => {
        md += `## ${sectionTitle(key)}\n\n${content}\n\n`;
      });
      triggerDownload(URL.createObjectURL(new Blob([md], { type: 'text/markdown' })), `blueprint-${currentBlueprint.id}.md`);
      setPluginNotice('Exported (fallback render)');
    }
  }, [currentBlueprint]);

  // v2.4.0 — push the blueprint to an external project tracker (Linear / Notion)
  // through the registry's runPush pipeline (retryable HTTP, 429 backoff).
  const pushTo = useCallback(async (pluginId: 'built-in/export-linear' | 'built-in/export-notion') => {
    setPushingTo(pluginId);
    setPluginNotice(null);
    try {
      pluginRegistry.setBlueprint(toSdkBlueprint(blueprint));
      const result = await pluginRegistry.runPush(pluginId);
      if (result?.url) {
        setPluginNotice(`Pushed to ${pluginId === 'built-in/export-linear' ? 'Linear' : 'Notion'}: ${result.url}`);
      } else if (result?.id) {
        setPluginNotice(`Created ${pluginId === 'built-in/export-linear' ? 'Linear issue' : 'Notion page'} (${result.id}) — requires API key in Plugins panel`);
      } else {
        setPluginNotice(`No configuration found for ${pluginId === 'built-in/export-linear' ? 'Linear' : 'Notion'} — open the Plugins panel to add your API key`);
      }
    } catch {
      setPluginNotice(`Push to ${pluginId === 'built-in/export-linear' ? 'Linear' : 'Notion'} failed — check your API key and try again`);
    } finally {
      setPushingTo(null);
    }
  }, [blueprint]);


  const downloadHtml = useCallback(async () => {
    setExportingHtml(true);
    try {
      const id  = currentBlueprint.id;
      const res = await fetch(`/api/v1/blueprints/${id}/export?format=html`);
      if (res.ok) {
        const blob = new Blob([await res.text()], { type: 'text/html' });
        triggerDownload(URL.createObjectURL(blob), `blueprint-${id}.html`);
      } else {
        const res2 = await fetch('/api/v1/blueprints/export-inline?format=html', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ blueprint: currentBlueprint }),
        });
        if (!res2.ok) throw new Error('Export failed');
        const blob = new Blob([await res2.text()], { type: 'text/html' });
        triggerDownload(URL.createObjectURL(blob), `blueprint-${id}.html`);
      }
    } catch { window.print(); }
    finally { setExportingHtml(false); }
  }, [currentBlueprint]);

  const copyJson = useCallback(() => {
    navigator.clipboard.writeText(JSON.stringify(currentBlueprint, null, 2));
  }, [currentBlueprint]);

  const rerunPillar = useCallback((pillarName: string) => {
    if (rerunningPillar) return;
    setRerunningPillar(pillarName); setRerunError(null);
    const target = currentBlueprint.session_id ?? currentBlueprint;
    const cancel = startRerunPillar(pillarName, target, (event: EngineEvent) => {
      if (event.type === 'rerun_complete') {
        setCurrentBlueprint((event as any).blueprint!);
        setRerunningPillar(null);
      } else if (event.type === 'error') {
        setRerunError(event.message); setRerunningPillar(null);
      }
    });
    cancelRerunRef.current = cancel;
  }, [rerunningPillar, currentBlueprint]);

  const blueprintId = currentBlueprint.id;
  const ql = qualityLabel(currentBlueprint.quality_score);
  const sections = Object.entries(currentBlueprint.sections);

  return (
    <div className="flex flex-col h-screen" style={{ background: '#f5f4f0' }}>

      {/* Re-run error */}
      {rerunError && (
        <div className="shrink-0 px-6 py-2.5 bg-red-50 border-b border-red-200
                        flex items-center gap-2 text-red-600 text-sm">
          <AlertTriangle size={13} className="shrink-0" />
          <span>Re-run failed: {rerunError}</span>
          <button onClick={() => setRerunError(null)} className="ml-auto text-red-400 hover:text-red-600">✕</button>
        </div>
      )}

      {/* ── Dark header ─────────────────────────────────────────────── */}
      <header
        className="h-14 flex items-center justify-between px-5 shrink-0"
        style={{ background: '#1c1612' }}
      >
        {/* Left: logo + breadcrumb */}
        <div className="flex items-center gap-3 min-w-0">
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="p-1.5 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/10
                       transition-colors shrink-0"
          >
            <Layers size={14} />
          </button>
          <span className="font-mono font-bold text-white text-sm tracking-tighter shrink-0">ATOMIC</span>
          <span className="text-white/30 shrink-0">/</span>
          <span className="text-white/60 text-xs truncate max-w-xs italic">
            &ldquo;{currentBlueprint.prompt}&rdquo;
          </span>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-1.5 shrink-0 ml-4">
          <button
            onClick={copyJson}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                       text-white/60 hover:text-white hover:bg-white/10 transition-colors"
          >
            <Copy size={12} /> JSON
          </button>
          <button
            onClick={downloadMd}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                       text-white/60 hover:text-white hover:bg-white/10 transition-colors"
          >
            <Download size={12} /> Markdown
          </button>
          {/* v2.4.0 — push the blueprint to Linear / Notion via the plugin pipeline */}
          <button
            onClick={() => pushTo('built-in/export-linear')}
            disabled={pushingTo !== null}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                       text-white/60 hover:text-white hover:bg-white/10 transition-colors
                       disabled:opacity-40"
            title="Push blueprint to Linear (retryable API, 429-aware)"
          >
            {pushingTo === 'built-in/export-linear' ? <RefreshCw size={12} className="animate-spin" /> : <Layers size={12} />}
            {pushingTo === 'built-in/export-linear' ? 'Pushing…' : 'Linear'}
          </button>
          <button
            onClick={() => pushTo('built-in/export-notion')}
            disabled={pushingTo !== null}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                       text-white/60 hover:text-white hover:bg-white/10 transition-colors
                       disabled:opacity-40"
            title="Push blueprint to Notion (retryable API, 429-aware)"
          >
            {pushingTo === 'built-in/export-notion' ? <RefreshCw size={12} className="animate-spin" /> : <BookOpen size={12} />}
            {pushingTo === 'built-in/export-notion' ? 'Pushing…' : 'Notion'}
          </button>
          <button
            onClick={downloadHtml}
            disabled={exportingHtml}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                       text-white/60 hover:text-white hover:bg-white/10 transition-colors
                       disabled:opacity-40"
          >
            <Printer size={12} /> {exportingHtml ? 'Exporting…' : 'Export PDF'}
          </button>
          <div className="w-px h-5 bg-white/15 mx-1" />
          <button
            onClick={() => setShowVersionHistory(v => !v)}
            className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg transition-colors
                        ${showVersionHistory
                          ? 'bg-violet-500/30 text-violet-200'
                          : 'text-white/60 hover:text-white hover:bg-white/10'}`}
            title="Version History"
          >
            <History size={12} /> History
          </button>
          <div className="w-px h-5 bg-white/15 mx-1" />
          <button
            onClick={onReset}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg
                       bg-white/10 text-white hover:bg-white/20 transition-colors font-medium"
          >
            <RefreshCw size={12} /> New Blueprint
          </button>
        </div>
      </header>
      {/* ── v2.4.0 plugin notice toast (export/push feedback) ─────── */}
      {pluginNotice && (
        <div
          className="fixed top-5 left-1/2 -translate-x-1/2 z-[110] max-w-md px-4 py-2.5 rounded-xl shadow-2xl
                      bg-white border border-gray-200 text-xs font-medium text-gray-700
                      flex items-center gap-2 animate-in fade-in slide-in-from-top-2 duration-200"
          role="status" aria-live="polite"
          onClick={() => setPluginNotice(null)}
        >
          <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
          {pluginNotice}
        </div>
      )}
      {/* ── Version History slide-over ──────────────────────────────── */}
      {showVersionHistory && (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowVersionHistory(false)}
          />
          {/* Panel */}
          <div className="relative w-[420px] max-w-full h-full bg-white shadow-2xl flex flex-col overflow-hidden">
            <div
              className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0"
              style={{ background: '#1c1612' }}
            >
              <div className="flex items-center gap-2 text-white">
                <History size={14} />
                <span className="text-sm font-semibold">Version History</span>
              </div>
              <button
                onClick={() => setShowVersionHistory(false)}
                className="p-1.5 rounded-lg text-white/40 hover:text-white hover:bg-white/10 transition-colors"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              <VersionHistory
                blueprintId={blueprintId}
                onRestore={() => {
                  setShowVersionHistory(false);
                  window.location.reload();
                }}
                onPreview={(vn) => {
                  console.log('[Blueprint] preview version', vn);
                }}
              />
            </div>
          </div>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">

        {/* ── TOC Sidebar ──────────────────────────────────────────── */}
        {sidebarOpen && (
          <aside className="w-56 shrink-0 hidden lg:flex flex-col border-r border-gray-200 bg-white">
            <div className="flex-1 overflow-y-auto py-5 px-4">
              <p className="text-[9px] font-semibold uppercase tracking-widest text-gray-400 mb-4
                            flex items-center gap-1.5">
                <BookOpen size={10} /> Contents
              </p>
              <ul className="space-y-1">
                {sections.map(([key]) => (
                  <li key={key}>
                    <a
                      href={`#${key}`}
                      className="block text-xs text-gray-500 hover:text-gray-900 py-1 px-2
                                 rounded-lg hover:bg-gray-100 transition-colors truncate"
                    >
                      {sectionTitle(key)}
                    </a>
                  </li>
                ))}
                <li>
                  <a
                    href="#raw-outputs"
                    className="block text-xs text-gray-400 hover:text-gray-700 py-1 px-2
                               rounded-lg hover:bg-gray-100 transition-colors"
                  >
                    Raw Agent Outputs
                  </a>
                </li>
              </ul>
            </div>
          </aside>
        )}

        {/* ── Main Content ──────────────────────────────────────────── */}
        <main className="flex-1 overflow-y-auto scroll-smooth">
          <div className="max-w-3xl mx-auto px-6 py-8 space-y-5">

            {/* Metadata panel */}
            <div className="bg-white rounded-2xl border border-gray-200 p-6">
              <div className="flex items-start justify-between gap-4 flex-wrap">
                <div>
                  <h1 className="text-xl font-bold text-gray-900 mb-0.5">
                    {currentBlueprint.intent?.product_name ?? 'Blueprint'}
                  </h1>
                  <p className="text-sm text-gray-400 italic">
                    {currentBlueprint.intent?.domain}
                  </p>
                </div>
                <div className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-sm font-bold ${ql.bg} ${ql.color}`}>
                  <span className="font-mono text-xl">{currentBlueprint.quality_score}</span>
                  <span className="text-xs font-medium opacity-80">{ql.label}</span>
                </div>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-5 pt-5 border-t border-gray-100">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1">Gaps Found</p>
                  <p className="text-2xl font-mono text-gray-800">{currentBlueprint.prosecutor.gaps_found ?? 0}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1">Time</p>
                  <p className="text-2xl font-mono text-gray-800">
                    {(currentBlueprint.generation_time_ms / 1000).toFixed(1)}s
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-1">
                    Cost {currentBlueprint.estimated_cost_approximate && '(est.)'}
                  </p>
                  <p className="text-2xl font-mono text-gray-800">
                    {currentBlueprint.estimated_cost_usd
                      ? `$${currentBlueprint.estimated_cost_usd.toFixed(3)}`
                      : '—'}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Your Rating</p>
                  <StarRating
                    rating={rating}
                    blueprintId={blueprintId}
                    onRate={r => setRating(r ?? undefined)}
                  />
                </div>
              </div>
            </div>

            {/* Sections */}
            {sections.map(([key, content], index) => (
              <section key={key} id={key} className="scroll-mt-6">
                <div className="bg-white rounded-2xl border border-gray-200 p-7">
                  <div className="flex items-baseline gap-3 mb-6">
                    <span className="font-mono text-[11px] font-bold text-gray-300 shrink-0 w-6">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <h2 className="text-lg font-bold text-gray-900">{sectionTitle(key)}</h2>
                  </div>
                  <div className="prose prose-sm prose-gray max-w-none
                                  prose-headings:font-semibold prose-headings:text-gray-900
                                  prose-a:text-rose-900 prose-code:text-rose-700
                                  prose-pre:bg-gray-50 prose-pre:border prose-pre:border-gray-200
                                  prose-pre:rounded-xl prose-blockquote:border-gray-200">
                    <MemoizedMarkdown content={content as string} />
                  </div>
                  <SectionNote
                    blueprintId={blueprintId}
                    sectionKey={key}
                    initialNote={savedNotes[key] ?? ''}
                  />
                </div>
              </section>
            ))}

            {/* Raw Agent Outputs */}
            <section id="raw-outputs" className="scroll-mt-6">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400 mb-3 px-1">
                Raw Agent Outputs
              </h2>
              <div className="space-y-2">
                {Object.entries(currentBlueprint.pillars).map(([pillarName, pillar]) => (
                  <div key={pillarName} className="bg-white rounded-2xl border border-gray-200 overflow-hidden">
                    <div className="flex items-stretch">
                      <button
                        onClick={() => togglePillar(pillarName)}
                        className="flex-1 flex items-center justify-between px-5 py-4
                                   hover:bg-gray-50 transition-colors text-left"
                      >
                        <div className="flex items-center gap-2.5">
                          {rerunningPillar === pillarName && (
                            <RefreshCw size={12} className="text-rose-900 animate-spin shrink-0" />
                          )}
                          <span className="text-sm font-semibold text-gray-800">
                            {pillarName.split('_').map((w: string) =>
                              w.charAt(0).toUpperCase() + w.slice(1)
                            ).join(' ')}
                          </span>
                          {(pillar as any).failed_agents?.length > 0 && (
                            <span className="text-[10px] px-2 py-0.5 bg-amber-100 text-amber-700
                                             rounded-full font-medium">
                              {(pillar as any).failed_agents.length} degraded
                            </span>
                          )}
                        </div>
                        {expandedPillars[pillarName]
                          ? <ChevronDown size={15} className="text-gray-400" />
                          : <ChevronRight size={15} className="text-gray-400" />}
                      </button>
                      <button
                        onClick={() => rerunPillar(pillarName)}
                        disabled={!!rerunningPillar}
                        title={`Re-run ${pillarName}`}
                        className="px-4 border-l border-gray-100 text-gray-400 hover:text-gray-700
                                   hover:bg-gray-50 disabled:opacity-30 disabled:cursor-not-allowed
                                   transition-colors"
                      >
                        <RefreshCw size={13} />
                      </button>
                    </div>

                    {expandedPillars[pillarName] && (
                      <div className="px-5 pb-5 border-t border-gray-100 space-y-6 pt-4">
                        {((pillar as any).agents ?? []).map((agent: any) => (
                          <div key={agent.agent}>
                            <div className="flex items-center justify-between mb-2">
                              <h4 className="text-xs font-mono text-rose-900 font-semibold">
                                → {agent.agent}
                              </h4>
                              {agent.status === 'failed' && (
                                <span className="text-[10px] text-red-500 flex items-center gap-1">
                                  <AlertTriangle size={10} /> Failed
                                </span>
                              )}
                            </div>
                            <div className="prose prose-sm max-w-none prose-pre:bg-gray-50">
                              <MemoizedMarkdown content={agent.content} />
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>

            <div className="h-16" />
          </div>
        </main>
      </div>
    </div>
  );
}
