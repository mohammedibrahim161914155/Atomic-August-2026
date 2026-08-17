/**
 * src/pages/Compare.tsx
 *
 * Side-by-side blueprint diff view.
 * URL: /compare?a=<id>&b=<id>
 *
 * Features:
 *  - LCS line-level diff per section
 *  - Collapsible unchanged-line runs
 *  - Unified & Split view modes
 *  - Section navigator with change indicators
 *  - Quality-score delta badge
 *  - Sections only in A (deleted) / only in B (new) clearly marked
 */

import {
  useState, useEffect, useMemo, useRef, useCallback,
} from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import {
  ArrowLeft, GitCompare, Columns, AlignLeft,
  Star, Clock, Zap, AlertCircle, Loader2,
  TrendingUp, TrendingDown, Minus, ChevronDown,
} from 'lucide-react';

// ── Fetched blueprint shape ───────────────────────────────────────────────────

interface SavedBlueprint {
  id: string;
  prompt: string;
  product_name: string | null;
  quality_score: number;
  total_tokens: number;
  generation_time_ms: number;
  created_at: string;
  rating: number | null;
  domain: string | null;
  notes: Record<string, string>;
  blueprint: {
    sections: Record<string, string>;
    [k: string]: unknown;
  };
}

// ── Diff engine ───────────────────────────────────────────────────────────────

type DiffType = 'same' | 'added' | 'removed';
interface DiffLine { type: DiffType; text: string }

function lineDiff(aText: string, bText: string): DiffLine[] {
  const a = aText.split('\n');
  const b = bText.split('\n');
  const m = a.length, n = b.length;

  if (m + n > 700) {
    return [
      ...a.map(text => ({ type: 'removed' as const, text })),
      ...b.map(text => ({ type: 'added'   as const, text })),
    ];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = a[i-1] === b[j-1]
        ? dp[i-1]![j-1]! + 1
        : Math.max(dp[i-1]![j]!, dp[i]![j-1]!);
    }
  }

  const result: DiffLine[] = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i-1] === b[j-1]) {
      result.unshift({ type: 'same',    text: a[i-1]! }); i--; j--;
    } else if (j > 0 && (i === 0 || dp[i]![j-1]! >= dp[i-1]![j]!)) {
      result.unshift({ type: 'added',   text: b[j-1]! }); j--;
    } else {
      result.unshift({ type: 'removed', text: a[i-1]! }); i--;
    }
  }
  return result;
}

interface SectionStats { added: number; removed: number; changed: boolean }
function stats(diff: DiffLine[]): SectionStats {
  const added   = diff.filter(l => l.type === 'added').length;
  const removed = diff.filter(l => l.type === 'removed').length;
  return { added, removed, changed: added > 0 || removed > 0 };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}
function fmtTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}
function qColor(s: number) {
  return s >= 90 ? 'text-green-600' : s >= 75 ? 'text-yellow-600' : 'text-red-500';
}
function secTitle(key: string) {
  return key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

// ── Unified diff block ────────────────────────────────────────────────────────

const CONTEXT_LINES = 3;
const COLLAPSE_THRESHOLD = 8;

function buildGroups(diff: DiffLine[]) {
  type Group = { lines: DiffLine[]; collapsible: boolean; id: string };
  const groups: Group[] = [];
  let i = 0, gid = 0;

  while (i < diff.length) {
    if (diff[i]!.type === 'same') {
      const start = i;
      while (i < diff.length && diff[i]!.type === 'same') i++;
      const sameLines = diff.slice(start, i);
      if (sameLines.length > COLLAPSE_THRESHOLD) {
        const isFirst = start === 0;
        const isLast  = i === diff.length;
        const head = isFirst ? 0 : CONTEXT_LINES;
        const tail = isLast  ? 0 : CONTEXT_LINES;
        if (head > 0)
          groups.push({ lines: sameLines.slice(0, head), collapsible: false, id: `g${gid++}` });
        groups.push({ lines: sameLines.slice(head, sameLines.length - tail), collapsible: true, id: `g${gid++}` });
        if (tail > 0)
          groups.push({ lines: sameLines.slice(-tail), collapsible: false, id: `g${gid++}` });
      } else {
        groups.push({ lines: sameLines, collapsible: false, id: `g${gid++}` });
      }
    } else {
      const start = i;
      while (i < diff.length && diff[i]!.type !== 'same') i++;
      groups.push({ lines: diff.slice(start, i), collapsible: false, id: `g${gid++}` });
    }
  }
  return groups;
}

function UnifiedBlock({ diff }: { diff: DiffLine[] }) {
  const groups = useMemo(() => buildGroups(diff), [diff]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  return (
    <div className="font-mono text-[11px] leading-5 overflow-x-auto select-text rounded-b-lg border border-gray-200 border-t-0">
      {groups.map(g => {
        if (g.collapsible && !expanded.has(g.id)) {
          return (
            <button
              key={g.id}
              onClick={() => setExpanded(s => { const n = new Set(s); n.add(g.id); return n; })}
              className="w-full flex items-center gap-2 px-4 py-1.5 bg-gray-50
                         text-gray-400 text-xs hover:bg-blue-50 hover:text-blue-600
                         transition-colors border-y border-dashed border-gray-200 group"
            >
              <ChevronDown size={12} className="group-hover:scale-110 transition-transform" />
              {g.lines.length} unchanged lines — click to expand
            </button>
          );
        }
        return g.lines.map((line, li) => (
          <div
            key={`${g.id}-${li}`}
            className={`flex min-w-0 ${
              line.type === 'added'   ? 'bg-green-50/70' :
              line.type === 'removed' ? 'bg-red-50/70'   : ''
            }`}
          >
            <span className={`
              w-7 shrink-0 select-none text-center text-[10px] font-bold border-r
              ${line.type === 'added'   ? 'text-green-600 bg-green-100 border-green-200' :
                line.type === 'removed' ? 'text-red-500   bg-red-100   border-red-200'   :
                'text-gray-300 bg-gray-50 border-gray-100'}
            `}>
              {line.type === 'added' ? '+' : line.type === 'removed' ? '−' : ' '}
            </span>
            <span className={`
              pl-3 pr-4 whitespace-pre-wrap break-words min-w-0 flex-1
              ${line.type === 'added'   ? 'text-green-900' :
                line.type === 'removed' ? 'text-red-800'   : 'text-gray-600'}
            `}>
              {line.text || '\u00a0'}
            </span>
          </div>
        ));
      })}
    </div>
  );
}

// ── Split (side-by-side) block ────────────────────────────────────────────────

function SplitBlock({ diff }: { diff: DiffLine[] }) {
  const leftLines  = useMemo(() => diff.filter(l => l.type !== 'added'),   [diff]);
  const rightLines = useMemo(() => diff.filter(l => l.type !== 'removed'), [diff]);

  const col = (lines: DiffLine[], side: 'left' | 'right') => (
    <div className="flex-1 min-w-0 overflow-x-auto font-mono text-[11px] leading-5">
      {lines.map((line, li) => (
        <div
          key={li}
          className={`flex min-w-0 ${
            (side === 'left'  && line.type === 'removed') ? 'bg-red-50/80'   :
            (side === 'right' && line.type === 'added')   ? 'bg-green-50/80' : ''
          }`}
        >
          <span className={`
            w-5 shrink-0 select-none text-center text-[9px] font-bold border-r
            ${(side === 'left'  && line.type === 'removed') ? 'text-red-400   bg-red-100   border-red-200'   :
              (side === 'right' && line.type === 'added')   ? 'text-green-500 bg-green-100 border-green-200' :
              'text-gray-200 bg-gray-50 border-gray-100'}
          `}>
            {(side === 'left'  && line.type === 'removed') ? '−' :
             (side === 'right' && line.type === 'added')   ? '+' : ' '}
          </span>
          <span className={`
            pl-2 pr-3 whitespace-pre-wrap break-words min-w-0 flex-1
            ${(side === 'left'  && line.type === 'removed') ? 'text-red-800'   :
              (side === 'right' && line.type === 'added')   ? 'text-green-900' : 'text-gray-600'}
          `}>
            {line.text || '\u00a0'}
          </span>
        </div>
      ))}
    </div>
  );

  return (
    <div className="flex border border-gray-200 border-t-0 rounded-b-lg overflow-hidden text-[11px]">
      {col(leftLines, 'left')}
      <div className="w-px bg-gray-200 shrink-0" />
      {col(rightLines, 'right')}
    </div>
  );
}

// ── Section row ───────────────────────────────────────────────────────────────

type ViewMode = 'unified' | 'split';

interface SectionData {
  key:    string;
  status: 'changed' | 'same' | 'new' | 'deleted';
  diff:   DiffLine[];
  aText:  string;
  bText:  string;
}

function SectionRow({
  section, viewMode, defaultOpen,
}: {
  section: SectionData;
  viewMode: ViewMode;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const st = useMemo(() => stats(section.diff), [section.diff]);

  const statusBadge = () => {
    if (section.status === 'new')     return <span className="text-[10px] font-semibold text-green-700 bg-green-100 px-2 py-0.5 rounded-full">NEW</span>;
    if (section.status === 'deleted') return <span className="text-[10px] font-semibold text-red-600  bg-red-100  px-2 py-0.5 rounded-full">DELETED</span>;
    if (section.status === 'changed') return (
      <span className="flex items-center gap-2 text-[10px]">
        {st.added   > 0 && <span className="text-green-700 bg-green-100 px-1.5 py-0.5 rounded">+{st.added}</span>}
        {st.removed > 0 && <span className="text-red-600   bg-red-100   px-1.5 py-0.5 rounded">−{st.removed}</span>}
      </span>
    );
    return <span className="text-[10px] text-gray-400">unchanged</span>;
  };

  return (
    <div id={`sec-${section.key}`} className="mb-4 scroll-mt-24">
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-white border border-gray-200
                   rounded-t-lg hover:bg-gray-50 transition-colors text-left"
        style={{ borderBottomLeftRadius: open ? 0 : undefined, borderBottomRightRadius: open ? 0 : undefined }}
      >
        <span className={`w-2 h-2 rounded-full shrink-0 ${
          section.status === 'new'     ? 'bg-green-400' :
          section.status === 'deleted' ? 'bg-red-400'   :
          section.status === 'changed' ? 'bg-amber-400' : 'bg-gray-200'
        }`} />
        <span className="flex-1 font-semibold text-sm text-gray-900">{secTitle(section.key)}</span>
        {statusBadge()}
        <ChevronDown
          size={14}
          className={`text-gray-400 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        section.status === 'new' ? (
          <div className="border border-green-200 border-t-0 rounded-b-lg bg-green-50/50 p-4 text-sm text-green-800 font-mono whitespace-pre-wrap text-[11px]">
            {section.bText}
          </div>
        ) : section.status === 'deleted' ? (
          <div className="border border-red-200 border-t-0 rounded-b-lg bg-red-50/50 p-4 text-sm text-red-800 font-mono whitespace-pre-wrap text-[11px] line-through opacity-60">
            {section.aText}
          </div>
        ) : viewMode === 'split' ? (
          <SplitBlock diff={section.diff} />
        ) : (
          <UnifiedBlock diff={section.diff} />
        )
      )}
    </div>
  );
}

// ── Blueprint summary card ────────────────────────────────────────────────────

function BpCard({ bp, label }: { bp: SavedBlueprint; label: 'A' | 'B' }) {
  const name = bp.product_name ?? bp.prompt.slice(0, 60);
  return (
    <div className={`flex-1 min-w-0 rounded-xl border p-4 ${
      label === 'A' ? 'border-blue-200 bg-blue-50/40' : 'border-purple-200 bg-purple-50/40'
    }`}>
      <div className="flex items-start gap-3 mb-2">
        <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full shrink-0 ${
          label === 'A' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
        }`}>{label}</span>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold text-sm text-gray-900 truncate leading-tight">{name}</h3>
          {bp.domain && (
            <span className="text-[10px] uppercase tracking-widest text-gray-400">{bp.domain}</span>
          )}
        </div>
        <span className={`text-2xl font-mono font-bold shrink-0 ${qColor(bp.quality_score)}`}>
          {bp.quality_score}
        </span>
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-gray-400">
        <span className="flex items-center gap-1"><Clock size={10} />{fmtDate(bp.created_at)}</span>
        <span className="flex items-center gap-1"><Zap size={10} />{fmtTokens(bp.total_tokens)}</span>
        {bp.rating && (
          <span className="flex items-center gap-0.5">
            {Array.from({ length: bp.rating }, (_, i) => (
              <Star key={i} size={10} className="text-amber-400 fill-amber-400" />
            ))}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Score delta ───────────────────────────────────────────────────────────────

function ScoreDelta({ a, b }: { a: number; b: number }) {
  const delta = b - a;
  if (delta === 0) return <span className="flex items-center gap-1 text-sm text-gray-400"><Minus size={14} /> No change in quality score</span>;
  const up = delta > 0;
  return (
    <span className={`flex items-center gap-1.5 text-sm font-semibold ${up ? 'text-green-600' : 'text-red-500'}`}>
      {up ? <TrendingUp size={15} /> : <TrendingDown size={15} />}
      Quality score {up ? 'improved' : 'dropped'} by {Math.abs(delta)} points
      <span className="text-gray-400 font-normal">({a} → {b})</span>
    </span>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Compare() {
  const [params]   = useSearchParams();
  const navigate   = useNavigate();
  const idA        = params.get('a') ?? '';
  const idB        = params.get('b') ?? '';

  const [bpA,     setBpA]     = useState<SavedBlueprint | null>(null);
  const [bpB,     setBpB]     = useState<SavedBlueprint | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('unified');

  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- early-return validation state (intentional)
    if (!idA || !idB) { setError('Two blueprint IDs are required.'); setLoading(false); return; }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data-load kickoff (intentional)
    setLoading(true); setError(null);
    Promise.all([
      fetch(`/api/v1/blueprints/${idA}`).then(r => { if (!r.ok) throw new Error('Blueprint A not found'); return r.json(); }),
      fetch(`/api/v1/blueprints/${idB}`).then(r => { if (!r.ok) throw new Error('Blueprint B not found'); return r.json(); }),
    ]).then(([a, b]) => {
      setBpA(a); setBpB(b);
    }).catch(err => {
      setError(err.message ?? 'Failed to load blueprints');
    }).finally(() => setLoading(false));
  }, [idA, idB]);

  const sections = useMemo<SectionData[]>(() => {
    if (!bpA || !bpB) return [];
    const aKeys = Object.keys(bpA.blueprint.sections);
    const bKeys = Object.keys(bpB.blueprint.sections);
    const allKeys = Array.from(new Set([...aKeys, ...bKeys]));

    return allKeys.map(key => {
      const aText = bpA.blueprint.sections[key] ?? '';
      const bText = bpB.blueprint.sections[key] ?? '';
      const inA = key in bpA.blueprint.sections;
      const inB = key in bpB.blueprint.sections;

      if (!inA) return { key, status: 'new'     as const, diff: bText.split('\n').map(t => ({ type: 'added'   as const, text: t })), aText: '', bText };
      if (!inB) return { key, status: 'deleted' as const, diff: aText.split('\n').map(t => ({ type: 'removed' as const, text: t })), aText, bText: '' };
      const diff = lineDiff(aText, bText);
      const st   = stats(diff);
      return { key, status: st.changed ? 'changed' as const : 'same' as const, diff, aText, bText };
    });
  }, [bpA, bpB]);

  const changedCount = sections.filter(s => s.status !== 'same').length;
  const sameCount    = sections.filter(s => s.status === 'same').length;

  const scrollToSection = useCallback((key: string) => {
    document.getElementById(`sec-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  if (loading) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="flex flex-col items-center gap-3 text-gray-500">
        <Loader2 size={28} className="animate-spin text-rose-900" />
        <span className="text-sm font-medium">Loading blueprints…</span>
      </div>
    </div>
  );

  if (error || !bpA || !bpB) return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4 text-center p-8 max-w-sm">
        <AlertCircle size={36} className="text-red-400" />
        <h2 className="font-semibold text-gray-800">Could not load comparison</h2>
        <p className="text-sm text-gray-500">{error ?? 'Unknown error'}</p>
        <button
          onClick={() => navigate('/history')}
          className="mt-2 px-4 py-2 bg-rose-900 text-white text-sm rounded-lg hover:bg-rose-800 transition-colors"
        >
          Back to History
        </button>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">

      {/* Top bar */}
      <header className="h-14 bg-white border-b border-gray-200 flex items-center px-6 gap-4 shrink-0 sticky top-0 z-30">
        <button
          onClick={() => navigate('/history')}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors"
        >
          <ArrowLeft size={15} /> Back
        </button>
        <div className="w-px h-5 bg-gray-200" />
        <span className="font-mono font-bold text-lg tracking-tighter text-gray-900">ATOMIC</span>
        <span className="text-gray-400">/</span>
        <span className="flex items-center gap-1.5 text-sm text-gray-600 font-medium">
          <GitCompare size={15} /> Compare
        </span>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-400 hidden sm:block">View:</span>
          {(['unified', 'split'] as const).map(m => (
            <button
              key={m}
              onClick={() => setViewMode(m)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                viewMode === m
                  ? 'bg-gray-900 text-white'
                  : 'text-gray-500 hover:bg-gray-100'
              }`}
            >
              {m === 'unified' ? <AlignLeft size={12} /> : <Columns size={12} />}
              {m.charAt(0).toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </header>

      {/* Blueprint header cards */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex gap-4 mb-4">
          <BpCard bp={bpA} label="A" />
          <BpCard bp={bpB} label="B" />
        </div>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <ScoreDelta a={bpA.quality_score} b={bpB.quality_score} />
          <div className="flex items-center gap-4 text-xs text-gray-500">
            {changedCount > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-amber-400" />
                {changedCount} section{changedCount !== 1 ? 's' : ''} changed
              </span>
            )}
            {sameCount > 0 && (
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-gray-200" />
                {sameCount} unchanged
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Body: nav + diffs */}
      <div className="flex flex-1 min-h-0">

        {/* Section navigator */}
        <aside
          ref={navRef}
          className="w-52 shrink-0 border-r border-gray-200 bg-white overflow-y-auto
                     sticky top-14 self-start hidden lg:block"
          style={{ maxHeight: 'calc(100vh - 56px)' }}
        >
          <div className="py-3 px-4 text-[10px] uppercase tracking-widest text-gray-400 font-semibold border-b border-gray-100">
            Sections
          </div>
          {sections.map(s => (
            <button
              key={s.key}
              onClick={() => scrollToSection(s.key)}
              className="w-full flex items-center gap-2.5 px-4 py-2.5 text-left
                         hover:bg-gray-50 transition-colors group"
            >
              <span className={`w-2 h-2 rounded-full shrink-0 ${
                s.status === 'new'     ? 'bg-green-400' :
                s.status === 'deleted' ? 'bg-red-400'   :
                s.status === 'changed' ? 'bg-amber-400' : 'bg-gray-200'
              }`} />
              <span className="text-xs text-gray-700 group-hover:text-gray-900 truncate">
                {secTitle(s.key)}
              </span>
            </button>
          ))}
        </aside>

        {/* Diff content */}
        <main className="flex-1 min-w-0 px-4 lg:px-8 py-6 overflow-x-hidden">

          {/* Split mode header labels */}
          {viewMode === 'split' && (
            <div className="flex gap-4 mb-4 text-xs font-semibold">
              <div className="flex-1 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg text-blue-700">
                A — {bpA.product_name ?? 'Blueprint A'}
              </div>
              <div className="flex-1 px-4 py-2 bg-purple-50 border border-purple-200 rounded-lg text-purple-700">
                B — {bpB.product_name ?? 'Blueprint B'}
              </div>
            </div>
          )}

          {sections.map((s, _i) => (
            <SectionRow
              key={s.key}
              section={s}
              viewMode={viewMode}
              defaultOpen={s.status !== 'same'}
            />
          ))}

          {sections.every(s => s.status === 'same') && (
            <div className="flex flex-col items-center justify-center py-16 text-center text-gray-400">
              <GitCompare size={36} className="mb-3 opacity-30" />
              <p className="font-semibold text-gray-600">These blueprints are identical</p>
              <p className="text-sm mt-1">No differences found across any section.</p>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
