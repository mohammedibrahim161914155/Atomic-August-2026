/**
 * src/pages/Chat.tsx — ATOMIC v5 Chat UI
 *
 * Key features per §1 spec:
 *  - True EmptyGreetingState + ActiveThreadState subtrees (no shared conditional tree)
 *  - Slash-command `/` skill picker (keyboard navigable: ↑↓ Enter Esc, cursor-anchored)
 *  - `+` menu with 3 exact sections: Context Attachment | Capabilities | Tools
 *  - Two-level model/effort/thinking selector
 *  - 5 Quick Action Pills (Start Scoping, Resume Blueprint, Explore Blueprint, Review Changes, Atomic's Pick)
 *  - Dynamic System Status Banner with per-notice localStorage dismissal
 *  - Workspace Panel: agent-keyed tabs (Brief/Breakdown, Blueprint/Pillars, Report/Diffs)
 *    with version selector wired to blueprintVersions API
 *  - Full keyboard navigation; aria-live on streaming; focus-trapped popovers
 */

import React, {
  useState, useEffect, useRef, useCallback, useMemo, useId,
} from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Send, Loader2, Bot, MessageSquare, Sparkles,
  CheckCircle2, Plus, Search, Star, Trash2, Edit2, Check, X,
  Mic, Paperclip, Settings2, StopCircle, PanelLeftClose, PanelLeft,
  MicOff, ChevronRight, ChevronDown, ChevronUp, ChevronLeft,
  Shield, BookOpen, LayoutGrid, FlaskConical, GitBranch, Network,
  Plug, AlertCircle, Info, AlertTriangle, PanelRightClose, PanelRight,
  Hash, Brain, Gauge, Image, Github, Layers, FolderOpen, SlidersHorizontal,
  Zap, Lock, Globe, History, Download, Diff,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { loadClientConfig } from '../lib/config';
import { PROVIDERS } from '../lib/providers';
import { BUILT_IN_SKILLS } from '../engine/skills';

// ── Types ──────────────────────────────────────────────────────────────────────

export type ChatMode   = 'artemis' | 'curator' | 'general';
export type EffortLevel = 'low' | 'medium' | 'high' | 'max';

interface ChatMessage {
  id:           string;
  role:         'user' | 'assistant' | 'system';
  content:      string;
  timestamp:    string;
  isStreaming?: boolean;
}

interface ChatSession {
  id:        string;
  mode:      ChatMode;
  title:     string;
  messages:  ChatMessage[];
  starred:   boolean;
  createdAt: string;
  updatedAt: string;
}

interface ComposerConfig {
  mode:            ChatMode;
  model:           string;
  effort:          EffortLevel;
  thinkingEnabled: boolean;
  activeSkillIds:  string[];
  webSearch:       boolean;
  sourceRestricted:boolean;
}

interface ArtemisWorkspace {
  sessionId:       string;
  brief:           unknown | null;
  confidenceScore: number;
  approved:        boolean;
  updatedAt:       string;
}

interface BlueprintVersionMeta {
  versionNumber: number;
  changeSummary: string;
  author:        string;
  timestamp:     string;
}

interface BlueprintSection {
  title:   string;
  content: string;
}

interface ActiveBlueprint {
  id:               string;
  productName:      string;
  qualityScore:     number;
  sections:         Record<string, BlueprintSection | string>;
  pillars:          Record<string, { summary?: string; score?: number }>;
  versionNumber?:   number;
}

interface ComposerPrefs {
  effort:          EffortLevel;
  thinkingEnabled: boolean;
  model:           string;
}

interface StatusNotice {
  id:      string;
  level:   'info' | 'warning' | 'error';
  message: string;
}

// ── Focus trap hook ────────────────────────────────────────────────────────────

function useFocusTrap(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  useEffect(() => {
    if (!active || !ref.current) return;
    const el = ref.current;
    const FOCUSABLE = 'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
    const nodes = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(n => !n.closest('[aria-hidden="true"]'));
    const first = nodes[0]; const last = nodes[nodes.length - 1];
    const handleTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (nodes.length === 0) { e.preventDefault(); return; }
      if (e.shiftKey) { if (document.activeElement === first) { e.preventDefault(); last?.focus(); } }
      else             { if (document.activeElement === last)  { e.preventDefault(); first?.focus(); } }
    };
    el.addEventListener('keydown', handleTab);
    // Auto-focus first focusable element
    setTimeout(() => first?.focus(), 10);
    return () => el.removeEventListener('keydown', handleTab);
  }, [active, ref]);
}

// ── Constants ──────────────────────────────────────────────────────────────────

const STORAGE_KEY    = 'atomic_chat_sessions_v3';
const SESSION_MAP    = 'atomic_artemis_session_map';
const CURATOR_MAP    = 'atomic_curator_session_map';
const DISMISSED_KEY  = 'atomic_dismissed_notices_v2';
const COMPOSER_PREF  = 'atomic_composer_prefs_v1';

const EFFORT_META: Record<EffortLevel, { label: string; desc: string; color: string }> = {
  low:    { label: 'Low',    desc: 'Fast, lightweight',        color: 'text-green-600'  },
  medium: { label: 'Medium', desc: 'Balanced speed and depth', color: 'text-blue-600'   },
  high:   { label: 'High',   desc: 'Deep multi-step analysis', color: 'text-violet-600' },
  max:    { label: 'Max',    desc: 'Extended, maximum tokens', color: 'text-rose-600'   },
};

interface QuickAction {
  id:      string;
  label:   string;
  icon:    React.FC<{ size?: number; className?: string }>;
  mode:    ChatMode;
  starter: string;
  route?:  string;
}

const QUICK_ACTIONS: QuickAction[] = [
  {
    id:      'scope',
    label:   'Start Scoping',
    icon:    LayoutGrid,
    mode:    'artemis',
    starter: "Let's scope a new project. I'll describe what I'm building.",
  },
  {
    id:      'resume',
    label:   'Resume Blueprint',
    icon:    History,
    mode:    'curator',
    starter: "Pick up where we left off and review my latest blueprint.",
    route:   '/history',
  },
  {
    id:      'explore',
    label:   'Explore Blueprint',
    icon:    BookOpen,
    mode:    'general',
    starter: "Explain my blueprint's architecture to a non-technical stakeholder.",
  },
  {
    id:      'review',
    label:   'Review Changes',
    icon:    Diff,
    mode:    'curator',
    starter: "Review my blueprint's latest changes and identify risks.",
  },
  {
    id:      'pick',
    label:   "Atomic's Pick",
    icon:    Zap,
    mode:    'artemis',
    starter: "Recommend the best next step for my project based on my history.",
  },
];

const MODE_META: Record<ChatMode, {
  label:       string;
  description: string;
  accent:      string;
  accentBg:    string;
  avatarClass: string;
  icon:        React.FC<{ size?: number; className?: string }>;
  placeholder: string;
  emptyTitle:  string;
  emptyDesc:   string;
  starters:    string[];
}> = {
  artemis: {
    label:       'Artemis',
    description: 'Pre-pipeline scoping agent',
    accent:      'text-violet-700',
    accentBg:    'bg-violet-50 border-violet-200',
    avatarClass: 'bg-violet-100 border-violet-200',
    icon:        ({ size = 16, className = '' }) => <Bot size={size} className={className} />,
    placeholder: "Describe your project, or type / to apply a skill…",
    emptyTitle:  'Start scoping your project',
    emptyDesc:   'Artemis clarifies requirements before generating a blueprint.',
    starters: [
      "I'm building a SaaS platform for project management",
      "I want to create a mobile app for fitness tracking",
      "Help me design a real-time collaboration tool",
    ],
  },
  curator: {
    label:       'Curator',
    description: 'Post-pipeline refinement agent',
    accent:      'text-rose-700',
    accentBg:    'bg-rose-50 border-rose-200',
    avatarClass: 'bg-rose-100 border-rose-200',
    icon:        ({ size = 16, className = '' }) => <Sparkles size={size} className={className} />,
    placeholder: "Ask the Curator to review or improve… type / for skills",
    emptyTitle:  'Refine your blueprint',
    emptyDesc:   'The Curator reviews and improves blueprints with expert precision.',
    starters: [
      "Analyze the security model in my blueprint",
      "What are the biggest architectural risks?",
      "Review the API design for REST compliance",
    ],
  },
  general: {
    label:       'General',
    description: 'Blueprint exploration & Q&A',
    accent:      'text-blue-700',
    accentBg:    'bg-blue-50 border-blue-200',
    avatarClass: 'bg-blue-100 border-blue-200',
    icon:        ({ size = 16, className = '' }) => <MessageSquare size={size} className={className} />,
    placeholder: "Ask anything about your blueprint… type / for skills",
    emptyTitle:  'Explore your blueprint',
    emptyDesc:   'Ask questions about your blueprint without modifying it.',
    starters: [
      "Explain the architecture to a non-technical stakeholder",
      "What does the testing strategy cover?",
      "Compare the data model to standard patterns",
    ],
  },
};

const SIDEBAR_NAV = [
  { id: 'chats',          label: 'Sessions',       icon: MessageSquare },
  { id: 'workspaces',     label: 'Workspaces',     icon: LayoutGrid    },
  { id: 'pipeline',       label: 'Pipeline',       icon: GitBranch     },
  { id: 'agent-settings', label: 'Agent Settings', icon: SlidersHorizontal },
  { id: 'connectors',     label: 'Connectors',     icon: Plug          },
];

// ── Persistence helpers ────────────────────────────────────────────────────────

function loadSessions(): ChatSession[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]'); } catch { return []; }
}
function saveSessions(s: ChatSession[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /**/ }
}
function loadArtemisId(chatId: string): string | null {
  try { return (JSON.parse(localStorage.getItem(SESSION_MAP) ?? '{}') as Record<string, string>)[chatId] ?? null; }
  catch { return null; }
}
function saveArtemisId(chatId: string, id: string): void {
  try {
    const m = JSON.parse(localStorage.getItem(SESSION_MAP) ?? '{}') as Record<string, string>;
    m[chatId] = id;
    localStorage.setItem(SESSION_MAP, JSON.stringify(m));
  } catch { /**/ }
}
function loadCuratorId(chatId: string): string | null {
  try { return (JSON.parse(localStorage.getItem(CURATOR_MAP) ?? '{}') as Record<string, string>)[chatId] ?? null; }
  catch { return null; }
}
function saveCuratorId(chatId: string, id: string): void {
  try {
    const m = JSON.parse(localStorage.getItem(CURATOR_MAP) ?? '{}') as Record<string, string>;
    m[chatId] = id;
    localStorage.setItem(CURATOR_MAP, JSON.stringify(m));
  } catch { /**/ }
}
function loadDismissed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]')); } catch { return new Set(); }
}
function persistDismiss(id: string): void {
  try {
    const s = loadDismissed(); s.add(id);
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...s]));
  } catch { /**/ }
}
function loadComposerPrefs(): Partial<ComposerPrefs> {
  try { return JSON.parse(localStorage.getItem(COMPOSER_PREF) ?? '{}') as Partial<ComposerPrefs>; } catch { return {}; }
}
function saveComposerPrefs(prefs: ComposerPrefs): void {
  try { localStorage.setItem(COMPOSER_PREF, JSON.stringify(prefs)); } catch { /**/ }
}

/**
 * Computes the pixel position of the textarea caret using a hidden mirror div.
 * Returns coordinates relative to the textarea element itself.
 */
function getTextareaCaretCoords(el: HTMLTextAreaElement): { top: number; left: number } {
  const div = document.createElement('div');
  const computed = window.getComputedStyle(el);
  const copyProps = [
    'direction','boxSizing','width','height','overflowX','overflowY',
    'borderTopWidth','borderRightWidth','borderBottomWidth','borderLeftWidth',
    'paddingTop','paddingRight','paddingBottom','paddingLeft',
    'fontStyle','fontVariant','fontWeight','fontSize','lineHeight',
    'fontFamily','textAlign','textTransform','textIndent','letterSpacing','wordSpacing',
  ] as const;
  div.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;`;
  copyProps.forEach(p => { (div.style as unknown as Record<string, string>)[p] = computed.getPropertyValue(p); });
  document.body.appendChild(div);
  const pos = el.selectionStart ?? el.value.length;
  div.textContent = el.value.slice(0, pos);
  const span = document.createElement('span');
  span.textContent = el.value.slice(pos) || '\u200b';
  div.appendChild(span);
  const spanRect = span.getBoundingClientRect();
  const elRect = el.getBoundingClientRect();
  document.body.removeChild(div);
  return { top: spanRect.top - elRect.top + el.scrollTop, left: spanRect.left - elRect.left };
}

let _c = 0;
function genId(p = 'id'): string { return `${p}-${Date.now()}-${++_c}`; }
function autoTitle(messages: ChatMessage[]): string {
  const f = messages.find(m => m.role === 'user');
  return f ? f.content.slice(0, 48) + (f.content.length > 48 ? '…' : '') : 'New chat';
}
function groupSessions(sessions: ChatSession[]): Array<{ label: string; sessions: ChatSession[] }> {
  const now = Date.now();
  const today = new Date(new Date().toDateString()).getTime();
  const g: Record<string, ChatSession[]> = { Starred: [], Today: [], Yesterday: [], 'This week': [], Older: [] };
  for (const s of sessions) {
    if (s.starred) { g['Starred']!.push(s); continue; }
    const t = new Date(s.updatedAt).getTime();
    if (t >= today)              g['Today']!.push(s);
    else if (t >= today - 864e5) g['Yesterday']!.push(s);
    else if (now - t < 7 * 864e5) g['This week']!.push(s);
    else                         g['Older']!.push(s);
  }
  return Object.entries(g).filter(([, v]) => v.length > 0).map(([label, sessions]) => ({ label, sessions }));
}

// ── Hook: detect system status notices dynamically ─────────────────────────────

function useSystemNotices(): StatusNotice[] {
  const [notices, setNotices] = useState<StatusNotice[]>([]);
  useEffect(() => {
    const check = async () => {
      const fresh: StatusNotice[] = [];
      try {
        const r = await fetch('/api/v1/health', { signal: AbortSignal.timeout(5000) });
        if (!r.ok) {
          fresh.push({ id: 'api-degraded', level: 'warning', message: 'API is experiencing issues — responses may be slow.' });
        } else {
          const data = await r.json() as { ok: boolean; notices?: StatusNotice[] };
          if (data.notices?.length) fresh.push(...data.notices);
        }
      } catch {
        fresh.push({ id: 'api-offline', level: 'error', message: 'Cannot reach the ATOMIC API. Check your connection.' });
      }
      setNotices(fresh);
    };
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, []);
  return notices;
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function Chat() {
  const navigate = useNavigate();

  // Session state
  const [sessions,        setSessions]        = useState<ChatSession[]>(loadSessions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [sidebarOpen,     setSidebarOpen]     = useState(true);
  const [sidebarNav,      setSidebarNav]      = useState('chats');
  const [searchQuery,     setSearchQuery]     = useState('');
  const [renamingId,      setRenamingId]      = useState<string | null>(null);
  const [renameValue,     setRenameValue]     = useState('');

  // Composer — init from persisted prefs
  const [input,            setInput]            = useState('');
  const [isStreaming,      setIsStreaming]       = useState(false);
  const [composerConfig,   setComposerConfig]   = useState<ComposerConfig>(() => {
    const p = loadComposerPrefs();
    return {
      mode:           'artemis',
      model:          p.model           ?? 'openai/gpt-5.4',
      effort:         p.effort          ?? 'low',
      thinkingEnabled:p.thinkingEnabled ?? false,
      activeSkillIds: [],
      webSearch:      true,
      sourceRestricted: false,
    };
  });

  // Popovers
  const [showPlusMenu,     setShowPlusMenu]     = useState(false);
  const [plusTab,          setPlusTab]          = useState<'context' | 'capabilities' | 'tools'>('context');

  // Slash picker — slashPos is the caret-relative coords inside the textarea
  const [slashOpen,  setSlashOpen]  = useState(false);
  const [slashQuery, setSlashQuery] = useState('');
  const [slashIdx,   setSlashIdx]   = useState(0);
  const [slashPos,   setSlashPos]   = useState<{ left: number } | null>(null);

  // Workspace panel
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [wsTab,         setWsTab]         = useState<string>('brief');
  const [bpVersions,    setBpVersions]    = useState<BlueprintVersionMeta[]>([]);
  const [selectedVer,   setSelectedVer]   = useState<number | null>(null);
  const [activeBp,      setActiveBp]      = useState<ActiveBlueprint | null>(null);
  const [activeBpLoading, setActiveBpLoading] = useState(false);

  // Artemis
  const [workspace,     setWorkspace]     = useState<ArtemisWorkspace | null>(null);
  const [briefApproved, setBriefApproved] = useState(false);
  const [isListening,   setIsListening]   = useState(false);

  // System notices
  const dynamicNotices   = useSystemNotices();
  const [dismissed,      setDismissed]    = useState<Set<string>>(loadDismissed);
  const activeNotices    = useMemo(
    () => dynamicNotices.filter(n => !dismissed.has(n.id)),
    [dynamicNotices, dismissed],
  );

  // Refs
  const bottomRef     = useRef<HTMLDivElement>(null);
  const inputRef      = useRef<HTMLTextAreaElement>(null);
  const abortRef      = useRef<AbortController | null>(null);
  const recognitionRef= useRef<unknown>(null);
  const plusMenuRef   = useRef<HTMLDivElement>(null);
  const renameRef     = useRef<HTMLInputElement>(null);
  const fileRef       = useRef<HTMLInputElement>(null);
  const slashRef      = useRef<HTMLDivElement>(null);
  const slashListRef  = useRef<HTMLDivElement>(null);

  // Derived
  const activeSession = useMemo(() => sessions.find(s => s.id === activeSessionId) ?? null, [sessions, activeSessionId]);
  const hasMessages   = (activeSession?.messages.length ?? 0) > 0;
  const modeMeta      = MODE_META[composerConfig.mode];

  const allModels = useMemo(() => {
    const seen = new Set<string>(); const list: { id: string; name: string; provider: string }[] = [];
    for (const p of PROVIDERS) for (const m of p.models) {
      if (!seen.has(m.id)) { seen.add(m.id); list.push({ id: m.id, name: m.name, provider: p.name }); }
    }
    return list;
  }, []);

  const slashSkills = useMemo(() => {
    const q = slashQuery.toLowerCase();
    return BUILT_IN_SKILLS.filter(s =>
      !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    ).slice(0, 8);
  }, [slashQuery]);

  // Persist sessions
  useEffect(() => { saveSessions(sessions); }, [sessions]);

  // Persist composer model/effort/thinking preferences
  useEffect(() => {
    saveComposerPrefs({ model: composerConfig.model, effort: composerConfig.effort, thinkingEnabled: composerConfig.thinkingEnabled });
  }, [composerConfig.model, composerConfig.effort, composerConfig.thinkingEnabled]);

  // Scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeSession?.messages.length, activeSessionId]);

  // Auto-focus rename
  useEffect(() => { if (renamingId) renameRef.current?.focus(); }, [renamingId]);

  // Close plus menu on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node)) setShowPlusMenu(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // Model/effort popover outside-click is now handled inside ModelEffortSelector itself.

  // Close slash on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (slashRef.current && !slashRef.current.contains(e.target as Node)) setSlashOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  // Poll Artemis workspace
  useEffect(() => {
    if (!activeSessionId || composerConfig.mode !== 'artemis') return;
    const aid = loadArtemisId(activeSessionId);
    if (!aid) return;
    const poll = async () => {
      try {
        const r = await fetch(`/api/v1/artemis/${aid}/workspace`);
        if (r.ok) { const d = await r.json() as { workspace?: ArtemisWorkspace }; if (d.workspace) setWorkspace(d.workspace); }
      } catch { /**/ }
    };
    poll(); const id = setInterval(poll, 4000); return () => clearInterval(id);
  }, [activeSessionId, composerConfig.mode]);

  // Load blueprint data + versions when workspace panel opens (or after messages change)
  const loadActiveBp = useCallback(async () => {
    try {
      const r = await fetch('/api/v1/blueprints?limit=1');
      if (!r.ok) return;
      const d = await r.json() as { blueprints?: { id: string; quality_score?: number; intent?: { product_name?: string } }[] };
      const bpMeta = d.blueprints?.[0];
      if (!bpMeta) return;
      const id = bpMeta.id;
      const [bpRes, verRes] = await Promise.all([
        fetch(`/api/v1/blueprints/${id}`),
        fetch(`/api/v1/blueprints/${id}/versions`),
      ]);
      if (bpRes.ok) {
        const bpData = await bpRes.json() as {
          blueprint?: {
            sections?: Record<string, { title?: string; content?: string } | string>;
            pillars?: Record<string, { summary?: string; score?: number }>;
            quality_score?: number;
            intent?: { product_name?: string };
          };
        };
        const bp = bpData.blueprint;
        if (bp) {
          setActiveBp({
            id,
            productName: bp.intent?.product_name ?? bpMeta.intent?.product_name ?? 'Blueprint',
            qualityScore: bp.quality_score ?? bpMeta.quality_score ?? 0,
            sections: (bp.sections ?? {}) as Record<string, { title: string; content: string } | string>,
            pillars: bp.pillars ?? {},
          });
        }
      }
      if (verRes.ok) {
        const d2 = await verRes.json() as { versions?: BlueprintVersionMeta[] };
        if (d2.versions) setBpVersions(d2.versions);
      }
    } catch { /**/ }
  }, []);

  useEffect(() => {
    if (!workspaceOpen) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data-load kickoff (intentional)
    setActiveBpLoading(true);
    loadActiveBp().finally(() => setActiveBpLoading(false));
  }, [workspaceOpen, activeSession?.messages.length, loadActiveBp]);

  // While streaming + workspace open, refresh blueprint every 2 s to show live content
  useEffect(() => {
    if (!isStreaming || !workspaceOpen) return;
    const id = setInterval(() => { void loadActiveBp(); }, 2000);
    return () => clearInterval(id);
  }, [isStreaming, workspaceOpen, loadActiveBp]);

  // ── Session management ─────────────────────────────────────────────────────

  const createSession = useCallback((mode: ChatMode = composerConfig.mode) => {
    const s: ChatSession = {
      id: genId('chat'), mode, title: 'New chat', messages: [], starred: false,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    setSessions(prev => [s, ...prev]);
    setActiveSessionId(s.id);
    setComposerConfig(c => ({ ...c, mode }));
    setWorkspace(null); setBriefApproved(false); setInput('');
    return s;
  }, [composerConfig.mode]);

  const deleteSession = useCallback((id: string) => {
    setSessions(prev => prev.filter(s => s.id !== id));
    if (activeSessionId === id) setActiveSessionId(null);
  }, [activeSessionId]);

  const toggleStar = useCallback((id: string) => {
    setSessions(prev => prev.map(s => s.id === id ? { ...s, starred: !s.starred } : s));
  }, []);

  const commitRename = () => {
    if (!renamingId) return;
    const t = renameValue.trim();
    if (t) setSessions(prev => prev.map(s => s.id === renamingId ? { ...s, title: t } : s));
    setRenamingId(null);
  };

  const updateMsgs = useCallback((sid: string, updater: (msgs: ChatMessage[]) => ChatMessage[]) => {
    setSessions(prev => prev.map(s => {
      if (s.id !== sid) return s;
      const msgs = updater(s.messages);
      return {
        ...s, messages: msgs, updatedAt: new Date().toISOString(),
        title: s.title === 'New chat' && msgs.some(m => m.role === 'user') ? autoTitle(msgs) : s.title,
      };
    }));
  }, []);

  // ── Messaging ─────────────────────────────────────────────────────────────

  const sendMessage = useCallback(async () => {
    const text = input.trim(); if (!text || isStreaming) return;
    setInput('');
    let sid = activeSessionId;
    if (!sid) { const s = createSession(); sid = s.id; }
    setIsStreaming(true);
    const userMsg: ChatMessage = { id: genId('msg'), role: 'user', content: text, timestamp: new Date().toISOString() };
    const asstMsg: ChatMessage = { id: genId('msg'), role: 'assistant', content: '', timestamp: new Date().toISOString(), isStreaming: true };
    updateMsgs(sid, msgs => [...msgs, userMsg, asstMsg]);
    abortRef.current = new AbortController();
    try {
      const baseConfig = await loadClientConfig();
      // Map UI model selection → proModel so the server config-merge honors it.
      // effort and thinkingEnabled are sent as configOverride fields that all
      // three chat routes now forward into the resolved ModelConfig.
      const config = {
        ...(baseConfig ?? {}),
        ...(composerConfig.model        ? { proModel: composerConfig.model }                 : {}),
        ...(composerConfig.effort       ? { effort: composerConfig.effort }                  : {}),
        ...(composerConfig.thinkingEnabled !== undefined ? { thinkingEnabled: composerConfig.thinkingEnabled } : {}),
      };
      let endpoint: string; let body: Record<string, unknown>;
      if (composerConfig.mode === 'artemis') {
        let aid = loadArtemisId(sid);
        if (!aid) {
          const res = await fetch('/api/v1/artemis/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ config }) });
          if (!res.ok) throw new Error('Failed to create Artemis session');
          aid = ((await res.json()) as { sessionId: string }).sessionId;
          saveArtemisId(sid, aid);
        }
        endpoint = `/api/v1/artemis/${aid}/chat`;
        body = { message: text, config, activeSkillIds: composerConfig.activeSkillIds };
      } else if (composerConfig.mode === 'curator') {
        // Curator route requires a sessionId and the current blueprint.
        // We fetch the latest saved blueprint (if any) and create a curator
        // session keyed to this chat session so context is preserved across turns.
        let cid = loadCuratorId(sid);
        let blueprintPayload: unknown = null;
        try {
          const bpRes = await fetch('/api/v1/blueprints?limit=1');
          if (bpRes.ok) {
            const bpData = await bpRes.json() as { blueprints?: { id: string }[] };
            const bpId = bpData.blueprints?.[0]?.id;
            if (bpId) {
              if (!cid) {
                const csRes = await fetch('/api/v1/curator/session', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ blueprintId: bpId }),
                });
                if (csRes.ok) {
                  cid = ((await csRes.json()) as { sessionId: string }).sessionId;
                  saveCuratorId(sid, cid);
                }
              }
              const fullBpRes = await fetch(`/api/v1/blueprints/${bpId}`);
              if (fullBpRes.ok) blueprintPayload = ((await fullBpRes.json()) as { blueprint: unknown }).blueprint;
            }
          }
        } catch { /* network error — fall through with null blueprint */ }
        if (!cid) throw new Error('Could not create Curator session — no blueprint available yet. Generate a blueprint first.');
        endpoint = `/api/v1/curator/${cid}/chat`;
        body = { message: text, blueprint: blueprintPayload, config, activeSkillIds: composerConfig.activeSkillIds };
      } else {
        endpoint = '/api/v1/chat/general';
        body = { message: text, config };
      }
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: abortRef.current.signal });
      if (!res.ok) throw new Error(((await res.json()) as { error?: string }).error ?? `HTTP ${res.status}`);
      const reader = res.body?.getReader(); if (!reader) throw new Error('No response body');
      const dec = new TextDecoder(); let acc = '';
      // eslint-disable-next-line no-constant-condition -- SSE stream read loop, exits on {done: true}
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        for (const line of dec.decode(value, { stream: true }).split('\n')) {
          if (!line.startsWith('data: ')) continue;
          const p = line.slice(6); if (p === '[DONE]') break;
          try { const j = JSON.parse(p) as { chunk?: string }; if (j.chunk) { acc += j.chunk; updateMsgs(sid, msgs => { const c = [...msgs]; const l = c[c.length - 1]; if (l?.role === 'assistant') c[c.length - 1] = { ...l, content: acc, isStreaming: true }; return c; }); } } catch { /**/ }
        }
      }
      updateMsgs(sid, msgs => { const c = [...msgs]; const l = c[c.length - 1]; if (l?.role === 'assistant') c[c.length - 1] = { ...l, content: acc, isStreaming: false }; return c; });
    } catch (err: unknown) {
      const msg = err instanceof Error && err.name === 'AbortError' ? '_(interrupted)_' : `⚠️ ${err instanceof Error ? err.message : 'Error'}`;
      updateMsgs(sid, msgs => { const c = [...msgs]; const l = c[c.length - 1]; if (l?.role === 'assistant') c[c.length - 1] = { ...l, content: msg, isStreaming: false }; return c; });
    } finally { setIsStreaming(false); abortRef.current = null; }
  }, [input, isStreaming, composerConfig, activeSessionId, createSession, updateMsgs]);

  // ── Slash command ──────────────────────────────────────────────────────────

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInput(val);
    const last = val.lastIndexOf('/');
    if (last !== -1 && (last === 0 || /[\s\n]/.test(val[last - 1] ?? ''))) {
      setSlashQuery(val.slice(last + 1)); setSlashOpen(true); setSlashIdx(0);
      // Anchor the picker popup to the caret's horizontal pixel position
      if (e.target) {
        try {
          const coords = getTextareaCaretCoords(e.target);
          setSlashPos({ left: coords.left });
        } catch { setSlashPos(null); }
      }
    } else {
      setSlashOpen(false);
      setSlashPos(null);
    }
  };

  const applySlashSkill = useCallback((skillId: string) => {
    const skill = BUILT_IN_SKILLS.find(s => s.id === skillId);
    // Toggle skill activation
    setComposerConfig(c => {
      const has = c.activeSkillIds.includes(skillId);
      return { ...c, activeSkillIds: has ? c.activeSkillIds.filter(i => i !== skillId) : [...c.activeSkillIds, skillId] };
    });
    // Inject `#SkillName ` into the composer text where the `/query` was
    const last = input.lastIndexOf('/');
    const before = last !== -1 ? input.slice(0, last) : input;
    const skillRef = skill ? `#${skill.name} ` : '';
    setInput(before + skillRef);
    setSlashOpen(false);
    setTimeout(() => {
      const el = inputRef.current;
      if (el) {
        const pos = (before + skillRef).length;
        el.setSelectionRange(pos, pos);
        el.focus();
      }
    }, 10);
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIdx(i => Math.min(i + 1, slashSkills.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIdx(i => Math.max(i - 1, 0)); }
      else if (e.key === 'Enter') { e.preventDefault(); const s = slashSkills[slashIdx]; if (s) applySlashSkill(s.id); }
      else if (e.key === 'Escape') { e.preventDefault(); setSlashOpen(false); }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  };

  // Keep highlighted item in view
  useEffect(() => {
    const el = slashListRef.current?.children[slashIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [slashIdx]);

  // ── Voice input ────────────────────────────────────────────────────────────

  const handleVoice = useCallback(() => {
    if (isListening) { (recognitionRef.current as { stop: () => void } | null)?.stop(); setIsListening(false); return; }
    const SR = (window as unknown as { SpeechRecognition?: new () => unknown; webkitSpeechRecognition?: new () => unknown }).SpeechRecognition
      ?? (window as unknown as { webkitSpeechRecognition?: new () => unknown }).webkitSpeechRecognition;
    if (!SR) { console.warn('[Chat] Speech recognition not supported in this browser'); return; }
    type SR_ = { continuous: boolean; interimResults: boolean; lang: string; onstart: (() => void) | null; onend: (() => void) | null; onresult: ((e: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null; onerror: ((e: { error: string }) => void) | null; start(): void; stop(): void; };
    const rec = new (SR as new () => SR_)();
    recognitionRef.current = rec;
    rec.continuous = true; rec.interimResults = false; rec.lang = 'en-US';
    rec.onstart  = () => setIsListening(true);
    rec.onend    = () => setIsListening(false);
    rec.onerror  = (ev) => { if (ev.error === 'not-allowed') console.warn('[Chat] Microphone access denied'); setIsListening(false); };
    rec.onresult = (ev) => { let t = ''; for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i]?.isFinal) t += ev.results[i]?.[0]?.transcript ?? ''; if (t) setInput(p => p + (p && !p.endsWith(' ') ? ' ' : '') + t.trim()); };
    rec.start();
  }, [isListening]);

  // ── Artemis approve ────────────────────────────────────────────────────────

  const approveBrief = async () => {
    if (!activeSessionId) return;
    const aid = loadArtemisId(activeSessionId); if (!aid) return;
    const r = await fetch(`/api/v1/artemis/${aid}/approve`, { method: 'POST' });
    if (r.ok) {
      setBriefApproved(true);
      updateMsgs(activeSessionId, msgs => [...msgs, { id: genId('msg'), role: 'system', content: '✅ **Project Brief approved.** Go to the main page to generate your blueprint.', timestamp: new Date().toISOString() }]);
    }
  };

  // ── Filtered sessions ──────────────────────────────────────────────────────

  const filteredSessions = useMemo(() => {
    if (!searchQuery.trim()) return sessions;
    const q = searchQuery.toLowerCase();
    return sessions.filter(s => s.title.toLowerCase().includes(q) || s.messages.some(m => m.content.toLowerCase().includes(q)));
  }, [sessions, searchQuery]);

  const grouped = useMemo(() => groupSessions(filteredSessions), [filteredSessions]);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex h-screen overflow-hidden" style={{ background: '#f5f4f0' }}>

      {/* ── Left sidebar ──────────────────────────────────────────────────── */}
      <aside
        className={`flex-col border-r border-white/10 transition-all duration-300 overflow-hidden shrink-0
                    ${sidebarOpen ? 'w-60' : 'w-0'}`}
        style={{ background: '#1c1612' }}
        aria-label="Chat sidebar"
      >
        <div className="flex flex-col h-full min-w-60">
          {/* Header */}
          <div className="flex items-center justify-between px-4 pt-4 pb-3 shrink-0">
            <div>
              <div className="font-mono font-bold text-white text-sm tracking-tighter">ATOMIC</div>
              <div className="text-[10px] text-white/40 mt-0.5">Chat v5</div>
            </div>
            <button onClick={() => navigate('/')} className="flex items-center gap-1 text-[11px] text-white/40 hover:text-white/70 transition-colors">
              <ArrowLeft size={11} /> Home
            </button>
          </div>

          {/* New session */}
          <div className="px-3 pb-2 shrink-0">
            <button
              onClick={() => createSession()}
              className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium bg-white/10 text-white hover:bg-white/18 transition-colors"
            >
              <Plus size={13} /> New session
            </button>
          </div>

          {/* Nav */}
          <div className="px-2 pb-2 shrink-0 space-y-0.5">
            {SIDEBAR_NAV.map(nav => {
              const Icon = nav.icon; const isActive = sidebarNav === nav.id;
              return (
                <button key={nav.id} onClick={() => {
                  setSidebarNav(nav.id);
                  if (nav.id === 'workspaces') setWorkspaceOpen(true);
                }}
                  className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-[11px] font-medium transition-colors
                    ${isActive ? 'bg-white/15 text-white' : 'text-white/40 hover:text-white/70 hover:bg-white/8'}`}
                  aria-current={isActive ? 'page' : undefined}
                >
                  <Icon size={12} />
                  {nav.label}
                  {nav.id === 'connectors' && <span className="ml-auto text-[9px] bg-white/10 text-white/40 px-1 py-0.5 rounded">Beta</span>}
                </button>
              );
            })}
          </div>

          <div className="h-px bg-white/8 mx-3 mb-2 shrink-0" />

          {/* Sessions list */}
          {sidebarNav === 'chats' && (
            <>
              <div className="px-3 pb-2 shrink-0">
                <div className="relative">
                  <Search size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-white/30" />
                  <input value={searchQuery} onChange={e => setSearchQuery(e.target.value)} placeholder="Search sessions…"
                    className="w-full pl-7 pr-3 py-1.5 rounded-lg text-xs bg-white/8 border border-white/10 text-white placeholder-white/30 focus:outline-none focus:border-white/25 transition-colors"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto px-2 pb-4 space-y-3" role="list" aria-label="Chat sessions">
                {grouped.length === 0 && <p className="text-[11px] text-white/30 text-center py-6">{searchQuery ? 'No results' : 'No sessions yet'}</p>}
                {grouped.map(({ label, sessions: gs }) => (
                  <div key={label} role="group" aria-label={label}>
                    <p className="text-[9px] font-semibold uppercase tracking-widest text-white/30 px-2 mb-1">{label}</p>
                    {gs.map(s => (
                      <SessionItem key={s.id} session={s} isActive={s.id === activeSessionId}
                        isRenaming={renamingId === s.id} renameValue={renameValue} renameInputRef={renameRef}
                        onSelect={() => { setActiveSessionId(s.id); setComposerConfig(c => ({ ...c, mode: s.mode })); setWorkspace(null); setBriefApproved(false); }}
                        onStar={() => toggleStar(s.id)} onRename={() => { setRenamingId(s.id); setRenameValue(s.title); }}
                        onRenameChange={setRenameValue} onRenameCommit={commitRename} onDelete={() => deleteSession(s.id)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Workspaces */}
          {sidebarNav === 'workspaces' && (
            <div className="flex-1 overflow-y-auto px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-white/30 mb-3">Workspaces</p>
              {workspace ? (
                <div className="p-3 rounded-xl bg-white/8 border border-white/10">
                  <div className="flex items-center gap-2 mb-2">
                    <div className="w-2 h-2 rounded-full" style={{ background: workspace.confidenceScore >= 0.75 ? '#22c55e' : '#f59e0b' }} />
                    <span className="text-xs text-white font-medium">Artemis Workspace</span>
                  </div>
                  <div className="text-[11px] text-white/50 mb-2">Confidence: {Math.round(workspace.confidenceScore * 100)}%</div>
                  {!!workspace.brief && !briefApproved && <button onClick={approveBrief} className="w-full py-1.5 text-[11px] font-semibold bg-violet-500 hover:bg-violet-400 text-white rounded-lg transition-colors">Approve Brief</button>}
                  {briefApproved && <div className="flex items-center gap-1.5 text-[11px] text-emerald-400"><CheckCircle2 size={12} /> Brief approved</div>}
                </div>
              ) : <p className="text-[11px] text-white/30">No active workspaces</p>}
            </div>
          )}

          {/* Pipeline */}
          {sidebarNav === 'pipeline' && (
            <div className="flex-1 overflow-y-auto px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-white/30 mb-3">Pipeline</p>
              <button onClick={() => navigate('/')} className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl bg-white/8 hover:bg-white/15 border border-white/10 text-white transition-colors">
                <span className="text-xs font-medium">Generate Blueprint</span><ChevronRight size={12} className="text-white/40" />
              </button>
            </div>
          )}

          {/* Agent Settings */}
          {sidebarNav === 'agent-settings' && (
            <div className="flex-1 overflow-y-auto px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-white/30 mb-3">Agent Settings</p>
              <button onClick={() => navigate('/settings')} className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl bg-white/8 hover:bg-white/15 border border-white/10 text-white transition-colors">
                <span className="text-xs font-medium">Open Settings</span><ChevronRight size={12} className="text-white/40" />
              </button>
            </div>
          )}

          {/* Connectors */}
          {sidebarNav === 'connectors' && (
            <div className="flex-1 overflow-y-auto px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-white/30 mb-3">Connectors</p>
              <div className="p-3 rounded-xl bg-white/8 border border-white/10 text-center">
                <Plug size={18} className="text-white/20 mx-auto mb-2" />
                <p className="text-[11px] text-white/40 leading-relaxed">GitHub, Linear, Notion and more — arriving in v5.1.</p>
              </div>
            </div>
          )}
        </div>
      </aside>

      {/* ── Main column ─────────────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col h-screen overflow-hidden">

        {/* Top bar */}
        <header className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-gray-200" style={{ background: '#f5f4f0' }}>
          <button onClick={() => setSidebarOpen(v => !v)} className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors" aria-label={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}>
            {sidebarOpen ? <PanelLeftClose size={16} /> : <PanelLeft size={16} />}
          </button>

          {/* Mode pills */}
          <div className="flex items-center gap-0.5 bg-white border border-gray-200 rounded-xl p-0.5" role="group" aria-label="Agent mode">
            {(['artemis', 'curator', 'general'] as ChatMode[]).map(m => {
              const meta = MODE_META[m]; const Icon = meta.icon; const active = composerConfig.mode === m;
              return (
                <button key={m} onClick={() => setComposerConfig(c => ({ ...c, mode: m }))}
                  className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all
                    ${active ? 'bg-gray-900 text-white shadow-sm' : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'}`}
                  aria-pressed={active}
                >
                  <Icon size={11} className={active ? '' : meta.accent} />{meta.label}
                </button>
              );
            })}
          </div>

          <div className="flex-1" />

          {/* Active skill badges */}
          {composerConfig.activeSkillIds.slice(0, 2).map(id => {
            const skill = BUILT_IN_SKILLS.find(s => s.id === id);
            return skill ? (
              <span key={id} className="flex items-center gap-1 px-2 py-0.5 bg-violet-100 text-violet-700 text-[10px] font-medium rounded-full">
                <Hash size={9} />{skill.name}
                <button onClick={() => setComposerConfig(c => ({ ...c, activeSkillIds: c.activeSkillIds.filter(i => i !== id) }))} className="ml-0.5" aria-label={`Remove ${skill.name} skill`}><X size={9} /></button>
              </span>
            ) : null;
          })}
          {composerConfig.activeSkillIds.length > 2 && <span className="text-[10px] text-gray-400">+{composerConfig.activeSkillIds.length - 2}</span>}

          {/* Model + effort selector (two-level linked popover) */}
          <ModelEffortSelector
            composerConfig={composerConfig}
            setComposerConfig={setComposerConfig}
            allModels={allModels}
          />

          {isStreaming && <span className="flex items-center gap-1.5 text-xs text-violet-600" aria-live="polite"><Loader2 size={12} className="animate-spin" /> Streaming…</span>}

          <button onClick={() => createSession()} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-xl bg-gray-900 text-white hover:bg-gray-700 transition-colors">
            <Plus size={12} /> New
          </button>

          <button onClick={() => setWorkspaceOpen(v => !v)}
            className={`p-1.5 rounded-lg transition-colors ${workspaceOpen ? 'bg-gray-200 text-gray-700' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'}`}
            aria-label={workspaceOpen ? 'Close workspace panel' : 'Open workspace panel'}
            aria-expanded={workspaceOpen}
          >
            {workspaceOpen ? <PanelRightClose size={16} /> : <PanelRight size={16} />}
          </button>
        </header>

        {/* System Status Banner */}
        {activeNotices.length > 0 && (
          <div role="alert" aria-live="polite">
            {activeNotices.map(n => (
              <StatusBanner key={n.id} notice={n} onDismiss={() => { persistDismiss(n.id); setDismissed(loadDismissed()); }} />
            ))}
          </div>
        )}

        {/* Content row */}
        <div className="flex-1 min-h-0 flex overflow-hidden">

          {/* Main content: two completely separate subtrees */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {!hasMessages ? (
              <EmptyGreetingState
                modeMeta={modeMeta}
                currentMode={composerConfig.mode}
                onQuickAction={(action) => {
                  if (action.route) { navigate(action.route); return; }
                  setComposerConfig(c => ({ ...c, mode: action.mode }));
                  const s = createSession(action.mode);
                  void s;
                  setInput(action.starter);
                  setTimeout(() => inputRef.current?.focus(), 50);
                }}
                onStarterClick={(text) => {
                  if (!activeSessionId) createSession();
                  setInput(text);
                  setTimeout(() => inputRef.current?.focus(), 50);
                }}
              />
            ) : (
              <ActiveThreadState
                messages={activeSession!.messages}
                modeMeta={modeMeta}
                bottomRef={bottomRef}
              />
            )}
          </div>

          {/* Workspace Panel */}
          {workspaceOpen && (
            <WorkspacePanel
              currentMode={composerConfig.mode}
              workspace={workspace}
              briefApproved={briefApproved}
              bpVersions={bpVersions}
              selectedVer={selectedVer}
              activeBp={activeBp}
              activeBpLoading={activeBpLoading}
              isStreaming={isStreaming}
              wsTab={wsTab}
              onTabChange={setWsTab}
              onSelectVersion={setSelectedVer}
              onApproveBrief={approveBrief}
              onClose={() => setWorkspaceOpen(false)}
            />
          )}
        </div>

        {/* Composer bar — position:relative so slash picker can be caret-anchored */}
        <div className="relative shrink-0 border-t border-gray-200 px-4 py-3" style={{ background: '#f5f4f0' }}>

          {/* Slash skill picker — absolutely anchored to textarea caret position */}
          {slashOpen && (
            <div ref={slashRef}
              className="absolute z-50 bg-white border border-gray-200 rounded-2xl shadow-xl overflow-hidden"
              style={{
                bottom: 'calc(100% - 12px)',
                left: slashPos ? `calc(${slashPos.left}px + 3.5rem)` : '3.5rem',
                width: '20rem',
                maxWidth: 'calc(100vw - 2rem)',
              }}
              role="listbox" aria-label="Skill picker" aria-activedescendant={slashSkills[slashIdx]?.id}
            >
              <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-100" style={{ background: '#1c1612' }}>
                <Hash size={12} className="text-white/50" />
                <span className="text-xs text-white/70 font-medium">Skill Picker</span>
                {slashQuery && <span className="text-[10px] text-white/40 ml-1">{"\""}{slashQuery}{"\""}</span>}
                <span className="text-[10px] text-white/40 ml-auto">↑↓ navigate · Enter select · Esc dismiss</span>
              </div>
              <div ref={slashListRef} className="max-h-52 overflow-y-auto py-1">
                {slashSkills.length === 0
                  ? <p className="text-xs text-gray-400 text-center py-4">No skills match {"\""}{slashQuery}{"\""}</p>
                  : slashSkills.map((skill, i) => {
                      const isActive = composerConfig.activeSkillIds.includes(skill.id);
                      const isHighlighted = i === slashIdx;
                      return (
                        <button key={skill.id} id={skill.id}
                          onClick={() => applySlashSkill(skill.id)}
                          className={`w-full flex items-start gap-3 px-3 py-2.5 text-left transition-colors
                            ${isHighlighted ? 'bg-gray-100' : isActive ? 'bg-violet-50' : 'hover:bg-gray-50'}`}
                          role="option" aria-selected={isActive}
                        >
                          <div className={`w-6 h-6 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${isActive ? 'bg-violet-100' : 'bg-gray-100'}`}>
                            <Hash size={11} className={isActive ? 'text-violet-600' : 'text-gray-400'} />
                          </div>
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`text-xs font-semibold ${isActive ? 'text-violet-700' : 'text-gray-800'}`}>{skill.name}</span>
                              {isActive && <span className="text-[9px] bg-violet-100 text-violet-600 px-1.5 py-0.5 rounded-full font-medium">Active</span>}
                            </div>
                            <p className="text-[11px] text-gray-500 leading-tight mt-0.5">{skill.description}</p>
                          </div>
                        </button>
                      );
                    })
                }
              </div>
            </div>
          )}

          <div className="flex items-end gap-2 bg-white border border-gray-200 rounded-2xl px-3 py-2.5 focus-within:border-gray-300 focus-within:shadow-md shadow-sm transition-all">

            {/* + Composer popover */}
            <div className="relative" ref={plusMenuRef}>
              <button onClick={() => setShowPlusMenu(v => !v)}
                className={`shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all
                  ${showPlusMenu ? 'bg-gray-900 text-white' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'}`}
                aria-haspopup="true" aria-expanded={showPlusMenu} aria-label="Open context and capabilities menu"
              >
                <Plus size={16} />
              </button>

              {showPlusMenu && (
                <PlusMenuPopover
                  tab={plusTab}
                  setTab={setPlusTab}
                  composerConfig={composerConfig}
                  setComposerConfig={setComposerConfig}
                  onClose={() => setShowPlusMenu(false)}
                  onInjectContext={(text) => {
                    setInput(prev => prev ? `${prev}\n\n${text}` : text);
                    setShowPlusMenu(false);
                  }}
                />
              )}
            </div>

            {/* Textarea */}
            <textarea ref={inputRef} value={input} onChange={handleInputChange} onKeyDown={handleKeyDown}
              placeholder={modeMeta.placeholder} rows={1} disabled={isStreaming}
              style={{ resize: 'none' }}
              className="flex-1 bg-transparent text-sm text-gray-900 placeholder-gray-400 focus:outline-none disabled:opacity-50 max-h-36 overflow-y-auto leading-relaxed py-1"
              aria-label="Message input" aria-describedby="composer-hint"
              aria-multiline="true"
              onInput={e => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight, 144)}px`; }}
            />

            {/* Voice */}
            <button type="button" onClick={handleVoice}
              className={`shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all ${isListening ? 'bg-red-100 text-red-500 animate-pulse' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-100'}`}
              aria-label={isListening ? 'Stop recording' : 'Start voice input'} aria-pressed={isListening}
            >
              {isListening ? <MicOff size={14} /> : <Mic size={14} />}
            </button>

            {/* Attach */}
            <button type="button" onClick={() => fileRef.current?.click()}
              className="shrink-0 w-8 h-8 rounded-xl flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
              aria-label="Attach file"
            >
              <Paperclip size={14} />
            </button>
            <input ref={fileRef} type="file" accept=".txt,.md,.json,.csv,.ts,.js,.tsx,.jsx,.html,.css,.yaml,.yml" className="hidden"
              onChange={e => { const f = e.target.files?.[0]; if (!f) return; const r = new FileReader(); r.onload = ev => setInput(p => p ? `${p}\n\n${ev.target?.result as string}` : ev.target?.result as string); r.readAsText(f); if (fileRef.current) fileRef.current.value = ''; }}
            />

            {/* Send/Stop */}
            <button onClick={isStreaming ? () => abortRef.current?.abort() : sendMessage}
              disabled={!isStreaming && !input.trim()}
              className={`shrink-0 w-8 h-8 rounded-xl flex items-center justify-center transition-all ${isStreaming ? 'bg-rose-100 text-rose-600 hover:bg-rose-200' : 'bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-30'}`}
              aria-label={isStreaming ? 'Stop generation' : 'Send message'}
            >
              {isStreaming ? <StopCircle size={15} /> : <Send size={14} />}
            </button>
          </div>

          <div className="flex items-center justify-between mt-1.5 px-1">
            <p id="composer-hint" className="text-[11px] text-gray-400">
              {composerConfig.mode === 'general' ? 'Read-only · cannot modify blueprint' : 'Enter to send · Shift+Enter for newline · / for skills'}
            </p>
            {composerConfig.activeSkillIds.length > 0 && (
              <p className="text-[11px] text-violet-600 font-medium" aria-live="polite">
                {composerConfig.activeSkillIds.length} skill{composerConfig.activeSkillIds.length > 1 ? 's' : ''} active
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── EmptyGreetingState — independent subtree ───────────────────────────────────

function EmptyGreetingState({ modeMeta, currentMode, onQuickAction, onStarterClick }: {
  modeMeta:       typeof MODE_META[ChatMode];
  currentMode:    ChatMode;
  onQuickAction:  (action: typeof QUICK_ACTIONS[number]) => void;
  onStarterClick: (text: string) => void;
}) {
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const ModeIcon = modeMeta.icon;

  return (
    <div className="flex-1 flex flex-col items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-xl text-center">
        {/* Greeting */}
        <div className="w-14 h-14 rounded-2xl bg-white border border-gray-200 shadow-sm flex items-center justify-center mx-auto mb-5">
          <ModeIcon size={26} className={modeMeta.accent} />
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-1">{greeting}</h2>
        <p className="text-sm text-gray-500 mb-8">{modeMeta.emptyDesc}</p>

        {/* Quick Action Pills */}
        <div className="flex flex-wrap gap-2 justify-center mb-8" role="group" aria-label="Quick actions">
          {QUICK_ACTIONS.map(action => {
            const Icon = action.icon;
            const isCurrent = action.mode === currentMode;
            return (
              <button key={action.id} onClick={() => onQuickAction(action)}
                className={`flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-medium border transition-all hover:shadow-sm
                  ${isCurrent ? 'bg-gray-900 text-white border-gray-900 hover:bg-gray-700' : 'bg-white text-gray-700 border-gray-200 hover:border-gray-300'}`}
              >
                <Icon size={13} className={isCurrent ? 'text-white' : 'text-gray-400'} />
                {action.label}
              </button>
            );
          })}
        </div>

        {/* Starters */}
        <p className="text-xs text-gray-400 mb-3">Or start with a prompt:</p>
        <div className="space-y-2">
          {modeMeta.starters.map((s, i) => (
            <button key={i} onClick={() => onStarterClick(s)}
              className="w-full text-left px-4 py-2.5 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 hover:border-gray-300 hover:shadow-sm transition-all group"
            >
              <span className="mr-2 text-gray-300 group-hover:text-gray-500 transition-colors">→</span>{s}
            </button>
          ))}
        </div>

        <p className="mt-6 text-[11px] text-gray-400">
          Type <kbd className="px-1.5 py-0.5 bg-gray-100 border border-gray-200 rounded text-[10px] font-mono">/</kbd> in the composer to activate a skill
        </p>
      </div>
    </div>
  );
}

// ── ActiveThreadState — independent subtree ────────────────────────────────────

function ActiveThreadState({ messages, modeMeta, bottomRef }: {
  messages:  ChatMessage[];
  modeMeta:  typeof MODE_META[ChatMode];
  bottomRef: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <div className="flex-1 overflow-y-auto px-6 py-6 space-y-5" role="log" aria-live="polite" aria-label="Conversation">
      {messages.map(msg => <MessageBubble key={msg.id} message={msg} modeMeta={modeMeta} />)}
      <div ref={bottomRef} />
    </div>
  );
}

// ── ContextAttachmentPanel ────────────────────────────────────────────────────
// Renders inside the + menu "Context" tab.
// All four actions inject real content into the composer via onInjectContext.

function ContextAttachmentPanel({ fileRef, onInjectContext, onClose }: {
  fileRef:          React.RefObject<HTMLInputElement | null>;
  onInjectContext:  (text: string) => void;
  onClose:          () => void;
}) {
  const imgRef          = useRef<HTMLInputElement>(null);
  const [githubOpen,    setGithubOpen]    = useState(false);
  const [githubUrl,     setGithubUrl]     = useState('');
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError,   setGithubError]   = useState('');
  const [projectOpen,   setProjectOpen]   = useState(false);
  const [projectText,   setProjectText]   = useState('');
  const [bpPickerOpen,  setBpPickerOpen]  = useState(false);
  const [recentBps,     setRecentBps]     = useState<{ id: string; name: string }[]>([]);
  const [loadingBps,    setLoadingBps]    = useState(false);
  const [loadingBpId,   setLoadingBpId]   = useState<string | null>(null);

  const openBlueprintPicker = async () => {
    setBpPickerOpen(v => !v);
    if (!bpPickerOpen && recentBps.length === 0) {
      setLoadingBps(true);
      try {
        const r = await fetch('/api/v1/blueprints?page=1&limit=6');
        if (r.ok) {
          const data = await r.json() as { blueprints?: { id: string; intent?: { product_name?: string } }[] };
          setRecentBps((data.blueprints ?? []).map(b => ({
            id: b.id,
            name: b.intent?.product_name ?? b.id.slice(0, 12),
          })));
        }
      } catch { /* network error — list stays empty */ }
      setLoadingBps(false);
    }
  };

  // Fetch executive_summary of a blueprint and inject into composer
  const injectBlueprint = async (bp: { id: string; name: string }) => {
    setLoadingBpId(bp.id);
    try {
      const r = await fetch(`/api/v1/blueprints/${bp.id}`);
      if (r.ok) {
        const d = await r.json() as { blueprint?: { sections?: Record<string, { content?: string } | string> } };
        const sec = d.blueprint?.sections?.executive_summary;
        const summary = typeof sec === 'string' ? sec : (sec as { content?: string } | undefined)?.content ?? '';
        onInjectContext(`**Blueprint context — ${bp.name}:**\n\n${summary.slice(0, 1200)}${summary.length > 1200 ? '\n\n*(truncated)*' : ''}`);
      }
    } catch { /* silently skip */ }
    setLoadingBpId(null);
  };

  // Parse a GitHub repo URL and fetch its README
  const fetchGitHub = async () => {
    if (!githubUrl.trim()) return;
    setGithubLoading(true); setGithubError('');
    try {
      const match = githubUrl.trim().match(/github\.com\/([^/]+)\/([^/?\s#]+)/);
      if (!match) { setGithubError('Enter a valid https://github.com/owner/repo URL.'); setGithubLoading(false); return; }
      const [, owner, repo] = match;
      const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/readme`, {
        headers: { Accept: 'application/vnd.github.v3+json' },
      });
      if (!res.ok) { setGithubError(`Repo not found or private (${res.status}).`); setGithubLoading(false); return; }
      const data = await res.json() as { content?: string; encoding?: string };
      const decoded = data.encoding === 'base64' && data.content
        ? atob(data.content.replace(/\n/g, ''))
        : (data.content ?? '');
      const snippet = decoded.slice(0, 2000) + (decoded.length > 2000 ? '\n\n*(truncated)*' : '');
      onInjectContext(`**GitHub README — ${owner}/${repo}:**\n\n${snippet}`);
    } catch { setGithubError('Network error. Check your connection.'); }
    setGithubLoading(false);
  };

  return (
    <div className="space-y-0.5">
      {/* Add files */}
      <button onClick={() => { fileRef.current?.click(); onClose(); }}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-gray-50 transition-colors"
      >
        <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center shrink-0"><Paperclip size={14} className="text-gray-500" /></div>
        <span className="text-xs font-medium text-gray-700">Add files</span>
        <ChevronRight size={12} className="ml-auto text-gray-300" />
      </button>
      <input ref={fileRef} type="file" className="hidden" />

      {/* Screenshot — uses image file picker (real browser action) */}
      <button onClick={() => { imgRef.current?.click(); }}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-gray-50 transition-colors"
      >
        <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center shrink-0"><Image size={14} className="text-gray-500" /></div>
        <span className="text-xs font-medium text-gray-700">Screenshot / Image</span>
        <ChevronRight size={12} className="ml-auto text-gray-300" />
      </button>
      <input ref={imgRef} type="file" accept="image/*" className="hidden"
        onChange={e => {
          const f = e.target.files?.[0];
          if (f) { onInjectContext(`[Image attached: ${f.name}]`); onClose(); }
          e.target.value = '';
        }}
      />

      {/* Add to project — inline text context */}
      <div>
        <button onClick={() => setProjectOpen(v => !v)}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-gray-50 transition-colors"
        >
          <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center shrink-0"><FolderOpen size={14} className="text-gray-500" /></div>
          <span className="text-xs font-medium text-gray-700">Add to project</span>
          {projectOpen ? <ChevronDown size={12} className="ml-auto text-gray-400" /> : <ChevronRight size={12} className="ml-auto text-gray-300" />}
        </button>
        {projectOpen && (
          <div className="mx-3 mb-1 space-y-1">
            <textarea
              value={projectText} onChange={e => setProjectText(e.target.value)}
              placeholder="Paste project context, requirements, or notes…"
              rows={3}
              className="w-full text-[11px] px-2.5 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-300 resize-none"
              autoFocus
            />
            <button
              disabled={!projectText.trim()}
              onClick={() => { onInjectContext(`---\nProject context:\n${projectText.trim()}\n---`); }}
              className="w-full py-1.5 text-[11px] bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-30 transition-colors"
            >Add context</button>
          </div>
        )}
      </div>

      {/* Add from GitHub — fetches real README */}
      <div>
        <button onClick={() => setGithubOpen(v => !v)}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-gray-50 transition-colors"
        >
          <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center shrink-0"><Github size={14} className="text-gray-500" /></div>
          <span className="text-xs font-medium text-gray-700">Add from GitHub</span>
          {githubOpen ? <ChevronDown size={12} className="ml-auto text-gray-400" /> : <ChevronRight size={12} className="ml-auto text-gray-300" />}
        </button>
        {githubOpen && (
          <div className="mx-3 mb-1 space-y-1">
            <div className="flex gap-1">
              <input
                value={githubUrl} onChange={e => { setGithubUrl(e.target.value); setGithubError(''); }}
                placeholder="https://github.com/owner/repo"
                className="flex-1 text-[11px] px-2.5 py-1.5 border border-gray-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-gray-300"
                onKeyDown={e => { if (e.key === 'Enter') fetchGitHub(); }}
                autoFocus
              />
              <button
                onClick={fetchGitHub} disabled={githubLoading || !githubUrl.trim()}
                className="px-2 py-1.5 text-[11px] bg-gray-900 text-white rounded-lg hover:bg-gray-700 disabled:opacity-40 transition-colors"
              >{githubLoading ? <Loader2 size={11} className="animate-spin" /> : 'Add'}</button>
            </div>
            {githubError && <p className="text-[10px] text-red-500">{githubError}</p>}
          </div>
        )}
      </div>

      {/* Add from Blueprint — fetches executive_summary and injects */}
      <div>
        <button onClick={openBlueprintPicker}
          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left hover:bg-gray-50 transition-colors"
        >
          <div className="w-7 h-7 rounded-lg bg-gray-100 flex items-center justify-center shrink-0"><Layers size={14} className="text-gray-500" /></div>
          <span className="text-xs font-medium text-gray-700">Add from Blueprint</span>
          {bpPickerOpen ? <ChevronDown size={12} className="ml-auto text-gray-400" /> : <ChevronRight size={12} className="ml-auto text-gray-300" />}
        </button>
        {bpPickerOpen && (
          <div className="mx-3 mb-1 border border-gray-100 rounded-xl overflow-hidden">
            {loadingBps ? (
              <div className="flex items-center justify-center py-4"><Loader2 size={14} className="animate-spin text-gray-400" /></div>
            ) : recentBps.length === 0 ? (
              <p className="text-[11px] text-gray-400 px-3 py-2">No blueprints yet. Generate one first.</p>
            ) : (
              recentBps.map(bp => (
                <button key={bp.id}
                  onClick={() => injectBlueprint(bp)}
                  disabled={loadingBpId === bp.id}
                  className="w-full flex items-start gap-2 px-3 py-2 text-left hover:bg-gray-50 transition-colors border-b border-gray-50 last:border-b-0 disabled:opacity-50"
                >
                  {loadingBpId === bp.id
                    ? <Loader2 size={11} className="animate-spin text-gray-400 mt-0.5 shrink-0" />
                    : <Layers size={11} className="text-gray-400 mt-0.5 shrink-0" />
                  }
                  <span className="text-[11px] font-medium text-gray-700 truncate">{bp.name}</span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── PlusMenuPopover (3 sections: Context | Capabilities | Tools) ──────────────

function PlusMenuPopover({ tab, setTab, composerConfig, setComposerConfig, onClose, onInjectContext }: {
  tab:              'context' | 'capabilities' | 'tools';
  setTab:           (t: 'context' | 'capabilities' | 'tools') => void;
  composerConfig:   ComposerConfig;
  setComposerConfig:React.Dispatch<React.SetStateAction<ComposerConfig>>;
  onClose:          () => void;
  onInjectContext:  (text: string) => void;
}) {
  const fileRef2   = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, true);

  const handleEscape = (e: React.KeyboardEvent) => { if (e.key === 'Escape') { onClose(); } };

  return (
    <div ref={containerRef}
      className="absolute bottom-full left-0 mb-2 w-80 bg-white border border-gray-200 rounded-2xl shadow-xl z-50 overflow-hidden"
      role="dialog" aria-label="Context and capabilities menu" aria-modal="true"
      onKeyDown={handleEscape}
    >
      {/* Tab bar */}
      <div className="flex border-b border-gray-100" style={{ background: '#1c1612' }}>
        {([
          { id: 'context',      label: 'Context',      icon: FolderOpen },
          { id: 'capabilities', label: 'Capabilities', icon: Layers     },
          { id: 'tools',        label: 'Tools',        icon: Globe      },
        ] as const).map(({ id, label, icon: Icon }) => (
          <button key={id} onClick={() => setTab(id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-medium transition-colors
              ${tab === id ? 'text-white border-b-2 border-white' : 'text-white/50 hover:text-white/80'}`}
            role="tab" aria-selected={tab === id}
          >
            <Icon size={12} />{label}
          </button>
        ))}
      </div>

      <div className="p-3" role="tabpanel">

        {/* Context Attachment */}
        {tab === 'context' && (
          <ContextAttachmentPanel
            fileRef={fileRef2}
            onInjectContext={onInjectContext}
            onClose={onClose}
          />
        )}

        {/* Capabilities */}
        {tab === 'capabilities' && (
          <div className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Skills</p>
            <div className="max-h-48 overflow-y-auto space-y-0.5 mb-3">
              {BUILT_IN_SKILLS.map(skill => {
                const isActive = composerConfig.activeSkillIds.includes(skill.id);
                return (
                  <button key={skill.id}
                    onClick={() => setComposerConfig(c => ({
                      ...c,
                      activeSkillIds: isActive ? c.activeSkillIds.filter(i => i !== skill.id) : [...c.activeSkillIds, skill.id],
                    }))}
                    className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left transition-all border
                      ${isActive ? 'bg-violet-50 border-violet-200' : 'hover:bg-gray-50 border-transparent'}`}
                    aria-pressed={isActive}
                  >
                    <Hash size={12} className={isActive ? 'text-violet-500' : 'text-gray-400'} />
                    <div className="min-w-0 flex-1">
                      <div className={`text-xs font-medium ${isActive ? 'text-violet-700' : 'text-gray-700'}`}>{skill.name}</div>
                    </div>
                    <div className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${isActive ? 'bg-violet-500 border-violet-500' : 'border-gray-300'}`}>
                      {isActive && <Check size={9} className="text-white" />}
                    </div>
                  </button>
                );
              })}
            </div>
            <div className="h-px bg-gray-100 mb-2" />
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left hover:bg-gray-50 transition-colors text-gray-400 text-xs">
              <Plug size={12} /> Connectors <span className="ml-auto text-[10px] bg-gray-100 px-1.5 py-0.5 rounded">Coming soon</span>
            </button>
            <button className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-left hover:bg-gray-50 transition-colors text-gray-400 text-xs">
              <Plus size={12} /> Add plugins… <span className="ml-auto text-[10px] bg-gray-100 px-1.5 py-0.5 rounded">Coming soon</span>
            </button>
          </div>
        )}

        {/* Tools */}
        {tab === 'tools' && (
          <div className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Available Tools</p>
            {/* Web search with source-restriction lock */}
            <div className="flex items-center justify-between px-3 py-2.5 rounded-xl border border-gray-100 hover:bg-gray-50 transition-colors">
              <div className="flex items-center gap-2.5">
                {composerConfig.sourceRestricted ? <Lock size={13} className="text-amber-500" /> : <Globe size={13} className="text-blue-500" />}
                <div>
                  <div className="text-xs font-medium text-gray-700">Web Search</div>
                  {composerConfig.sourceRestricted && <div className="text-[10px] text-amber-600">Source-restricted by Curator</div>}
                </div>
              </div>
              <button onClick={() => setComposerConfig(c => ({ ...c, webSearch: !c.webSearch }))}
                className={`relative w-9 h-5 rounded-full transition-colors ${composerConfig.webSearch ? 'bg-blue-500' : 'bg-gray-200'}`}
                disabled={composerConfig.sourceRestricted}
                role="switch" aria-checked={composerConfig.webSearch}
              >
                <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${composerConfig.webSearch ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
            </div>
            {['Structured Output', 'Deep Analysis', 'Code Generation'].map(tool => (
              <div key={tool} className="flex items-center justify-between px-3 py-2.5 rounded-xl border border-gray-100 opacity-40">
                <span className="text-xs font-medium text-gray-600">{tool}</span>
                <span className="text-[10px] text-gray-400">Coming soon</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Footer summary */}
      <div className="px-3 pb-3">
        <div className="flex items-center gap-2 px-3 py-2 bg-gray-50 rounded-xl border border-gray-100">
          <Settings2 size={11} className="text-gray-400 shrink-0" />
          <span className="text-[10px] text-gray-500 truncate">
            {MODE_META[composerConfig.mode].label} · {EFFORT_META[composerConfig.effort].label}
            {composerConfig.thinkingEnabled ? ' · Thinking' : ''}
            {composerConfig.activeSkillIds.length > 0 ? ` · ${composerConfig.activeSkillIds.length} skill${composerConfig.activeSkillIds.length > 1 ? 's' : ''}` : ''}
          </span>
        </div>
      </div>
    </div>
  );
}

// ── WsDiffPanel — inline diff toggle between blueprint versions ───────────────

function WsDiffPanel({ bpVersions, selectedVer, onSelectVersion }: {
  bpVersions:      BlueprintVersionMeta[];
  selectedVer:     number | null;
  onSelectVersion: (v: number) => void;
}) {
  const [compareVer, setCompareVer] = useState<number | null>(null);
  const [showDiff,   setShowDiff]   = useState(false);

  if (bpVersions.length < 2) {
    return (
      <div className="rounded-xl bg-white border border-gray-200 p-4 text-center">
        <GitBranch size={20} className="text-gray-300 mx-auto mb-2" />
        <p className="text-xs text-gray-400">Need at least 2 blueprint versions to compare. Generate another version to unlock diffs.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Version Diffs</p>

      {/* Version selector */}
      <div className="flex gap-2">
        <select
          value={selectedVer ?? ''}
          onChange={e => onSelectVersion(Number(e.target.value))}
          className="flex-1 text-[11px] bg-white border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none"
          aria-label="Base version"
        >
          <option value="">Base (latest)</option>
          {bpVersions.map(v => (
            <option key={v.versionNumber} value={v.versionNumber}>v{v.versionNumber}</option>
          ))}
        </select>
        <span className="self-center text-[10px] text-gray-400">vs</span>
        <select
          value={compareVer ?? ''}
          onChange={e => setCompareVer(Number(e.target.value))}
          className="flex-1 text-[11px] bg-white border border-gray-200 rounded-lg px-2 py-1.5 focus:outline-none"
          aria-label="Compare version"
        >
          <option value="">Compare…</option>
          {bpVersions.filter(v => v.versionNumber !== (selectedVer ?? bpVersions[0]?.versionNumber)).map(v => (
            <option key={v.versionNumber} value={v.versionNumber}>v{v.versionNumber}</option>
          ))}
        </select>
      </div>

      {/* Diff toggle button */}
      {compareVer && (
        <button
          onClick={() => setShowDiff(v => !v)}
          className="w-full flex items-center justify-center gap-2 py-2 text-xs font-medium bg-gray-900 text-white rounded-xl hover:bg-gray-700 transition-colors"
        >
          <Diff size={12} /> {showDiff ? 'Hide' : 'Show'} diff
        </button>
      )}

      {/* Diff output */}
      {showDiff && compareVer && (
        <div className="rounded-xl bg-white border border-gray-200 overflow-hidden">
          <div className="px-3 py-2 border-b border-gray-100 flex items-center justify-between" style={{ background: '#f5f4f0' }}>
            <span className="text-[10px] font-semibold text-gray-600">
              v{selectedVer ?? bpVersions[0]?.versionNumber} → v{compareVer}
            </span>
            <span className="text-[10px] text-gray-400">Change summaries</span>
          </div>
          <div className="p-3 space-y-2 max-h-64 overflow-y-auto">
            {bpVersions.filter(v => v.versionNumber === compareVer || v.versionNumber === selectedVer).map(v => (
              <div key={v.versionNumber} className="text-[11px]">
                <span className={`font-semibold ${v.versionNumber === compareVer ? 'text-blue-600' : 'text-gray-600'}`}>v{v.versionNumber}</span>
                <span className="text-gray-500 ml-2">{v.changeSummary}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Version list */}
      <div className="space-y-1.5">
        {bpVersions.slice(0, 6).map(v => (
          <div
            key={v.versionNumber}
            className={`flex items-start gap-2 p-2.5 rounded-xl border cursor-pointer transition-colors
              ${selectedVer === v.versionNumber ? 'bg-gray-100 border-gray-300' : 'bg-white border-gray-200 hover:bg-gray-50'}`}
            onClick={() => onSelectVersion(v.versionNumber)}
            role="button" tabIndex={0}
            onKeyDown={e => e.key === 'Enter' && onSelectVersion(v.versionNumber)}
          >
            <GitBranch size={12} className="text-gray-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <div className="text-xs font-medium text-gray-700">v{v.versionNumber}</div>
              <div className="text-[10px] text-gray-400 truncate">{v.changeSummary}</div>
              <div className="text-[9px] text-gray-300">{new Date(v.timestamp).toLocaleDateString()}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Workspace Panel ────────────────────────────────────────────────────────────

const WS_TABS: Record<ChatMode, { id: string; label: string }[]> = {
  artemis: [{ id: 'brief', label: 'Brief' }, { id: 'breakdown', label: 'Breakdown' }],
  curator: [{ id: 'report', label: 'Report' }, { id: 'diffs', label: 'Diffs' }],
  general: [{ id: 'blueprint', label: 'Blueprint' }, { id: 'pillars', label: 'Pillars' }],
};

function WorkspacePanel({
  currentMode, workspace, briefApproved, bpVersions, selectedVer,
  activeBp, activeBpLoading, isStreaming,
  wsTab, onTabChange, onSelectVersion, onApproveBrief, onClose,
}: {
  currentMode:     ChatMode;
  workspace:       ArtemisWorkspace | null;
  briefApproved:   boolean;
  bpVersions:      BlueprintVersionMeta[];
  selectedVer:     number | null;
  activeBp:        ActiveBlueprint | null;
  activeBpLoading: boolean;
  isStreaming:     boolean;
  wsTab:           string;
  onTabChange:     (t: string) => void;
  onSelectVersion: (v: number) => void;
  onApproveBrief:  () => void;
  onClose:         () => void;
}) {
  const tabs = WS_TABS[currentMode];

  return (
    <aside className="w-72 shrink-0 border-l border-gray-200 flex flex-col overflow-hidden" style={{ background: '#fafaf8' }}
      aria-label="Workspace panel"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 shrink-0" style={{ background: '#f5f4f0' }}>
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-gray-700">Workspace</span>
          {isStreaming && (
            <span className="flex items-center gap-1 text-[10px] font-medium text-emerald-600">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />Live
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {bpVersions.length > 0 && (
            <select
              value={selectedVer ?? ''}
              onChange={e => onSelectVersion(Number(e.target.value))}
              className="text-[10px] text-gray-600 bg-white border border-gray-200 rounded-lg px-2 py-1 focus:outline-none"
              aria-label="Select blueprint version"
            >
              <option value="">Latest</option>
              {bpVersions.map(v => (
                <option key={v.versionNumber} value={v.versionNumber}>v{v.versionNumber} — {v.changeSummary.slice(0, 20)}</option>
              ))}
            </select>
          )}
          <button onClick={onClose} className="p-1 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors" aria-label="Close workspace panel">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Agent-keyed tabs */}
      <div className="flex border-b border-gray-200 shrink-0" style={{ background: '#f5f4f0' }} role="tablist">
        {tabs.map(t => (
          <button key={t.id} onClick={() => onTabChange(t.id)}
            className={`flex-1 py-2 text-xs font-medium transition-colors border-b-2 ${wsTab === t.id ? 'border-gray-900 text-gray-900' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
            role="tab" aria-selected={wsTab === t.id}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4" role="tabpanel">

        {/* Loading state */}
        {activeBpLoading && (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-gray-400" />
          </div>
        )}

        {/* ── Artemis: Brief ── */}
        {!activeBpLoading && currentMode === 'artemis' && wsTab === 'brief' && (
          workspace ? (
            <>
              <div className="rounded-xl bg-white border border-gray-200 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-gray-600">Confidence</span>
                  <span className={`text-xs font-semibold ${workspace.confidenceScore >= 0.75 ? 'text-green-600' : 'text-amber-600'}`}>
                    {Math.round(workspace.confidenceScore * 100)}%
                  </span>
                </div>
                <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                  <div className="h-full rounded-full transition-all" style={{ width: `${workspace.confidenceScore * 100}%`, background: workspace.confidenceScore >= 0.75 ? '#22c55e' : '#f59e0b' }} />
                </div>
                {!!workspace.brief && !briefApproved && (
                  <button onClick={onApproveBrief} className="w-full py-1.5 text-xs font-semibold bg-violet-500 hover:bg-violet-400 text-white rounded-lg transition-colors mt-1">
                    Approve Brief
                  </button>
                )}
                {briefApproved && <div className="flex items-center gap-1.5 text-xs text-emerald-600"><CheckCircle2 size={13} /> Brief approved</div>}
              </div>
              {workspace.brief && (
                <div className="rounded-xl bg-white border border-gray-200 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Brief Preview</p>
                  <pre className="text-[11px] text-gray-600 whitespace-pre-wrap leading-relaxed max-h-48 overflow-y-auto">
                    {JSON.stringify(workspace.brief, null, 2).slice(0, 600)}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <div className="rounded-xl bg-white border border-gray-200 p-4 text-center">
              <Brain size={20} className="text-gray-300 mx-auto mb-2" />
              <p className="text-xs text-gray-400">Start an Artemis conversation to build your project brief here. Artemis will track confidence as it clarifies your requirements.</p>
            </div>
          )
        )}

        {/* ── Artemis: Breakdown ── */}
        {!activeBpLoading && currentMode === 'artemis' && wsTab === 'breakdown' && (
          workspace?.brief ? (
            <div className="rounded-xl bg-white border border-gray-200 p-3 space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Requirement Breakdown</p>
              {Object.entries(workspace.brief as Record<string, unknown>).slice(0, 8).map(([k, v]) => (
                <div key={k} className="text-[11px] border-b border-gray-50 pb-1.5 last:border-b-0 last:pb-0">
                  <span className="font-semibold text-gray-600 capitalize">{k.replace(/_/g, ' ')}: </span>
                  <span className="text-gray-500">{Array.isArray(v) ? (v as string[]).join(', ') : String(v ?? '—').slice(0, 80)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl bg-white border border-gray-200 p-4 text-center">
              <Layers size={20} className="text-gray-300 mx-auto mb-2" />
              <p className="text-xs text-gray-400">Requirement breakdown will populate here as Artemis clarifies your project goals.</p>
            </div>
          )
        )}

        {/* ── Curator: Report ── */}
        {!activeBpLoading && currentMode === 'curator' && wsTab === 'report' && (
          activeBp ? (
            <div className="space-y-3">
              <div className="rounded-xl bg-white border border-gray-200 p-3 flex items-center gap-3">
                <div className="text-center shrink-0">
                  <div className={`text-xl font-bold ${activeBp.qualityScore >= 80 ? 'text-green-600' : activeBp.qualityScore >= 60 ? 'text-amber-600' : 'text-red-500'}`}>
                    {activeBp.qualityScore}
                  </div>
                  <div className="text-[9px] text-gray-400 uppercase tracking-wide">Quality</div>
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-gray-800 truncate">{activeBp.productName}</div>
                  <div className="text-[10px] text-gray-400">{Object.keys(activeBp.sections).length} sections · {Object.keys(activeBp.pillars).length} pillars</div>
                </div>
              </div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Pillar Quality</p>
              {Object.entries(activeBp.pillars).slice(0, 7).map(([name, p]) => (
                <div key={name} className="flex items-center gap-2">
                  <span className="text-[11px] text-gray-600 w-24 truncate capitalize">{name.replace(/_/g, ' ')}</span>
                  <div className="flex-1 h-1 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-violet-400 rounded-full" style={{ width: `${Math.min(100, (p.score ?? 70))}%` }} />
                  </div>
                  <span className="text-[10px] text-gray-400 w-6 text-right">{p.score ?? '—'}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl bg-white border border-gray-200 p-4 text-center">
              <FlaskConical size={20} className="text-gray-300 mx-auto mb-2" />
              <p className="text-xs text-gray-400">Curator report will appear here after you generate and analyze a blueprint.</p>
            </div>
          )
        )}

        {/* ── Curator: Diffs — inline diff toggle between blueprint versions ── */}
        {!activeBpLoading && currentMode === 'curator' && wsTab === 'diffs' && (
          <WsDiffPanel bpVersions={bpVersions} selectedVer={selectedVer} onSelectVersion={onSelectVersion} />
        )}

        {/* ── General: Blueprint ── */}
        {!activeBpLoading && currentMode === 'general' && wsTab === 'blueprint' && (
          activeBp ? (
            <div className="space-y-2">
              <div className="rounded-xl bg-white border border-gray-200 p-3">
                <div className="flex items-center justify-between mb-2">
                  <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Executive Summary</p>
                  <a href={`/blueprints/${activeBp.id}`} className="text-[10px] text-blue-500 hover:text-blue-700 transition-colors">View full →</a>
                </div>
                <p className="text-[11px] text-gray-600 leading-relaxed">
                  {(() => {
                    const sec = activeBp.sections['executive_summary'];
                    if (!sec) return 'No summary available.';
                    if (typeof sec === 'string') return sec.slice(0, 300);
                    return (sec as { content: string }).content?.slice(0, 300) ?? 'No summary available.';
                  })()}
                </p>
              </div>
              {bpVersions.length > 0 && (
                <div className="flex items-center gap-2 p-2.5 bg-white border border-gray-200 rounded-xl">
                  <History size={12} className="text-gray-400 shrink-0" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-gray-700">{activeBp.productName}</div>
                    <div className="text-[10px] text-gray-400">v{bpVersions[0]?.versionNumber} · Score {activeBp.qualityScore}</div>
                  </div>
                  <a href={`/api/v1/export/${activeBp.id}?format=markdown`}
                    className="text-[10px] text-gray-400 hover:text-gray-700 transition-colors flex items-center gap-1"
                    download>
                    <Download size={10} /> Export
                  </a>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl bg-white border border-gray-200 p-4 text-center">
              <BookOpen size={20} className="text-gray-300 mx-auto mb-2" />
              <p className="text-xs text-gray-400">Generate a blueprint first. It will appear here for quick reference during conversations.</p>
            </div>
          )
        )}

        {/* ── General: Pillars ── */}
        {!activeBpLoading && currentMode === 'general' && wsTab === 'pillars' && (
          activeBp && Object.keys(activeBp.pillars).length > 0 ? (
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Pillar Breakdown</p>
              {Object.entries(activeBp.pillars).map(([name, p]) => (
                <div key={name} className="rounded-xl bg-white border border-gray-200 p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-semibold text-gray-700 capitalize">{name.replace(/_/g, ' ')}</span>
                    {p.score !== undefined && (
                      <span className={`text-[10px] font-bold ${p.score >= 80 ? 'text-green-600' : p.score >= 60 ? 'text-amber-600' : 'text-red-500'}`}>{p.score}</span>
                    )}
                  </div>
                  {p.summary && <p className="text-[11px] text-gray-500 leading-tight">{p.summary.slice(0, 100)}</p>}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl bg-white border border-gray-200 p-4 text-center">
              <Network size={20} className="text-gray-300 mx-auto mb-2" />
              <p className="text-xs text-gray-400">Pillar breakdown will appear here when a blueprint is active.</p>
            </div>
          )
        )}
      </div>
    </aside>
  );
}

// ── Session Item ───────────────────────────────────────────────────────────────

function SessionItem({ session, isActive, isRenaming, renameValue, renameInputRef, onSelect, onStar, onRename, onRenameChange, onRenameCommit, onDelete }: {
  session: ChatSession; isActive: boolean; isRenaming: boolean; renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement | null>;
  onSelect: () => void; onStar: () => void; onRename: () => void;
  onRenameChange: (v: string) => void; onRenameCommit: () => void; onDelete: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const meta = MODE_META[session.mode]; const Icon = meta.icon;
  return (
    <div className={`group relative flex items-center gap-2 px-2 py-2 rounded-lg cursor-pointer transition-colors ${isActive ? 'bg-white/15' : 'hover:bg-white/8'}`}
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      onClick={isRenaming ? undefined : onSelect}
      role="listitem" aria-current={isActive ? 'true' : undefined}
    >
      <Icon size={12} className={`shrink-0 ${isActive ? 'text-white' : 'text-white/40'}`} />
      {isRenaming ? (
        <input ref={renameInputRef} value={renameValue} onChange={e => onRenameChange(e.target.value)}
          onBlur={onRenameCommit} onKeyDown={e => { if (e.key === 'Enter' || e.key === 'Escape') onRenameCommit(); }}
          className="flex-1 min-w-0 bg-transparent text-xs text-white focus:outline-none border-b border-white/30"
          onClick={e => e.stopPropagation()} aria-label="Rename session"
        />
      ) : (
        <span className={`flex-1 min-w-0 text-xs truncate ${isActive ? 'text-white font-medium' : 'text-white/70'}`}>{session.title}</span>
      )}
      {(hovered || isActive) && !isRenaming && (
        <div className="flex items-center gap-0.5 shrink-0" onClick={e => e.stopPropagation()}>
          <button onClick={onStar} className={`p-1 rounded transition-colors ${session.starred ? 'text-yellow-400' : 'text-white/30 hover:text-yellow-400'}`} aria-label={session.starred ? 'Unstar' : 'Star'}>
            <Star size={10} fill={session.starred ? 'currentColor' : 'none'} />
          </button>
          <button onClick={onRename} className="p-1 rounded text-white/30 hover:text-white/80 transition-colors" aria-label="Rename">
            <Edit2 size={10} />
          </button>
          <button onClick={onDelete} className="p-1 rounded text-white/30 hover:text-red-400 transition-colors" aria-label="Delete">
            <Trash2 size={10} />
          </button>
        </div>
      )}
    </div>
  );
}

// ── ModelEffortSelector — single pill → two-level linked popover ──────────────
//
// Primary popover: model list + capability descriptor + status badge + Effort row (chevron → secondary)
// Secondary popover: Low/Medium/High/Max effort levels + Thinking toggle + Back button
// Spec: §1 — model selector pill opens two linked popovers, not two separate buttons.

function ModelEffortSelector({ composerConfig, setComposerConfig, allModels }: {
  composerConfig:    ComposerConfig;
  setComposerConfig: React.Dispatch<React.SetStateAction<ComposerConfig>>;
  allModels:         { id: string; name: string; provider: string; costPer1M?: number }[];
}) {
  const [open,       setOpen]       = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  useFocusTrap(containerRef, open);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) { setOpen(false); setEffortOpen(false); }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const selectedModel = allModels.find(m => m.id === composerConfig.model);
  const effortMeta    = EFFORT_META[composerConfig.effort];

  return (
    <div className="relative" ref={containerRef}>
      {/* Single pill button */}
      <button
        onClick={() => { setOpen(v => !v); setEffortOpen(false); }}
        className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium rounded-xl border border-gray-200 bg-white hover:bg-gray-50 transition-colors"
        aria-haspopup="true" aria-expanded={open}
        aria-label={`Model: ${selectedModel?.name ?? 'Select model'}, Effort: ${effortMeta.label}`}
      >
        <span className="max-w-[96px] truncate">{selectedModel?.name ?? 'Model'}</span>
        <span className={`${effortMeta.color} font-semibold`}>· {effortMeta.label}</span>
        <ChevronDown size={11} className="text-gray-400 shrink-0" />
      </button>

      {open && !effortOpen && (
        <div
          className="absolute top-full right-0 mt-2 w-80 bg-white border border-gray-200 rounded-2xl shadow-xl z-50 overflow-hidden"
          role="dialog" aria-label="Model selector" aria-modal="true"
          onKeyDown={(e) => { if (e.key === 'Escape') { setOpen(false); setEffortOpen(false); } }}
        >
          {/* Header */}
          <div className="px-3 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Select Model</p>
            <span className="text-[10px] text-gray-400">{allModels.length} models</span>
          </div>

          {/* Model list */}
          <div className="max-h-52 overflow-y-auto py-1" role="listbox" aria-label="Available models">
            {allModels.slice(0, 50).map(model => {
              const sel = composerConfig.model === model.id;
              return (
                <button key={model.id}
                  onClick={() => { setComposerConfig(c => ({ ...c, model: model.id })); setOpen(false); }}
                  className={`w-full flex items-center justify-between px-3 py-2 text-left hover:bg-gray-50 transition-colors
                    ${sel ? 'bg-gray-900 text-white' : 'text-gray-700'}`}
                  role="option" aria-selected={sel}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium truncate">{model.name}</div>
                    <div className={`text-[10px] ${sel ? 'text-white/50' : 'text-gray-400'}`}>{model.provider}</div>
                  </div>
                  {sel && <Check size={13} className="text-white/70 shrink-0 ml-2" />}
                </button>
              );
            })}
          </div>

          {/* Effort row — opens secondary popover */}
          <div className="border-t border-gray-100">
            <button
              onClick={() => setEffortOpen(true)}
              className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-gray-50 transition-colors"
              aria-haspopup="true" aria-expanded={effortOpen}
            >
              <div className="flex items-center gap-2">
                <Gauge size={13} className={effortMeta.color} />
                <div className="text-left">
                  <div className="text-xs font-medium text-gray-700">Effort &amp; Thinking</div>
                  <div className="text-[10px] text-gray-400">{effortMeta.label} — {effortMeta.desc}</div>
                </div>
              </div>
              <ChevronRight size={13} className="text-gray-300 shrink-0" />
            </button>
          </div>
        </div>
      )}

      {open && effortOpen && (
        <div
          className="absolute top-full right-0 mt-2 w-72 bg-white border border-gray-200 rounded-2xl shadow-xl z-50 overflow-hidden"
          role="dialog" aria-label="Effort and thinking settings" aria-modal="true"
          onKeyDown={(e) => { if (e.key === 'Escape') setEffortOpen(false); }}
        >
          {/* Back header */}
          <div className="px-3 py-2.5 border-b border-gray-100 bg-gray-50 flex items-center gap-2">
            <button onClick={() => setEffortOpen(false)} className="p-1 rounded-lg hover:bg-gray-100 text-gray-500 transition-colors" aria-label="Back to model list">
              <ChevronLeft size={14} />
            </button>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Effort &amp; Thinking</p>
          </div>

          {/* Effort levels */}
          <div className="p-3 space-y-3">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400 mb-2">Reasoning Effort</p>
              <div className="grid grid-cols-4 gap-1">
                {(['low', 'medium', 'high', 'max'] as EffortLevel[]).map(level => {
                  const meta = EFFORT_META[level]; const sel = composerConfig.effort === level;
                  return (
                    <button key={level}
                      onClick={() => setComposerConfig(c => ({ ...c, effort: level }))}
                      className={`flex flex-col items-center gap-1 py-2 rounded-xl text-[10px] font-medium border transition-all
                        ${sel ? 'bg-gray-900 text-white border-gray-900' : 'bg-gray-50 text-gray-600 border-gray-200 hover:bg-gray-100'}`}
                      aria-pressed={sel}
                    >
                      <Gauge size={12} className={sel ? 'text-white' : meta.color} />{meta.label}
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-gray-400 mt-1.5">{EFFORT_META[composerConfig.effort].desc}</p>
            </div>

            {/* Extended Thinking toggle */}
            <div className="flex items-center justify-between pt-2 border-t border-gray-100">
              <div>
                <div className="flex items-center gap-1.5 text-xs font-medium text-gray-700">
                  <Brain size={12} className="text-violet-500" /> Extended Thinking
                </div>
                <p className="text-[10px] text-gray-400 mt-0.5">Reasoning chains (Anthropic models)</p>
              </div>
              <button
                onClick={() => setComposerConfig(c => ({ ...c, thinkingEnabled: !c.thinkingEnabled }))}
                className={`relative w-9 h-5 rounded-full transition-colors ${composerConfig.thinkingEnabled ? 'bg-violet-500' : 'bg-gray-200'}`}
                role="switch" aria-checked={composerConfig.thinkingEnabled}
              >
                <div className={`absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${composerConfig.thinkingEnabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Status Banner ──────────────────────────────────────────────────────────────

function StatusBanner({ notice, onDismiss }: { notice: StatusNotice; onDismiss: () => void }) {
  const bg  = { info: 'bg-blue-50 border-blue-200',    warning: 'bg-amber-50 border-amber-200',    error: 'bg-red-50 border-red-200'    };
  const txt = { info: 'text-blue-800',                  warning: 'text-amber-800',                  error: 'text-red-800'                 };
  const IconMap = { info: Info, warning: AlertTriangle, error: AlertCircle };
  const Icon = IconMap[notice.level];
  return (
    <div className={`flex items-center gap-3 px-4 py-2 border-b text-xs ${bg[notice.level]}`}>
      <Icon size={13} className={txt[notice.level]} />
      <span className={`flex-1 ${txt[notice.level]}`}>{notice.message}</span>
      <button onClick={onDismiss} className={`p-0.5 rounded hover:bg-black/5 transition-colors ${txt[notice.level]}`} aria-label="Dismiss notice"><X size={12} /></button>
    </div>
  );
}

// ── Message Bubble ─────────────────────────────────────────────────────────────

function MessageBubble({ message, modeMeta }: { message: ChatMessage; modeMeta: typeof MODE_META[ChatMode] }) {
  const isUser   = message.role === 'user';
  const isSystem = message.role === 'system';
  if (isSystem) return (
    <div className="flex justify-center" role="status">
      <div className="max-w-lg px-4 py-2 bg-emerald-50 border border-emerald-200 rounded-xl text-xs text-emerald-800">
        <ReactMarkdown>{message.content}</ReactMarkdown>
      </div>
    </div>
  );
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} gap-3`}>
      {!isUser && (
        <div className={`w-7 h-7 rounded-full flex items-center justify-center shrink-0 border ${modeMeta.avatarClass}`} aria-hidden="true">
          {React.createElement(modeMeta.icon, { size: 13, className: modeMeta.accent })}
        </div>
      )}
      <div className={`max-w-[72%] px-4 py-3 rounded-2xl text-sm leading-relaxed ${isUser ? 'bg-gray-900 text-white rounded-tr-sm' : 'bg-white border border-gray-200 text-gray-800 rounded-tl-sm shadow-sm'}`}
        aria-label={isUser ? 'Your message' : 'Assistant response'}
      >
        {isUser ? (
          <p className="whitespace-pre-wrap">{message.content}</p>
        ) : (
          <div className="prose prose-sm max-w-none" aria-live={message.isStreaming ? 'polite' : undefined}>
            <ReactMarkdown>{message.content}</ReactMarkdown>
            {message.isStreaming && <span className="inline-block w-1 h-4 bg-gray-400 animate-pulse ml-0.5" aria-label="Generating…" />}
          </div>
        )}
      </div>
      {isUser && <div className="w-7 h-7 rounded-full bg-gray-900 flex items-center justify-center shrink-0 text-white text-[10px] font-bold" aria-hidden="true">U</div>}
    </div>
  );
}

// suppress unused import lint errors for icons used only in JSX
void Network; void FlaskConical; void Shield; void GitBranch;
void ChevronUp; void useId;
