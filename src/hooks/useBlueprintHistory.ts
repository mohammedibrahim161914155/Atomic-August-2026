/**
 * src/hooks/useBlueprintHistory.ts
 *
 * React hook encapsulating all blueprint history operations:
 *   - Paginated listing with search, tag filter, date filter, quality filter, sort
 *   - Load a full blueprint by ID
 *   - Delete, rate, note, tag a blueprint
 *   - All-tags list for the sidebar filter
 *
 * Optimistic updates for mutating operations keep the UI snappy.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { Blueprint } from '../engine/types';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BlueprintListItem {
  id:                 string;
  session_id?:        string;
  prompt:             string;
  product_name?:      string;
  domain?:            string;
  created_at:         string;
  updated_at:         string;
  quality_score:      number;
  total_tokens:       number;
  generation_time_ms: number;
  rating?:            number;
  tags:               string[];
}

export interface SavedBlueprint extends BlueprintListItem {
  blueprint: Blueprint;
  notes:     Record<string, string>;
}

export interface TagCount { tag: string; count: number }

export type DateFilter    = 'all' | 'today' | 'week' | 'month';
export type SortBy        = 'newest' | 'oldest' | 'quality';
export type QualityFilter = 'all' | 'good' | 'excellent';

// ── Hook return type ──────────────────────────────────────────────────────────

export interface UseBlueprintHistoryReturn {
  items:         BlueprintListItem[];
  total:         number;
  loading:       boolean;
  error:         string | null;
  page:          number;
  search:        string;
  activeTag:     string | null;
  allTags:       TagCount[];
  dateFilter:    DateFilter;
  qualityFilter: QualityFilter;
  sortBy:        SortBy;
  setPage:           (p: number) => void;
  setSearch:         (s: string) => void;
  setActiveTag:      (tag: string | null) => void;
  setDateFilter:     (f: DateFilter) => void;
  setQualityFilter:  (f: QualityFilter) => void;
  setSortBy:         (s: SortBy) => void;
  resetFilters:      () => void;
  refresh:           () => Promise<void>;
  deleteBlueprint:   (id: string) => Promise<void>;
  getBlueprint:      (id: string) => Promise<SavedBlueprint | null>;
  rateBlueprint:     (id: string, rating: number | null) => Promise<void>;
  setNote:           (id: string, sectionKey: string, note: string) => Promise<void>;
  setTags:           (id: string, tags: string[]) => Promise<void>;
  refreshTags:       () => Promise<void>;
}

// ── Date filter → ISO string ──────────────────────────────────────────────────

function dateFilterToISO(filter: DateFilter): string | null {
  if (filter === 'all') return null;
  const now = new Date();
  if (filter === 'today') {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    return d.toISOString();
  }
  if (filter === 'week') {
    const d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return d.toISOString();
  }
  // month
  const d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  return d.toISOString();
}

function qualityFilterToMin(filter: QualityFilter): number | null {
  if (filter === 'excellent') return 90;
  if (filter === 'good')      return 75;
  return null;
}

const PAGE_SIZE = 20;

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useBlueprintHistory(): UseBlueprintHistoryReturn {
  const [items,         setItems]         = useState<BlueprintListItem[]>([]);
  const [total,         setTotal]         = useState(0);
  const [loading,       setLoading]       = useState(true);
  const [error,         setError]         = useState<string | null>(null);
  const [page,          setPage]          = useState(1);
  const [search,        setSearch]        = useState('');
  const [activeTag,     setActiveTag]     = useState<string | null>(null);
  const [allTags,       setAllTags]       = useState<TagCount[]>([]);
  const [dateFilter,    setDateFilter]    = useState<DateFilter>('all');
  const [qualityFilter, setQualityFilter] = useState<QualityFilter>('all');
  const [sortBy,        setSortBy]        = useState<SortBy>('newest');

  // Debounce search
  const searchTimerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  const handleSearchChange = useCallback((s: string) => {
    setSearch(s);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      setDebouncedSearch(s);
      setPage(1);
    }, 280);
  }, []);

  const handleSetActiveTag = useCallback((tag: string | null) => {
    setActiveTag(tag);
    setPage(1);
  }, []);

  const handleSetDateFilter = useCallback((f: DateFilter) => {
    setDateFilter(f);
    setPage(1);
  }, []);

  const handleSetQualityFilter = useCallback((f: QualityFilter) => {
    setQualityFilter(f);
    setPage(1);
  }, []);

  const handleSetSortBy = useCallback((s: SortBy) => {
    setSortBy(s);
    setPage(1);
  }, []);

  const resetFilters = useCallback(() => {
    setActiveTag(null);
    setDateFilter('all');
    setQualityFilter('all');
    setSortBy('newest');
    setSearch('');
    setDebouncedSearch('');
    setPage(1);
  }, []);

  const refreshTags = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/blueprints/tags');
      if (res.ok) {
        const data = await res.json() as { tags: TagCount[] };
        setAllTags(data.tags);
      }
    } catch { /* non-critical */ }
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        limit:  String(PAGE_SIZE),
        offset: String((page - 1) * PAGE_SIZE),
        sort:   sortBy,
      });
      if (debouncedSearch) params.set('search',      debouncedSearch);
      if (activeTag)       params.set('tag',         activeTag);

      const dateAfter = dateFilterToISO(dateFilter);
      if (dateAfter)       params.set('date_after',  dateAfter);

      const qualityMin = qualityFilterToMin(qualityFilter);
      if (qualityMin !== null) params.set('quality_min', String(qualityMin));

      const res = await fetch(`/api/v1/blueprints?${params}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { items: BlueprintListItem[]; total: number };
      setItems(data.items);
      setTotal(data.total);
    } catch (err: any) {
      setError(err.message ?? 'Failed to load blueprint history');
    } finally {
      setLoading(false);
    }
  }, [page, debouncedSearch, activeTag, dateFilter, qualityFilter, sortBy]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async data-load kickoff (intentional)
  useEffect(() => { refresh(); }, [refresh]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- async data-load kickoff (intentional)
  useEffect(() => { refreshTags(); }, [refreshTags]);

  const deleteBlueprint = useCallback(async (id: string): Promise<void> => {
    setItems(prev => prev.filter(b => b.id !== id));
    setTotal(prev => Math.max(0, prev - 1));
    try {
      const res = await fetch(`/api/v1/blueprints/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refreshTags();
    } catch (err: any) {
      await refresh();
      throw err;
    }
  }, [refresh, refreshTags]);

  const getBlueprint = useCallback(async (id: string): Promise<SavedBlueprint | null> => {
    const res = await fetch(`/api/v1/blueprints/${id}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as SavedBlueprint;
  }, []);

  const rateBlueprint = useCallback(async (id: string, rating: number | null): Promise<void> => {
    setItems(prev => prev.map(b => b.id === id ? { ...b, rating: rating ?? undefined } : b));
    const res = await fetch(`/api/v1/blueprints/${id}/rating`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ rating }),
    });
    if (!res.ok) { await refresh(); throw new Error(`HTTP ${res.status}`); }
  }, [refresh]);

  const setNote = useCallback(async (
    id: string, sectionKey: string, note: string,
  ): Promise<void> => {
    const res = await fetch(`/api/v1/blueprints/${id}/note`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ sectionKey, note }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }, []);

  const setTags = useCallback(async (id: string, tags: string[]): Promise<void> => {
    setItems(prev => prev.map(b => b.id === id ? { ...b, tags } : b));
    const res = await fetch(`/api/v1/blueprints/${id}/tags`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tags }),
    });
    if (!res.ok) { await refresh(); throw new Error(`HTTP ${res.status}`); }
    await refreshTags();
  }, [refresh, refreshTags]);

  return {
    items, total, loading, error,
    page, search, activeTag, allTags,
    dateFilter, qualityFilter, sortBy,
    setPage, setSearch: handleSearchChange,
    setActiveTag: handleSetActiveTag,
    setDateFilter: handleSetDateFilter,
    setQualityFilter: handleSetQualityFilter,
    setSortBy: handleSetSortBy,
    resetFilters,
    refresh, refreshTags,
    deleteBlueprint, getBlueprint,
    rateBlueprint, setNote, setTags,
  };
}
