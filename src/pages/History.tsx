/**
 * src/pages/History.tsx
 *
 * "My Blueprints" — Claude-inspired two-panel layout.
 * Dark sidebar with tag filters + warm off-white main area with list-style cards.
 * Features: search, tag filter, compare mode, inline tag management, star rating, delete.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, Trash2, Star, Clock, Zap, FileText,
  ChevronLeft, ChevronRight, AlertCircle, ArrowLeft,
  GitCompare, CheckSquare, Square, X, Plus, Tag,
  ExternalLink, Layers, Check,
} from 'lucide-react';
import { Blueprint } from '../engine/types';
import {
  useBlueprintHistory, BlueprintListItem,
  type DateFilter, type SortBy, type QualityFilter,
} from '../hooks/useBlueprintHistory';

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86_400_000);
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7)  return `${diffDays}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${Math.round(n / 1_000)}k`;
  return String(n);
}


function qualityBg(score: number): string {
  if (score >= 90) return 'bg-emerald-50 text-emerald-700 border-emerald-200';
  if (score >= 75) return 'bg-amber-50 text-amber-700 border-amber-200';
  return 'bg-rose-50 text-rose-700 border-rose-200';
}

// Deterministic color per tag (hashed)
const TAG_PALETTES = [
  'bg-blue-100 text-blue-700 border-blue-200',
  'bg-violet-100 text-violet-700 border-violet-200',
  'bg-emerald-100 text-emerald-700 border-emerald-200',
  'bg-orange-100 text-orange-700 border-orange-200',
  'bg-pink-100 text-pink-700 border-pink-200',
  'bg-sky-100 text-sky-700 border-sky-200',
  'bg-teal-100 text-teal-700 border-teal-200',
  'bg-amber-100 text-amber-700 border-amber-200',
];
function tagPalette(tag: string): string {
  let h = 0;
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return TAG_PALETTES[h % TAG_PALETTES.length]!;
}

// Sidebar tag color dots
const DOT_COLORS = [
  'bg-blue-400', 'bg-violet-400', 'bg-emerald-400',
  'bg-orange-400', 'bg-pink-400', 'bg-sky-400',
  'bg-teal-400', 'bg-amber-400',
];
function dotColor(tag: string): string {
  let h = 0;
  for (const c of tag) h = (h * 31 + c.charCodeAt(0)) & 0xffff;
  return DOT_COLORS[h % DOT_COLORS.length]!;
}

// ── Tag pill (inline on card) ─────────────────────────────────────────────────

function TagPill({
  tag, onRemove,
}: { tag: string; onRemove?: () => void }) {
  return (
    <span className={`
      inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5
      rounded-full border ${tagPalette(tag)} shrink-0
    `}>
      {tag}
      {onRemove && (
        <button
          onClick={e => { e.stopPropagation(); onRemove(); }}
          className="hover:opacity-70 transition-opacity leading-none"
        >
          <X size={9} />
        </button>
      )}
    </span>
  );
}

// ── Tag editor popover ────────────────────────────────────────────────────────

interface TagEditorProps {
  currentTags: string[];
  allTagNames: string[];
  onSave:  (tags: string[]) => void;
  onClose: () => void;
}

function TagEditor({ currentTags, allTagNames, onSave, onClose }: TagEditorProps) {
  const [draft, setDraft]   = useState(currentTags);
  const [input, setInput]   = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const suggestions = allTagNames.filter(
    t => !draft.includes(t) && t.includes(input.toLowerCase().trim())
  ).slice(0, 6);

  const addTag = (tag: string) => {
    const t = tag.trim().toLowerCase().replace(/[^a-z0-9\s\-_]/g, '').trim();
    if (t && !draft.includes(t) && draft.length < 10) {
      setDraft(d => [...d, t]);
      setInput('');
    }
  };

  const removeTag = (tag: string) => setDraft(d => d.filter(x => x !== tag));

  return (
    <div
      className="absolute z-50 left-0 mt-1 w-72 bg-white rounded-xl shadow-xl
                 border border-gray-200 p-3"
      onClick={e => e.stopPropagation()}
    >
      {/* Current tags */}
      <div className="flex flex-wrap gap-1.5 mb-2 min-h-[24px]">
        {draft.map(t => (
          <TagPill key={t} tag={t} onRemove={() => removeTag(t)} />
        ))}
        {draft.length === 0 && (
          <span className="text-xs text-gray-400 italic">No tags yet</span>
        )}
      </div>

      {/* Input */}
      <div className="flex items-center gap-1 mb-1">
        <input
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') { addTag(input); e.preventDefault(); }
            if (e.key === 'Escape') onClose();
          }}
          placeholder="Add tag…"
          className="flex-1 text-xs px-2 py-1.5 border border-gray-200 rounded-lg
                     focus:outline-none focus:ring-2 focus:ring-rose-900/20 focus:border-rose-900/30"
        />
        <button
          onClick={() => addTag(input)}
          disabled={!input.trim()}
          className="px-2 py-1.5 text-xs bg-gray-900 text-white rounded-lg
                     hover:bg-gray-700 transition-colors disabled:opacity-30"
        >
          <Plus size={12} />
        </button>
      </div>

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-2">
          {suggestions.map(t => (
            <button
              key={t}
              onClick={() => addTag(t)}
              className={`text-[10px] px-2 py-0.5 rounded-full border ${tagPalette(t)}
                          hover:opacity-80 transition-opacity`}
            >
              + {t}
            </button>
          ))}
        </div>
      )}

      <div className="flex justify-end gap-2 border-t border-gray-100 pt-2 mt-1">
        <button
          onClick={onClose}
          className="text-xs px-3 py-1 text-gray-500 hover:text-gray-700 transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => { onSave(draft); onClose(); }}
          className="text-xs px-3 py-1 bg-gray-900 text-white rounded-lg
                     hover:bg-gray-700 transition-colors"
        >
          Save
        </button>
      </div>
    </div>
  );
}

// ── Star row ──────────────────────────────────────────────────────────────────

function StarRow({ rating }: { rating?: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map(s => (
        <Star
          key={s}
          size={10}
          className={rating && s <= rating ? 'text-amber-400 fill-amber-400' : 'text-gray-200 fill-gray-200'}
        />
      ))}
    </div>
  );
}

// ── Blueprint list item ───────────────────────────────────────────────────────

interface ItemProps {
  item:         BlueprintListItem;
  allTagNames:  string[];
  onOpen:       (id: string) => void;
  onDelete:     (id: string) => void;
  onTagsSave:   (id: string, tags: string[]) => void;
  deleting:     boolean;
  compareMode:  boolean;
  selected:     boolean;
  selectable:   boolean;
  onToggle:     (id: string) => void;
}

function BlueprintItem({
  item, allTagNames, onOpen, onDelete, onTagsSave,
  deleting, compareMode, selected, selectable, onToggle,
}: ItemProps) {
  const title    = item.product_name ?? item.prompt.slice(0, 72);
  const subtitle = item.product_name ? item.prompt.slice(0, 120) : undefined;
  const [tagOpen, setTagOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Close tag editor on outside click
  useEffect(() => {
    if (!tagOpen) return;
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setTagOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [tagOpen]);

  const handleClick = () => {
    if (compareMode) {
      if (selectable || selected) onToggle(item.id);
    } else {
      onOpen(item.id);
    }
  };

  return (
    <div
      onClick={handleClick}
      className={`
        group relative bg-white rounded-xl border transition-all duration-150
        ${compareMode
          ? selected
            ? 'border-rose-900 ring-2 ring-rose-900/15 cursor-pointer shadow-sm'
            : selectable
              ? 'border-gray-200 hover:border-gray-300 cursor-pointer hover:shadow-sm'
              : 'border-gray-100 opacity-40 cursor-not-allowed'
          : 'border-gray-200 hover:border-gray-300 hover:shadow-sm cursor-pointer'
        }
      `}
    >
      {/* Compare checkbox */}
      {compareMode && (selectable || selected) && (
        <div className="absolute top-4 right-4 z-10">
          {selected
            ? <CheckSquare size={17} className="text-rose-900" />
            : <Square      size={17} className="text-gray-300" />}
        </div>
      )}

      <div className="p-5">
        {/* Top row */}
        <div className="flex items-start gap-3 mb-2">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-0.5 flex-wrap">
              <h3 className="font-semibold text-gray-900 text-sm leading-snug truncate max-w-xs">
                {title}
              </h3>
              {item.domain && (
                <span className="shrink-0 text-[9px] uppercase tracking-widest px-1.5 py-0.5
                                 bg-gray-100 text-gray-400 rounded-md font-medium">
                  {item.domain}
                </span>
              )}
            </div>
            {subtitle && (
              <p className="text-xs text-gray-400 leading-relaxed line-clamp-2 italic">
                {subtitle}
              </p>
            )}
          </div>

          {/* Quality score badge */}
          <span className={`
            shrink-0 text-xs font-bold px-2 py-1 rounded-lg border font-mono
            ${qualityBg(item.quality_score)}
          `}>
            {item.quality_score}
          </span>
        </div>

        {/* Tags row */}
        <div className="flex items-center gap-1.5 flex-wrap mt-3 mb-2" ref={wrapRef}>
          {item.tags.map(t => (
            <TagPill
              key={t}
              tag={t}
              onRemove={compareMode ? undefined : () => {
                onTagsSave(item.id, item.tags.filter(x => x !== t));
              }}
            />
          ))}

          {/* Add tag button */}
          {!compareMode && (
            <div className="relative">
              <button
                onClick={e => { e.stopPropagation(); setTagOpen(o => !o); }}
                className="flex items-center gap-1 text-[10px] text-gray-400
                           hover:text-gray-600 transition-colors px-1.5 py-0.5
                           rounded-full border border-dashed border-gray-300
                           hover:border-gray-400"
              >
                <Plus size={9} />
                {item.tags.length === 0 ? 'Add tag' : ''}
              </button>
              {tagOpen && (
                <TagEditor
                  currentTags={item.tags}
                  allTagNames={allTagNames}
                  onSave={tags => onTagsSave(item.id, tags)}
                  onClose={() => setTagOpen(false)}
                />
              )}
            </div>
          )}
        </div>

        {/* Footer row */}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-100">
          <div className="flex items-center gap-3 text-[11px] text-gray-400">
            <span className="flex items-center gap-1">
              <Clock size={10} />{formatDate(item.created_at)}
            </span>
            <span className="flex items-center gap-1">
              <Zap size={10} />{formatTokens(item.total_tokens)}
            </span>
            <span className="flex items-center gap-1">
              <Clock size={10} />{(item.generation_time_ms / 1000).toFixed(0)}s
            </span>
            <StarRow rating={item.rating} />
          </div>

          {/* Actions */}
          {!compareMode && (
            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={e => { e.stopPropagation(); onOpen(item.id); }}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[11px]
                           text-gray-500 hover:text-gray-900 hover:bg-gray-100
                           transition-colors font-medium"
              >
                <ExternalLink size={11} /> Open
              </button>
              <button
                onClick={e => { e.stopPropagation(); onDelete(item.id); }}
                disabled={deleting}
                className="p-1.5 rounded-lg text-gray-400 hover:text-red-600
                           hover:bg-red-50 transition-colors disabled:opacity-40"
              >
                <Trash2 size={13} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton() {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse">
      <div className="flex gap-3 mb-3">
        <div className="flex-1">
          <div className="h-4 bg-gray-200 rounded w-2/3 mb-2" />
          <div className="h-3 bg-gray-100 rounded w-full mb-1" />
          <div className="h-3 bg-gray-100 rounded w-3/4" />
        </div>
        <div className="w-10 h-8 bg-gray-200 rounded-lg shrink-0" />
      </div>
      <div className="flex gap-2 mb-3">
        <div className="h-4 bg-gray-100 rounded-full w-12" />
        <div className="h-4 bg-gray-100 rounded-full w-16" />
      </div>
      <div className="h-px bg-gray-100 mb-3" />
      <div className="flex gap-3">
        <div className="h-3 bg-gray-100 rounded w-14" />
        <div className="h-3 bg-gray-100 rounded w-10" />
        <div className="h-3 bg-gray-100 rounded w-10" />
      </div>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

interface Props {
  onLoad: (b: Blueprint) => void;
  onBack: () => void;
}

export default function History({ onLoad, onBack }: Props) {
  const navigate = useNavigate();

  const {
    items, total, loading, error,
    page, search, activeTag, allTags,
    dateFilter, qualityFilter, sortBy,
    setPage, setSearch, setActiveTag,
    setDateFilter, setQualityFilter, setSortBy, resetFilters,
    refresh, deleteBlueprint, getBlueprint,
    rateBlueprint: _rateBlueprint, setTags,
  } = useBlueprintHistory();

  const [deletingId,  setDeletingId]  = useState<string | null>(null);
  const [loadingId,   setLoadingId]   = useState<string | null>(null);
  const [loadError,   setLoadError]   = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const allTagNames = allTags.map(t => t.tag);

  const toggleCompare = () => { setCompareMode(m => !m); setSelectedIds([]); };
  const toggleSelect  = (id: string) => {
    setSelectedIds(prev => {
      if (prev.includes(id)) return prev.filter(x => x !== id);
      if (prev.length >= 2)  return prev;
      return [...prev, id];
    });
  };

  const handleOpen = useCallback(async (id: string) => {
    setLoadingId(id); setLoadError(null);
    try {
      const saved = await getBlueprint(id);
      if (!saved) throw new Error('Blueprint not found');
      onLoad(saved.blueprint);
    } catch (err: any) {
      setLoadError(err.message ?? 'Failed to load');
    } finally {
      setLoadingId(null);
    }
  }, [getBlueprint, onLoad]);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm('Delete this blueprint? This cannot be undone.')) return;
    setDeletingId(id);
    try { await deleteBlueprint(id); }
    catch (err: any) { setLoadError(err.message ?? 'Delete failed'); }
    finally { setDeletingId(null); }
  }, [deleteBlueprint]);

  const handleTagsSave = useCallback(async (id: string, tags: string[]) => {
    try { await setTags(id, tags); }
    catch { /* silent — optimistic already applied */ }
  }, [setTags]);

  return (
    <div className="min-h-screen flex" style={{ background: '#f5f4f0' }}>

      {/* ── Dark sidebar ────────────────────────────────────────────── */}
      <aside
        className="flex flex-col shrink-0 border-r border-white/10"
        style={{
          width: sidebarOpen ? 240 : 0,
          minWidth: sidebarOpen ? 240 : 0,
          background: '#1c1612',
          transition: 'width 150ms ease, min-width 150ms ease',
          overflow: 'hidden',
        }}
      >
        {/* Logo + back */}
        <div className="px-4 pt-5 pb-4">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70
                       transition-colors mb-4"
          >
            <ArrowLeft size={12} /> Back to app
          </button>
          <div className="font-mono font-bold text-white text-base tracking-tighter">
            ATOMIC
          </div>
          <div className="text-[11px] text-white/40 mt-0.5">My Blueprints</div>
        </div>

        {/* New blueprint CTA */}
        <div className="px-3 mb-4">
          <button
            onClick={onBack}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-lg
                       bg-white/10 hover:bg-white/15 text-white text-xs font-medium
                       transition-colors"
          >
            <Plus size={13} /> New Blueprint
          </button>
        </div>

        {/* Divider */}
        <div className="h-px bg-white/8 mx-3 mb-3" />

        {/* All blueprints filter */}
        <nav className="flex-1 overflow-y-auto px-2">
          <button
            onClick={() => setActiveTag(null)}
            className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs
                        transition-colors mb-0.5
                        ${!activeTag
                          ? 'bg-white/15 text-white font-medium'
                          : 'text-white/60 hover:text-white hover:bg-white/8'
                        }`}
          >
            <Layers size={13} className="shrink-0" />
            <span className="flex-1 text-left">All Blueprints</span>
            <span className="text-[10px] font-mono opacity-60">{total}</span>
          </button>

          {/* Tags section */}
          {allTags.length > 0 && (
            <>
              <div className="px-3 pt-4 pb-1.5 text-[9px] uppercase tracking-widest text-white/30 font-semibold">
                Tags
              </div>
              {allTags.map(({ tag, count }) => (
                <button
                  key={tag}
                  onClick={() => setActiveTag(tag === activeTag ? null : tag)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs
                              transition-colors mb-0.5
                              ${activeTag === tag
                                ? 'bg-white/15 text-white font-medium'
                                : 'text-white/60 hover:text-white hover:bg-white/8'
                              }`}
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor(tag)}`} />
                  <span className="flex-1 text-left truncate">{tag}</span>
                  <span className="text-[10px] font-mono opacity-60">{count}</span>
                </button>
              ))}
            </>
          )}

          {/* ── Date filter ─────────────────────────────────────────────── */}
          <div className="px-3 pt-5 pb-1.5 text-[9px] uppercase tracking-widest text-white/30 font-semibold">
            Date
          </div>
          {(['all', 'today', 'week', 'month'] as DateFilter[]).map(f => (
            <button
              key={f}
              onClick={() => setDateFilter(f)}
              className={`w-full flex items-center px-3 py-1.5 rounded-lg text-xs
                          transition-colors mb-0.5
                          ${dateFilter === f
                            ? 'bg-white/15 text-white font-medium'
                            : 'text-white/50 hover:text-white hover:bg-white/8'
                          }`}
            >
              {f === 'all' ? 'All time' : f === 'today' ? 'Today' : f === 'week' ? 'This week' : 'This month'}
            </button>
          ))}

          {/* ── Quality filter ──────────────────────────────────────────── */}
          <div className="px-3 pt-4 pb-1.5 text-[9px] uppercase tracking-widest text-white/30 font-semibold">
            Quality
          </div>
          {(['all', 'good', 'excellent'] as QualityFilter[]).map(f => (
            <button
              key={f}
              onClick={() => setQualityFilter(f)}
              className={`w-full flex items-center px-3 py-1.5 rounded-lg text-xs
                          transition-colors mb-0.5
                          ${qualityFilter === f
                            ? 'bg-white/15 text-white font-medium'
                            : 'text-white/50 hover:text-white hover:bg-white/8'
                          }`}
            >
              {f === 'all' ? 'All scores' : f === 'good' ? '≥ 75 — Good' : '≥ 90 — Excellent'}
            </button>
          ))}

          {/* ── Sort by ─────────────────────────────────────────────────── */}
          <div className="px-3 pt-4 pb-1.5 text-[9px] uppercase tracking-widest text-white/30 font-semibold">
            Sort By
          </div>
          {(['newest', 'oldest', 'quality'] as SortBy[]).map(s => (
            <button
              key={s}
              onClick={() => setSortBy(s)}
              className={`w-full flex items-center px-3 py-1.5 rounded-lg text-xs
                          transition-colors mb-0.5
                          ${sortBy === s
                            ? 'bg-white/15 text-white font-medium'
                            : 'text-white/50 hover:text-white hover:bg-white/8'
                          }`}
            >
              {s === 'newest' ? 'Newest first' : s === 'oldest' ? 'Oldest first' : 'Best quality'}
            </button>
          ))}

          {/* Reset filters */}
          {(dateFilter !== 'all' || qualityFilter !== 'all' || sortBy !== 'newest' || activeTag) && (
            <div className="px-3 pt-4">
              <button
                onClick={resetFilters}
                className="w-full text-center text-[10px] text-white/30 hover:text-white/60
                           transition-colors py-1 rounded-lg hover:bg-white/5"
              >
                Reset all filters
              </button>
            </div>
          )}
        </nav>

        {/* Bottom: total count */}
        <div className="px-4 py-4 text-[10px] text-white/25 border-t border-white/8">
          {total} blueprint{total !== 1 ? 's' : ''} saved
        </div>
      </aside>

      {/* ── Main content ─────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col">

        {/* Top bar */}
        <header className="h-13 flex items-center gap-3 px-6 py-3 shrink-0"
                style={{ background: '#f5f4f0', borderBottom: '1px solid #e8e6e0' }}>

          {/* Sidebar toggle */}
          <button
            onClick={() => setSidebarOpen(o => !o)}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600
                       hover:bg-black/5 transition-colors"
            title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          >
            <Layers size={15} />
          </button>

          {/* Active tag breadcrumb */}
          {activeTag && (
            <div className="flex items-center gap-1.5 text-sm text-gray-600">
              <Tag size={12} className="text-gray-400" />
              <span className="font-medium">{activeTag}</span>
              <button
                onClick={() => setActiveTag(null)}
                className="text-gray-400 hover:text-gray-600 transition-colors"
              >
                <X size={12} />
              </button>
            </div>
          )}

          {/* Search */}
          <div className="flex-1 max-w-sm relative">
            <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search blueprints…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full pl-9 pr-4 py-1.5 text-sm bg-white border border-gray-200
                         rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10
                         focus:border-gray-400 placeholder-gray-400 text-gray-900"
              style={{ background: 'rgba(255,255,255,0.7)' }}
            />
          </div>

          <div className="ml-auto flex items-center gap-2">
            {/* Compare toggle */}
            {!compareMode ? (
              items.length >= 2 && (
                <button
                  onClick={toggleCompare}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium
                             text-gray-600 hover:text-gray-900 bg-white border border-gray-200
                             hover:border-gray-300 rounded-lg transition-colors shadow-sm"
                >
                  <GitCompare size={13} /> Compare
                </button>
              )
            ) : (
              <button
                onClick={toggleCompare}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-500
                           border border-gray-200 rounded-lg hover:bg-gray-100 transition-colors"
              >
                <X size={12} /> Cancel
              </button>
            )}
          </div>
        </header>

        {/* Error banner */}
        {(error || loadError) && (
          <div className="mx-6 mt-4 flex items-center gap-2 p-3 bg-red-50 border border-red-200
                          rounded-xl text-red-700 text-sm">
            <AlertCircle size={14} className="shrink-0" />
            <span>{error ?? loadError}</span>
            <button
              onClick={() => { setLoadError(null); refresh(); }}
              className="ml-auto text-xs underline"
            >Retry</button>
          </div>
        )}

        {/* Compare mode banner */}
        {compareMode && (
          <div className="mx-6 mt-4 flex items-center gap-2 p-3 bg-white border border-gray-200
                          rounded-xl text-gray-700 text-sm shadow-sm">
            <GitCompare size={14} className="text-gray-400 shrink-0" />
            <span>
              {selectedIds.length === 0 && 'Select two blueprints to compare side-by-side.'}
              {selectedIds.length === 1 && 'Select one more blueprint to compare.'}
              {selectedIds.length === 2 && 'Ready — click Compare Selected below.'}
            </span>
          </div>
        )}

        {/* Blueprint list */}
        <main className="flex-1 px-6 py-5 overflow-y-auto">

          {/* Loading skeletons */}
          {loading && (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} />)}
            </div>
          )}

          {/* Empty state */}
          {!loading && items.length === 0 && (
            <div className="flex flex-col items-center justify-center py-24 text-center">
              <div className="w-16 h-16 rounded-2xl bg-white border border-gray-200 flex items-center
                              justify-center mb-4 shadow-sm">
                <FileText size={28} className="text-gray-300" />
              </div>
              <h3 className="text-base font-semibold text-gray-700 mb-1">
                {activeTag
                  ? `No blueprints tagged "${activeTag}"`
                  : search
                    ? 'No blueprints match your search'
                    : 'No blueprints saved yet'}
              </h3>
              <p className="text-sm text-gray-400 max-w-xs">
                {activeTag
                  ? 'Try a different tag or clear the filter.'
                  : search
                    ? 'Try a different search term.'
                    : 'Generate a blueprint and it will appear here automatically.'}
              </p>
            </div>
          )}

          {/* List */}
          {!loading && items.length > 0 && (
            <div className="space-y-2.5 max-w-3xl">
              {items.map(item => (
                <BlueprintItem
                  key={item.id}
                  item={item}
                  allTagNames={allTagNames}
                  onOpen={handleOpen}
                  onDelete={handleDelete}
                  onTagsSave={handleTagsSave}
                  deleting={deletingId === item.id}
                  compareMode={compareMode}
                  selected={selectedIds.includes(item.id)}
                  selectable={selectedIds.length < 2 || selectedIds.includes(item.id)}
                  onToggle={toggleSelect}
                />
              ))}

              {/* Loading overlay */}
              {loadingId && (
                <div className="fixed inset-0 bg-black/20 backdrop-blur-sm z-50
                                flex items-center justify-center">
                  <div className="bg-white rounded-2xl p-6 shadow-xl flex flex-col items-center gap-3">
                    <div className="w-5 h-5 border-2 border-gray-900 border-t-transparent
                                    rounded-full animate-spin" />
                    <span className="text-sm font-medium text-gray-700">Loading blueprint…</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Pagination */}
          {!loading && totalPages > 1 && (
            <div className="flex items-center gap-3 mt-8 max-w-3xl">
              <button
                onClick={() => setPage(Math.max(1, page - 1))}
                disabled={page === 1}
                className="p-2 rounded-lg border border-gray-200 bg-white text-gray-500
                           hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed
                           transition-colors shadow-sm"
              >
                <ChevronLeft size={15} />
              </button>
              <span className="text-sm text-gray-500 flex-1 text-center">
                Page <strong className="text-gray-800">{page}</strong> of{' '}
                <strong className="text-gray-800">{totalPages}</strong>
              </span>
              <button
                onClick={() => setPage(Math.min(totalPages, page + 1))}
                disabled={page === totalPages}
                className="p-2 rounded-lg border border-gray-200 bg-white text-gray-500
                           hover:bg-gray-50 disabled:opacity-40 disabled:cursor-not-allowed
                           transition-colors shadow-sm"
              >
                <ChevronRight size={15} />
              </button>
            </div>
          )}
        </main>
      </div>

      {/* ── Compare bottom bar ───────────────────────────────────────── */}
      {compareMode && selectedIds.length === 2 && (
        <div className="fixed bottom-0 inset-x-0 z-40 bg-white border-t border-gray-200 shadow-xl">
          <div className="max-w-5xl mx-auto px-6 py-3 flex items-center gap-4">
            <div className="flex items-center gap-2">
              <Check size={14} className="text-emerald-500" />
              <span className="text-sm text-gray-600 font-medium">
                2 blueprints selected
              </span>
            </div>
            <div className="flex-1" />
            <button
              onClick={toggleCompare}
              className="px-4 py-2 text-sm text-gray-500 border border-gray-200
                         rounded-lg hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => navigate(`/compare?a=${selectedIds[0]}&b=${selectedIds[1]}`)}
              className="flex items-center gap-2 px-5 py-2 text-sm font-semibold
                         bg-gray-900 text-white rounded-lg hover:bg-gray-700
                         transition-colors shadow-sm"
            >
              <GitCompare size={14} />
              Compare Side by Side
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
