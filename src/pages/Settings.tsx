import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Check, AlertCircle, KeyRound, Cpu, Server,
  Zap, Plus, Trash2, Edit2, Save, X, ToggleLeft, ToggleRight,
  Bot, Layers, Settings2, Shield, FolderOpen, Wrench,
  Terminal, Activity, Radio, Wifi, WifiOff, Pause, Play,
  Clock, Database, Filter, ChevronDown, ChevronRight,
} from 'lucide-react';
import { PROVIDERS } from '../lib/providers';
import { saveClientConfig, getDefaultConfigForProvider, loadClientConfig } from '../lib/config';
import { ModelConfig } from '../engine/config';
import { ProviderCard } from '../components/ProviderCard';
import { ApiKeyInput } from '../components/ApiKeyInput';
import { ModelPicker } from '../components/ModelPicker';
import { CostEstimate } from '../components/CostEstimate';
import type { AtomicSettings } from '../engine/systemState';

const LOCAL_KEY = 'atomic_ui_config';

const getCachedConfig = (): Partial<ModelConfig> | null => {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
};

const setCachedConfig = (cfg: Partial<ModelConfig>) => {
  try {
    const { apiKey: _k, ...safe } = cfg as ModelConfig; void _k;
    localStorage.setItem(LOCAL_KEY, JSON.stringify(safe));
  } catch (err: unknown) {
    console.warn('[Settings] localStorage write failed (quota?):', err);
  }
};

const NAV_GROUPS = [
  {
    label: 'Provider',
    items: [
      { id: 'provider', icon: Server,   label: 'Provider' },
      { id: 'auth',     icon: KeyRound, label: 'Authentication' },
      { id: 'model',    icon: Cpu,      label: 'Model Selection' },
      { id: 'skills',   icon: Zap,      label: 'Skills' },
    ],
  },
  {
    label: 'Agents',
    items: [
      { id: 'artemis',  icon: Bot,      label: 'Artemis' },
      { id: 'curator',  icon: Shield,   label: 'Curator' },
      { id: 'general',  icon: Wrench,   label: 'General' },
      { id: 'pipeline', icon: Layers,   label: 'Pipeline' },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'projects',   icon: FolderOpen, label: 'Projects' },
      { id: 'system',     icon: Settings2,  label: 'System' },
      { id: 'developer',  icon: Terminal,   label: 'Developer' },
    ],
  },
];

// Flatten for lookup

// ── Atomic settings hooks ─────────────────────────────────────────────────────

function useAtomicSettings() {
  const [settings, setSettings] = useState<AtomicSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const savedTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/v1/settings');
      if (res.ok) {
        const data = await res.json() as { settings: AtomicSettings };
        setSettings(data.settings);
      }
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- async data-load kickoff (intentional)
void load();
  }, [load]);

  const patch = useCallback(async (section: keyof AtomicSettings, updates: Record<string, unknown>) => {
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/v1/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section, updates }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { settings: AtomicSettings };
      setSettings(data.settings);
      setSaved(true);
      if (savedTimer.current) clearTimeout(savedTimer.current);
      savedTimer.current = setTimeout(() => setSaved(false), 2500);
    } catch (err: unknown) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }, []);

  const reset = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/v1/settings/reset', { method: 'POST' });
      if (res.ok) {
        const data = await res.json() as { settings: AtomicSettings };
        setSettings(data.settings);
        setSaved(true);
        if (savedTimer.current) clearTimeout(savedTimer.current);
        savedTimer.current = setTimeout(() => setSaved(false), 2500);
      }
    } catch { /* ignore */ } finally { setSaving(false); }
  }, []);

  return { settings, setSettings, loading, saving, saved, error, patch, reset };
}

// ── Agent section sub-components ──────────────────────────────────────────────

function FieldRow({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-6 py-4 border-b border-gray-100 last:border-0">
      <div className="w-48 shrink-0">
        <p className="text-sm font-medium text-gray-700">{label}</p>
        {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
      </div>
      <div className="flex-1">{children}</div>
    </div>
  );
}

function Select({ value, onChange, options }: {
  value: string; onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-gray-900/10"
    >
      {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function NumberInput({ value, onChange, min, max, step }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      step={step ?? 1}
      onChange={e => onChange(Number(e.target.value))}
      className="w-32 px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10"
    />
  );
}

function Toggle({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`flex items-center gap-2 text-sm transition-colors ${value ? 'text-gray-900' : 'text-gray-400'}`}
    >
      {value ? <ToggleRight size={24} className="text-green-500" /> : <ToggleLeft size={24} className="text-gray-300" />}
      {label && <span>{label}</span>}
    </button>
  );
}

// ── Artemis section ───────────────────────────────────────────────────────────

function ArtemisSection({ settings, onSave, saving }: {
  settings: AtomicSettings;
  onSave: (updates: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState({ ...settings.artemis });

  return (
    <div className="space-y-0 bg-white rounded-2xl border border-gray-200 divide-y divide-gray-100">
      <div className="px-6 py-4">
        <h3 className="text-sm font-semibold text-gray-900">Artemis — Scoping Agent</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Artemis runs the initial scoping phase — extracting requirements, filling gaps, and producing the brief.
        </p>
      </div>
      <div className="px-6">
        <FieldRow label="Model" hint="LLM for Artemis conversations">
          <input
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10 font-mono"
            value={draft.model}
            onChange={e => setDraft(d => ({ ...d, model: e.target.value }))}
            placeholder="openai/gpt-5.4"
          />
        </FieldRow>
        <FieldRow label="Confidence Threshold" hint="Min score (0–1) before Artemis marks brief as ready">
          <div className="flex items-center gap-3">
            <input
              type="range" min={0.5} max={0.99} step={0.01} value={draft.confidenceThreshold}
              onChange={e => setDraft(d => ({ ...d, confidenceThreshold: Number(e.target.value) }))}
              className="flex-1"
            />
            <span className="text-sm font-mono text-gray-600 w-12">{Math.round(draft.confidenceThreshold * 100)}%</span>
          </div>
        </FieldRow>
        <FieldRow label="Breakdown Strategy" hint="How to decompose product brief into sub-tasks">
          <Select
            value={draft.breakdownStrategy}
            onChange={v => setDraft(d => ({ ...d, breakdownStrategy: v as typeof d.breakdownStrategy }))}
            options={[
              { value: 'flat', label: 'Flat — all tasks at same level' },
              { value: 'hierarchical', label: 'Hierarchical — nested by domain' },
              { value: 'milestone', label: 'Milestone — grouped by phase' },
              { value: 'component', label: 'Component — by system component' },
            ]}
          />
        </FieldRow>
        <FieldRow label="Tone" hint="Communication style in Artemis chat">
          <Select
            value={draft.tone}
            onChange={v => setDraft(d => ({ ...d, tone: v as typeof d.tone }))}
            options={[
              { value: 'technical', label: 'Technical — engineering vocabulary' },
              { value: 'business', label: 'Business — product/PM vocabulary' },
              { value: 'hybrid', label: 'Hybrid — adaptive per context' },
            ]}
          />
        </FieldRow>
      </div>
      <div className="px-6 py-4 flex justify-end">
        <button
          onClick={() => onSave(draft as unknown as Record<string, unknown>)}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-800 disabled:opacity-40 transition-colors"
        >
          <Save size={13} /> {saving ? 'Saving…' : 'Save Artemis settings'}
        </button>
      </div>
    </div>
  );
}

// ── Curator section ───────────────────────────────────────────────────────────

function CuratorSection({ settings, onSave, saving }: {
  settings: AtomicSettings;
  onSave: (updates: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState({ ...settings.curator });

  return (
    <div className="space-y-0 bg-white rounded-2xl border border-gray-200 divide-y divide-gray-100">
      <div className="px-6 py-4">
        <h3 className="text-sm font-semibold text-gray-900">Curator — Review &amp; Refinement Agent</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          Curator researches, fact-checks, and proposes targeted edits to the blueprint after generation.
        </p>
      </div>
      <div className="px-6">
        <FieldRow label="Model" hint="LLM for Curator analysis">
          <input
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10 font-mono"
            value={draft.model}
            onChange={e => setDraft(d => ({ ...d, model: e.target.value }))}
            placeholder="openai/gpt-5.4"
          />
        </FieldRow>
        <FieldRow label="Refinement Depth" hint="How deep Curator goes when analysing the blueprint">
          <Select
            value={draft.refinementDepth}
            onChange={v => setDraft(d => ({ ...d, refinementDepth: v as typeof d.refinementDepth }))}
            options={[
              { value: 'surface', label: 'Surface — quick pass, obvious issues only' },
              { value: 'deep', label: 'Deep — thorough structural review' },
              { value: 'comprehensive', label: 'Comprehensive — exhaustive with citations' },
            ]}
          />
        </FieldRow>
        <FieldRow label="Edit Confirmation" hint="How edits are applied to the blueprint">
          <Select
            value={draft.editConfirmationMode}
            onChange={v => setDraft(d => ({ ...d, editConfirmationMode: v as typeof d.editConfirmationMode }))}
            options={[
              { value: 'always-confirm', label: 'Always confirm — show diff before applying' },
              { value: 'preview-first', label: 'Preview first — show, then auto-apply in 5s' },
              { value: 'auto-apply', label: 'Auto-apply — apply immediately' },
            ]}
          />
        </FieldRow>
        <FieldRow label="Source Recency" hint="Max age of external references (months)">
          <NumberInput
            value={draft.sourceRecencyMonths}
            onChange={v => setDraft(d => ({ ...d, sourceRecencyMonths: v }))}
            min={1} max={60}
          />
        </FieldRow>
        <FieldRow label="Trusted Domains" hint="Domains Curator is allowed to use as references">
          <textarea
            rows={4}
            className="w-full px-3 py-2 text-xs font-mono border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10 resize-none"
            value={draft.trustedDomains.join('\n')}
            onChange={e => setDraft(d => ({ ...d, trustedDomains: e.target.value.split('\n').map(s => s.trim()).filter(Boolean) }))}
            placeholder="docs.anthropic.com&#10;openai.com&#10;developer.mozilla.org"
          />
        </FieldRow>
      </div>
      <div className="px-6 py-4 flex justify-end">
        <button
          onClick={() => onSave(draft as unknown as Record<string, unknown>)}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-800 disabled:opacity-40 transition-colors"
        >
          <Save size={13} /> {saving ? 'Saving…' : 'Save Curator settings'}
        </button>
      </div>
    </div>
  );
}

// ── Pipeline section ──────────────────────────────────────────────────────────

function PipelineSection({ settings, onSave, saving }: {
  settings: AtomicSettings;
  onSave: (updates: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState({ ...settings.pipeline });

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-200 divide-y divide-gray-100">
        <div className="px-6 py-4">
          <h3 className="text-sm font-semibold text-gray-900">Pipeline — Orchestration Settings</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            Controls how the 7-pillar pipeline runs: models, parallelism, failure strategies.
          </p>
        </div>
        <div className="px-6">
          <FieldRow label="Global Pillar Model" hint="Default model for all pillar sub-agents">
            <input
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10 font-mono"
              value={draft.globalModel}
              onChange={e => setDraft(d => ({ ...d, globalModel: e.target.value }))}
              placeholder="openai/gpt-5.4"
            />
          </FieldRow>
          <FieldRow label="Max Parallel Sub-agents" hint="Concurrent LLM calls per pillar">
            <NumberInput value={draft.maxParallelSubAgents} onChange={v => setDraft(d => ({ ...d, maxParallelSubAgents: v }))} min={1} max={20} />
          </FieldRow>
          <FieldRow label="Default Failure Strategy" hint="What to do when a sub-agent fails">
            <Select
              value={draft.defaultFailureStrategy}
              onChange={v => setDraft(d => ({ ...d, defaultFailureStrategy: v as typeof d.defaultFailureStrategy }))}
              options={[
                { value: 'retry', label: 'Retry — up to max retries' },
                { value: 'skip', label: 'Skip — mark as skipped, continue' },
                { value: 'fallback', label: 'Fallback — use cached/partial output' },
                { value: 'block', label: 'Block — halt pipeline on failure' },
              ]}
            />
          </FieldRow>
          <FieldRow label="Max Retries" hint="Per-agent retry limit">
            <NumberInput value={draft.maxRetries} onChange={v => setDraft(d => ({ ...d, maxRetries: v }))} min={0} max={10} />
          </FieldRow>
          <FieldRow label="Retry Backoff" hint="Initial backoff delay in milliseconds">
            <NumberInput value={draft.retryBackoffMs} onChange={v => setDraft(d => ({ ...d, retryBackoffMs: v }))} min={100} max={30000} step={100} />
          </FieldRow>
        </div>
        <div className="px-6 py-4 flex justify-end">
          <button
            onClick={() => onSave(draft as unknown as Record<string, unknown>)}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-800 disabled:opacity-40 transition-colors"
          >
            <Save size={13} /> {saving ? 'Saving…' : 'Save Pipeline settings'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── General section ───────────────────────────────────────────────────────────

function GeneralAgentSection({ settings, onSave, saving }: {
  settings: AtomicSettings;
  onSave: (updates: Record<string, unknown>) => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState({ ...settings.general });

  return (
    <div className="bg-white rounded-2xl border border-gray-200 divide-y divide-gray-100">
      <div className="px-6 py-4">
        <h3 className="text-sm font-semibold text-gray-900">General — Conversational Agent</h3>
        <p className="text-xs text-gray-500 mt-0.5">
          The General agent answers ad-hoc questions and provides blueprint explanations.
          It has read-only access to all workspaces.
        </p>
      </div>
      <div className="px-6">
        <FieldRow label="Model" hint="LLM for General conversations">
          <input
            className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10 font-mono"
            value={draft.model}
            onChange={e => setDraft(d => ({ ...d, model: e.target.value }))}
            placeholder="openai/gpt-5.3-chat"
          />
        </FieldRow>
      </div>
      <div className="px-6 py-4 flex justify-end">
        <button
          onClick={() => onSave(draft as unknown as Record<string, unknown>)}
          disabled={saving}
          className="flex items-center gap-2 px-5 py-2 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-800 disabled:opacity-40 transition-colors"
        >
          <Save size={13} /> {saving ? 'Saving…' : 'Save General settings'}
        </button>
      </div>
    </div>
  );
}

// ── System section ────────────────────────────────────────────────────────────

function SystemSection({ settings, onSave, onReset, saving }: {
  settings: AtomicSettings;
  onSave: (updates: Record<string, unknown>) => void;
  onReset: () => void;
  saving: boolean;
}) {
  const [draft, setDraft] = useState({ ...settings.system });
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl border border-gray-200 divide-y divide-gray-100">
        <div className="px-6 py-4">
          <h3 className="text-sm font-semibold text-gray-900">System Settings</h3>
          <p className="text-xs text-gray-500 mt-0.5">Global system behaviour — affects all agents and sessions.</p>
        </div>
        <div className="px-6">
          <FieldRow label="Token Budget" hint="Max tokens per generation session (0 = unlimited)">
            <NumberInput value={draft.tokenBudget} onChange={v => setDraft(d => ({ ...d, tokenBudget: v }))} min={0} max={10_000_000} step={10000} />
          </FieldRow>
          <FieldRow label="Streaming" hint="Stream tokens to UI in real time">
            <Toggle value={draft.streamingEnabled} onChange={v => setDraft(d => ({ ...d, streamingEnabled: v }))} label={draft.streamingEnabled ? 'Enabled' : 'Disabled'} />
          </FieldRow>
          <FieldRow label="Developer Mode" hint="Show Atomic Dev Panel with traces, metrics, and event bus">
            <Toggle value={draft.developerMode} onChange={v => setDraft(d => ({ ...d, developerMode: v }))} label={draft.developerMode ? 'Enabled' : 'Disabled'} />
          </FieldRow>
          <FieldRow label="Version Retention" hint="Number of blueprint versions to keep ('all' = unlimited)">
            <Select
              value={String(draft.versionRetention)}
              onChange={v => setDraft(d => ({ ...d, versionRetention: v === 'all' ? 'all' : Number(v) }))}
              options={[
                { value: 'all', label: 'All versions' },
                { value: '5', label: '5 versions' },
                { value: '10', label: '10 versions' },
                { value: '25', label: '25 versions' },
                { value: '50', label: '50 versions' },
              ]}
            />
          </FieldRow>
        </div>
        <div className="px-6 py-4 flex items-center justify-between">
          {confirmReset ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-red-600 font-medium">Reset all settings to defaults?</span>
              <button onClick={() => { onReset(); setConfirmReset(false); }} className="px-3 py-1 bg-red-600 text-white text-xs rounded-lg hover:bg-red-700">Confirm</button>
              <button onClick={() => setConfirmReset(false)} className="px-3 py-1 bg-gray-100 text-gray-600 text-xs rounded-lg hover:bg-gray-200">Cancel</button>
            </div>
          ) : (
            <button onClick={() => setConfirmReset(true)} className="text-xs text-gray-400 hover:text-red-600 transition-colors">Reset to defaults…</button>
          )}
          <button
            onClick={() => onSave(draft as unknown as Record<string, unknown>)}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-800 disabled:opacity-40 transition-colors"
          >
            <Save size={13} /> {saving ? 'Saving…' : 'Save System settings'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Projects section ──────────────────────────────────────────────────────────

interface Project {
  id: string;
  name: string;
  description?: string;
  phase: string;
  currentBlueprintVersion: number;
  createdAt: string;
  lastActiveAt: string;
}

function ProjectsSection() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [switchingId, setSwitchingId] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [listRes, activeRes] = await Promise.all([
        fetch('/api/v1/projects'),
        fetch('/api/v1/projects/active'),
      ]);
      if (listRes.ok) {
        const data = await listRes.json() as { projects: Project[] };
        setProjects(data.projects ?? []);
      }
      if (activeRes.ok) {
        const data = await activeRes.json() as { project: Project };
        setActiveId(data.project?.id ?? null);
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async data-load kickoff (intentional)
  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/v1/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim(), description: newDesc.trim() || undefined }),
      });
      if (res.ok) {
        setNewName(''); setNewDesc(''); setShowCreate(false);
        await load();
      }
    } catch { /* ignore */ }
    finally { setCreating(false); }
  };

  const handleSwitch = async (id: string) => {
    setSwitchingId(id);
    try {
      const res = await fetch(`/api/v1/projects/${id}/switch`, { method: 'POST' });
      if (res.ok) { setActiveId(id); }
    } catch { /* ignore */ }
    finally { setSwitchingId(null); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this project? This cannot be undone.')) return;
    try {
      await fetch(`/api/v1/projects/${id}`, { method: 'DELETE' });
      await load();
    } catch { /* ignore */ }
  };

  const phaseLabel: Record<string, string> = {
    idle: 'Idle', scoping: 'Scoping', pipeline: 'Pipeline', refinement: 'Refinement', complete: 'Complete',
  };

  if (loading) {
    return <div className="flex items-center justify-center h-32 text-gray-400 text-sm">Loading projects…</div>;
  }

  return (
    <div className="space-y-4">
      {/* Create button */}
      <div className="flex justify-end">
        <button
          onClick={() => setShowCreate(v => !v)}
          className="flex items-center gap-1.5 px-4 py-2 bg-gray-900 text-white text-sm font-medium rounded-xl hover:bg-gray-800 transition-colors"
        >
          <Plus size={13} /> New Project
        </button>
      </div>

      {showCreate && (
        <div className="bg-white rounded-xl border border-gray-200 p-4 space-y-3">
          <h4 className="text-sm font-semibold text-gray-900">New Project</h4>
          <div>
            <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide block mb-1">Name *</label>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder="e.g. E-commerce Platform v2"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10"
              autoFocus
            />
          </div>
          <div>
            <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide block mb-1">Description</label>
            <input
              value={newDesc}
              onChange={e => setNewDesc(e.target.value)}
              placeholder="Optional short description"
              className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10"
            />
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
              className="flex items-center gap-1.5 px-4 py-2 bg-gray-900 text-white text-xs rounded-lg hover:bg-gray-800 disabled:opacity-40"
            >
              <Plus size={12} /> {creating ? 'Creating…' : 'Create'}
            </button>
            <button onClick={() => setShowCreate(false)} className="px-3 py-2 text-xs text-gray-500 hover:text-gray-700">Cancel</button>
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="bg-white rounded-xl border border-dashed border-gray-200 p-8 text-center">
          <FolderOpen size={24} className="mx-auto mb-2 text-gray-300" />
          <p className="text-sm text-gray-500">No projects yet.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {projects.map(project => (
            <div
              key={project.id}
              className={`bg-white rounded-xl border p-4 flex items-start gap-4 ${
                project.id === activeId ? 'border-gray-400 shadow-sm' : 'border-gray-200'
              }`}
            >
              <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0">
                <FolderOpen size={14} className="text-gray-500" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-gray-800 truncate">{project.name}</span>
                  {project.id === activeId && (
                    <span className="text-[9px] bg-gray-900 text-white px-1.5 py-0.5 rounded-full font-medium">ACTIVE</span>
                  )}
                  <span className="text-[10px] text-gray-400 bg-gray-50 px-1.5 py-0.5 rounded font-mono">
                    {phaseLabel[project.phase] ?? project.phase}
                  </span>
                </div>
                {project.description && (
                  <p className="text-xs text-gray-500 mt-0.5 truncate">{project.description}</p>
                )}
                <p className="text-[10px] text-gray-400 mt-1">
                  v{project.currentBlueprintVersion} · Last active {new Date(project.lastActiveAt).toLocaleDateString()}
                </p>
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                {project.id !== activeId && (
                  <button
                    onClick={() => handleSwitch(project.id)}
                    disabled={switchingId === project.id}
                    className="px-3 py-1.5 text-xs bg-gray-900 text-white rounded-lg hover:bg-gray-800 disabled:opacity-40 transition-colors"
                  >
                    {switchingId === project.id ? 'Switching…' : 'Switch'}
                  </button>
                )}
                {project.id !== 'default' && (
                  <button onClick={() => handleDelete(project.id)} className="p-1.5 text-gray-400 hover:text-red-500 transition-colors">
                    <Trash2 size={13} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Skill types (mirrored from src/engine/skills.ts) ─────────────────────────
interface Skill {
  id:          string;
  name:        string;
  description: string;
  category:    string;
  isBuiltIn:   boolean;
  enabled:     boolean;
  systemPromptAddition: string;
  pillarFilter?: string[];
  createdAt?:  string;
}

// ── Skills section ────────────────────────────────────────────────────────────

function SkillsSection() {
  const [skills,          setSkills]          = useState<Skill[]>([]);
  const [loading,         setLoading]         = useState(true);
  const [error,           setError]           = useState<string | null>(null);
  const [editingId,       setEditingId]       = useState<string | null>(null);
  const [showCreate,      setShowCreate]      = useState(false);
  const [creating,        setCreating]        = useState(false);
  const [savingId,        setSavingId]        = useState<string | null>(null);
  const [newSkill, setNewSkill] = useState({
    name:        '',
    description: '',
    category:    'custom',
    systemPromptAddition: '',
  });
  const [editDraft, setEditDraft] = useState<Partial<Skill>>({});

  const loadSkills = useCallback(async () => {
    try {
      const res = await fetch('/api/v1/skills');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSkills(data.skills ?? []);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async data-load kickoff (intentional)
  useEffect(() => { loadSkills(); }, [loadSkills]);

  const handleToggle = async (skill: Skill) => {
    const updated = { ...skill, enabled: !skill.enabled };
    setSkills(prev => prev.map(s => s.id === skill.id ? updated : s));
    try {
      await fetch(`/api/v1/skills/${skill.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: updated.enabled }),
      });
    } catch {
      setSkills(prev => prev.map(s => s.id === skill.id ? skill : s));
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this custom skill?')) return;
    setSkills(prev => prev.filter(s => s.id !== id));
    await fetch(`/api/v1/skills/${id}`, { method: 'DELETE' });
    await loadSkills();
  };

  const handleCreate = async () => {
    if (!newSkill.name.trim() || !newSkill.systemPromptAddition.trim()) return;
    setCreating(true);
    try {
      const res = await fetch('/api/v1/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newSkill),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSkills(data.skills ?? []);
      setNewSkill({ name: '', description: '', category: 'custom', systemPromptAddition: '' });
      setShowCreate(false);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setCreating(false);
    }
  };

  const handleSaveEdit = async (id: string) => {
    setSavingId(id);
    try {
      const res = await fetch(`/api/v1/skills/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editDraft),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setSkills(prev => prev.map(s => s.id === id ? data.skill : s));
      setEditingId(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSavingId(null);
    }
  };

  const categoryColors: Record<string, string> = {
    'security':     'bg-red-50 text-red-700 border-red-200',
    'performance':  'bg-orange-50 text-orange-700 border-orange-200',
    'architecture': 'bg-violet-50 text-violet-700 border-violet-200',
    'quality':      'bg-blue-50 text-blue-700 border-blue-200',
    'ux':           'bg-pink-50 text-pink-700 border-pink-200',
    'documentation':'bg-slate-50 text-slate-700 border-slate-200',
    'accessibility':'bg-teal-50 text-teal-700 border-teal-200',
    'custom':       'bg-gray-50 text-gray-700 border-gray-200',
  };

  const builtIn  = skills.filter(s => s.isBuiltIn);
  const custom   = skills.filter(s => !s.isBuiltIn);

  if (loading) return (
    <div className="flex items-center gap-2 text-sm text-gray-500 py-8">
      <div className="w-4 h-4 border-2 border-rose-900/30 border-t-rose-900 rounded-full animate-spin" />
      Loading skills…
    </div>
  );

  if (error) return (
    <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-4">
      <AlertCircle size={14} /> Failed to load skills: {error}
    </div>
  );

  return (
    <div className="space-y-8">
      <div>
        <p className="text-sm text-gray-500 mb-1">
          Skills augment every agent in the pipeline with domain-specific instructions.
          Toggle built-in skills or create your own to steer generation output.
        </p>
      </div>

      {/* Built-in skills */}
      <div>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
          Built-in Skills
        </h3>
        <div className="space-y-2">
          {builtIn.map(skill => {
            const isEditing = editingId === skill.id;
            return (
              <div
                key={skill.id}
                className={`bg-white rounded-xl border border-gray-200 p-4 transition-all
                            ${skill.enabled ? '' : 'opacity-60'}`}
              >
                {isEditing ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide block mb-1">Name</label>
                        <input
                          className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-900/20"
                          value={editDraft.name ?? skill.name}
                          onChange={e => setEditDraft(d => ({ ...d, name: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide block mb-1">Description</label>
                        <input
                          className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-900/20"
                          value={editDraft.description ?? skill.description}
                          onChange={e => setEditDraft(d => ({ ...d, description: e.target.value }))}
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide block mb-1">System Prompt Addition</label>
                      <textarea
                        rows={3}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-900/20 resize-none font-mono"
                        value={editDraft.systemPromptAddition ?? skill.systemPromptAddition}
                        onChange={e => setEditDraft(d => ({ ...d, systemPromptAddition: e.target.value }))}
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleSaveEdit(skill.id)}
                        disabled={!!savingId}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-900 text-white text-xs rounded-lg hover:bg-gray-700 transition-colors"
                      >
                        <Save size={12} /> {savingId === skill.id ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => { setEditingId(null); setEditDraft({}); }}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 text-gray-600 text-xs rounded-lg hover:bg-gray-50 transition-colors"
                      >
                        <X size={12} /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                          <span className="text-sm font-semibold text-gray-900">{skill.name}</span>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium
                                          ${categoryColors[skill.category] ?? categoryColors['custom']}`}>
                            {skill.category}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 line-clamp-2">{skill.description}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => { setEditingId(skill.id); setEditDraft({}); }}
                        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                        title="Edit skill"
                      >
                        <Edit2 size={13} />
                      </button>
                      <button
                        onClick={() => handleToggle(skill)}
                        className={`flex items-center gap-1 text-xs transition-colors
                                    ${skill.enabled ? 'text-emerald-600' : 'text-gray-400'}`}
                        title={skill.enabled ? 'Disable skill' : 'Enable skill'}
                      >
                        {skill.enabled
                          ? <ToggleRight size={22} className="text-emerald-500" />
                          : <ToggleLeft  size={22} className="text-gray-300" />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Custom skills */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-widest">
            Custom Skills
          </h3>
          <button
            onClick={() => setShowCreate(v => !v)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 bg-gray-900 text-white rounded-lg hover:bg-gray-700 transition-colors"
          >
            <Plus size={12} /> New Skill
          </button>
        </div>

        {/* Create form */}
        {showCreate && (
          <div className="bg-white rounded-xl border border-gray-200 p-4 mb-3 space-y-3">
            <h4 className="text-sm font-semibold text-gray-900">Create Custom Skill</h4>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide block mb-1">Name *</label>
                <input
                  placeholder="e.g. GraphQL Expert"
                  className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-900/20"
                  value={newSkill.name}
                  onChange={e => setNewSkill(s => ({ ...s, name: e.target.value }))}
                />
              </div>
              <div>
                <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide block mb-1">Category</label>
                <select
                  className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-900/20 bg-white"
                  value={newSkill.category}
                  onChange={e => setNewSkill(s => ({ ...s, category: e.target.value }))}
                >
                  {['architecture', 'security', 'performance', 'quality', 'ux', 'documentation', 'accessibility', 'custom'].map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide block mb-1">Description</label>
              <input
                placeholder="What does this skill add?"
                className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-900/20"
                value={newSkill.description}
                onChange={e => setNewSkill(s => ({ ...s, description: e.target.value }))}
              />
            </div>
            <div>
              <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide block mb-1">
                System Prompt Injection *
              </label>
              <textarea
                rows={4}
                placeholder="Instructions injected into the system prompt for every agent when this skill is active…"
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-900/20 resize-none font-mono"
                value={newSkill.systemPromptAddition}
                onChange={e => setNewSkill(s => ({ ...s, systemPromptAddition: e.target.value }))}
              />
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleCreate}
                disabled={creating || !newSkill.name.trim() || !newSkill.systemPromptAddition.trim()}
                className="flex items-center gap-1.5 px-4 py-2 bg-rose-900 text-white text-xs rounded-lg hover:bg-rose-800 disabled:opacity-40 transition-colors font-medium"
              >
                <Plus size={12} /> {creating ? 'Creating…' : 'Create Skill'}
              </button>
              <button
                onClick={() => setShowCreate(false)}
                className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 text-gray-600 text-xs rounded-lg hover:bg-gray-50 transition-colors"
              >
                <X size={12} /> Cancel
              </button>
            </div>
          </div>
        )}

        {custom.length === 0 && !showCreate && (
          <div className="bg-white rounded-xl border border-dashed border-gray-200 p-6 text-center">
            <Zap size={20} className="mx-auto mb-2 text-gray-300" />
            <p className="text-sm text-gray-500">No custom skills yet.</p>
            <p className="text-xs text-gray-400 mt-0.5">Create one to inject specialised instructions into every agent.</p>
          </div>
        )}

        <div className="space-y-2">
          {custom.map(skill => {
            const isEditing = editingId === skill.id;
            return (
              <div
                key={skill.id}
                className={`bg-white rounded-xl border border-gray-200 p-4 transition-all
                            ${skill.enabled ? '' : 'opacity-60'}`}
              >
                {isEditing ? (
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-3">
                      <div>
                        <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide block mb-1">Name</label>
                        <input
                          className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-900/20"
                          value={editDraft.name ?? skill.name}
                          onChange={e => setEditDraft(d => ({ ...d, name: e.target.value }))}
                        />
                      </div>
                      <div>
                        <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide block mb-1">Description</label>
                        <input
                          className="w-full px-3 py-1.5 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-900/20"
                          value={editDraft.description ?? skill.description}
                          onChange={e => setEditDraft(d => ({ ...d, description: e.target.value }))}
                        />
                      </div>
                    </div>
                    <div>
                      <label className="text-[10px] font-medium text-gray-500 uppercase tracking-wide block mb-1">System Prompt Addition</label>
                      <textarea
                        rows={3}
                        className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-rose-900/20 resize-none font-mono"
                        value={editDraft.systemPromptAddition ?? skill.systemPromptAddition}
                        onChange={e => setEditDraft(d => ({ ...d, systemPromptAddition: e.target.value }))}
                      />
                    </div>
                    <div className="flex gap-2">
                      <button
                        onClick={() => handleSaveEdit(skill.id)}
                        disabled={!!savingId}
                        className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-900 text-white text-xs rounded-lg hover:bg-gray-700 transition-colors"
                      >
                        <Save size={12} /> {savingId === skill.id ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        onClick={() => { setEditingId(null); setEditDraft({}); }}
                        className="flex items-center gap-1.5 px-3 py-1.5 border border-gray-200 text-gray-600 text-xs rounded-lg hover:bg-gray-50 transition-colors"
                      >
                        <X size={12} /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-start gap-3 min-w-0">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                          <span className="text-sm font-semibold text-gray-900">{skill.name}</span>
                          <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium
                                          ${categoryColors[skill.category] ?? categoryColors['custom']}`}>
                            {skill.category}
                          </span>
                        </div>
                        <p className="text-xs text-gray-500 line-clamp-2">{skill.description}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => { setEditingId(skill.id); setEditDraft({}); }}
                        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-lg transition-colors"
                        title="Edit skill"
                      >
                        <Edit2 size={13} />
                      </button>
                      <button
                        onClick={() => handleDelete(skill.id)}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors"
                        title="Delete skill"
                      >
                        <Trash2 size={13} />
                      </button>
                      <button
                        onClick={() => handleToggle(skill)}
                        className={`flex items-center gap-1 text-xs transition-colors
                                    ${skill.enabled ? 'text-emerald-600' : 'text-gray-400'}`}
                        title={skill.enabled ? 'Disable skill' : 'Enable skill'}
                      >
                        {skill.enabled
                          ? <ToggleRight size={22} className="text-emerald-500" />
                          : <ToggleLeft  size={22} className="text-gray-300" />}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="p-4 bg-violet-50 border border-violet-200 rounded-xl text-sm text-violet-800 flex gap-3">
        <Zap size={15} className="shrink-0 mt-0.5 text-violet-600" />
        <div>
          <strong>How Skills work:</strong> Active skills inject their system prompt addition into
          every agent in the pipeline. Built-in skills are curated and battle-tested.
          Custom skills let you tailor Atomic to your team&apos;s specific conventions.
        </div>
      </div>
    </div>
  );
}

// ── Developer section ─────────────────────────────────────────────────────────

interface BusEvent {
  id: string; type: string; sessionId: string; traceId: string;
  ts: string; data: Record<string, unknown>;
}

interface LtmEntry {
  domain: string; key: string; value: string; source_agent: string;
  importance: string; tags: string; ts: string;
}

const EVENT_COLORS: Record<string, string> = {
  'curator':    'text-violet-600',  'artemis':    'text-sky-600',
  'blueprint':  'text-emerald-600', 'workspace':  'text-amber-600',
  'generation': 'text-rose-600',    'pipeline':   'text-orange-600',
  'error':      'text-red-600',
};

function eventColor(type: string): string {
  for (const [k, c] of Object.entries(EVENT_COLORS)) {
    if (type.toLowerCase().includes(k)) return c;
  }
  return 'text-gray-500';
}

function DeveloperSection() {
  const [events, setEvents]         = useState<BusEvent[]>([]);
  const [paused, setPaused]         = useState(false);
  const [connected, setConnected]   = useState(false);
  const [filter, setFilter]         = useState('');
  const [ltm, setLtm]               = useState<LtmEntry[]>([]);
  const [ltmLoading, setLtmLoading] = useState(false);
  const [ltmExpanded, setLtmExpanded] = useState(false);
  const [monitorExpanded, setMonitorExpanded] = useState(true);
  const esRef = useRef<EventSource | null>(null);
  const bufRef = useRef<BusEvent[]>([]);
  const pausedRef = useRef(paused);

  useEffect(() => { pausedRef.current = paused; }, [paused]);

  const flush = useCallback(() => {
    if (bufRef.current.length === 0) return;
    const incoming = bufRef.current.splice(0);
    setEvents(prev => [...incoming, ...prev].slice(0, 200));
  }, []);

  useEffect(() => {
    const flushInterval = setInterval(flush, 500);
    return () => clearInterval(flushInterval);
  }, [flush]);

  useEffect(() => {
    const es = new EventSource('/api/v1/event-bus/stream');
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    es.onmessage = (e: MessageEvent) => {
      if (pausedRef.current) return;
      try {
        const ev: BusEvent = JSON.parse(e.data as string);
        bufRef.current.push(ev);
      } catch { /* ignore malformed */ }
    };

    return () => { es.close(); setConnected(false); };
  }, []);

  const loadLtm = useCallback(async () => {
    setLtmLoading(true);
    try {
      const r = await fetch('/api/v1/agent/memory/long-term?limit=100');
      if (r.ok) {
        const data = await r.json() as { memories: LtmEntry[] };
        setLtm(data.memories);
      }
    } catch { /* silently ignore */ }
    finally { setLtmLoading(false); }
  }, []);

  const clearLtmDomain = useCallback(async (domain: string) => {
    try {
      await fetch(`/api/v1/agent/memory/long-term/${domain}`, { method: 'DELETE' });
      setLtm(prev => prev.filter(m => m.domain !== domain));
    } catch { /* silently ignore */ }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- async data-load kickoff (intentional)
  useEffect(() => { void loadLtm(); }, [loadLtm]);

  const filtered = filter
    ? events.filter(e =>
        e.type.toLowerCase().includes(filter.toLowerCase()) ||
        e.sessionId?.toLowerCase().includes(filter.toLowerCase()))
    : events;

  const ltmByDomain = ltm.reduce<Record<string, LtmEntry[]>>((acc, m) => {
    (acc[m.domain] ||= []).push(m);
    return acc;
  }, {});

  return (
    <div className="space-y-6">

      {/* ── Live Event Bus Monitor ── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <button
          onClick={() => setMonitorExpanded(p => !p)}
          className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-gray-50 transition-colors"
        >
          <Activity size={16} className="text-gray-600 shrink-0" />
          <span className="font-semibold text-gray-900 text-sm flex-1">Live Event Bus Monitor</span>
          <div className="flex items-center gap-2 mr-2">
            {connected
              ? <span className="flex items-center gap-1.5 text-xs text-emerald-600"><Wifi size={12}/> Connected</span>
              : <span className="flex items-center gap-1.5 text-xs text-red-500"><WifiOff size={12}/> Disconnected</span>}
            <span className="text-xs text-gray-400">{events.length} events</span>
          </div>
          {monitorExpanded ? <ChevronDown size={15} className="text-gray-400"/> : <ChevronRight size={15} className="text-gray-400"/>}
        </button>

        {monitorExpanded && (
          <div className="border-t border-gray-100">
            {/* Controls */}
            <div className="px-5 py-3 flex items-center gap-3 border-b border-gray-100 bg-gray-50/60">
              <div className="relative flex-1 max-w-xs">
                <Filter size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400"/>
                <input
                  value={filter}
                  onChange={e => setFilter(e.target.value)}
                  placeholder="Filter by event type or session…"
                  className="w-full pl-7 pr-3 py-1.5 text-xs border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-gray-900/10 bg-white"
                />
              </div>
              <button
                onClick={() => setPaused(p => !p)}
                className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border transition-colors
                            ${paused
                              ? 'bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100'
                              : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}
              >
                {paused ? <><Play size={12}/> Resume</> : <><Pause size={12}/> Pause</>}
              </button>
              <button
                onClick={() => { setEvents([]); bufRef.current = []; }}
                className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors bg-white"
              >
                <Trash2 size={12}/> Clear
              </button>
              {paused && (
                <span className="flex items-center gap-1 text-xs text-amber-600 animate-pulse">
                  <Radio size={11}/> Paused
                </span>
              )}
            </div>

            {/* Event stream */}
            <div className="font-mono text-xs overflow-y-auto bg-[#1c1612]" style={{ height: 340 }}>
              {filtered.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-white/30 gap-2">
                  <Activity size={22}/>
                  <span>{connected ? 'Waiting for events…' : 'Connecting to event bus…'}</span>
                </div>
              ) : filtered.map((ev, i) => (
                <div
                  key={`${ev.id}-${i}`}
                  className="flex items-start gap-3 px-4 py-1.5 border-b border-white/4 hover:bg-white/5 transition-colors"
                >
                  <span className="text-white/30 shrink-0 mt-0.5 tabular-nums">
                    {new Date(ev.ts).toLocaleTimeString('en', { hour12: false })}
                  </span>
                  <span className={`shrink-0 font-semibold ${eventColor(ev.type)}`} style={{ minWidth: 220 }}>
                    {ev.type}
                  </span>
                  <span className="text-white/50 truncate" title={JSON.stringify(ev.data)}>
                    {ev.sessionId ? <span className="text-white/20 mr-2">[{ev.sessionId.slice(0, 8)}]</span> : null}
                    {JSON.stringify(ev.data).slice(0, 120)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Long-term Memory Inspector ── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <button
          onClick={() => setLtmExpanded(p => !p)}
          className="w-full flex items-center gap-3 px-5 py-4 text-left hover:bg-gray-50 transition-colors"
        >
          <Database size={16} className="text-gray-600 shrink-0"/>
          <span className="font-semibold text-gray-900 text-sm flex-1">Agent Long-term Memory</span>
          <div className="flex items-center gap-2 mr-2">
            <span className="text-xs text-gray-400">{ltm.length} entries</span>
            <button
              onClick={e => { e.stopPropagation(); void loadLtm(); }}
              className="text-xs text-blue-600 hover:underline px-1"
            >
              {ltmLoading ? 'Loading…' : 'Refresh'}
            </button>
          </div>
          {ltmExpanded ? <ChevronDown size={15} className="text-gray-400"/> : <ChevronRight size={15} className="text-gray-400"/>}
        </button>

        {ltmExpanded && (
          <div className="border-t border-gray-100 divide-y divide-gray-100">
            {Object.keys(ltmByDomain).length === 0 ? (
              <div className="px-5 py-8 text-center text-sm text-gray-400">
                <Database size={20} className="mx-auto mb-2 opacity-30"/>
                No long-term memory entries yet. Memories are created automatically as Artemis and Curator process blueprints.
              </div>
            ) : Object.entries(ltmByDomain).map(([domain, entries]) => (
              <div key={domain} className="px-5 py-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-xs font-bold uppercase tracking-widest text-gray-400">{domain}</span>
                  <span className="bg-gray-100 text-gray-500 text-[10px] px-1.5 py-0.5 rounded-full">{entries.length}</span>
                  <button
                    onClick={() => void clearLtmDomain(domain)}
                    className="ml-auto text-xs text-red-400 hover:text-red-600 transition-colors"
                  >
                    Clear domain
                  </button>
                </div>
                <div className="space-y-1.5">
                  {entries.map((m, i) => (
                    <div key={i} className="flex items-start gap-3 text-xs">
                      <span className={`shrink-0 mt-0.5 w-2 h-2 rounded-full ${
                        m.importance === 'high'   ? 'bg-red-400' :
                        m.importance === 'medium' ? 'bg-amber-400' : 'bg-gray-300'}`}
                      />
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-gray-500 shrink-0">{m.key}</span>
                          <span className="text-gray-300">·</span>
                          <span className="text-gray-400 shrink-0">{m.source_agent}</span>
                        </div>
                        <div className="text-gray-700 mt-0.5 line-clamp-2">{m.value}</div>
                      </div>
                      <span className="text-gray-300 shrink-0 flex items-center gap-1 mt-0.5">
                        <Clock size={10}/>
                        {new Date(m.ts).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Quick links ── */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-5 py-4">
        <div className="text-xs font-semibold text-gray-700 mb-3 flex items-center gap-2">
          <Terminal size={13}/> Raw API Endpoints
        </div>
        <div className="grid grid-cols-2 gap-2">
          {[
            ['/api/v1/event-bus/history', 'Event history (last 100)'],
            ['/api/v1/event-bus/stream',  'SSE stream (live)'],
            ['/api/v1/agent/memory/long-term', 'LTM entries (JSON)'],
            ['/api/v1/metrics',           'System metrics'],
          ].map(([url, label]) => (
            <a key={url} href={url} target="_blank" rel="noreferrer"
               className="flex items-center gap-1.5 text-xs text-blue-600 hover:underline font-mono truncate">
              {label}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main Settings page ────────────────────────────────────────────────────────

export function Settings() {
  const navigate   = useNavigate();
  const cached     = getCachedConfig();
  const [config, setConfig] = useState<ModelConfig>(
    () => ({ ...getDefaultConfigForProvider(cached?.provider ?? 'openrouter'), ...cached })
  );
  const [isLoadingConfig, setIsLoadingConfig] = useState(!cached);
  const [activeSection, setActiveSection]     = useState('provider');
  const [isSaved,  setIsSaved]  = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Atomic agent/system settings
  const atomicSettings = useAtomicSettings();

  useEffect(() => {
    loadClientConfig().then(saved => {
      if (saved) { setConfig(p => ({ ...p, ...saved })); setCachedConfig(saved); }
    }).finally(() => setIsLoadingConfig(false));
  }, []);

  const timerRef = React.useRef<NodeJS.Timeout | undefined>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const activeProvider = PROVIDERS.find(p => p.slug === config.provider) ?? PROVIDERS[0]!;

  const handleProviderSelect = (slug: string) => {
    if (slug === config.provider) return;
    setConfig(getDefaultConfigForProvider(slug));
    setIsSaved(false);
  };

  const handleSave = async () => {
    if (isSaving) return;
    setSaveError(null); setIsSaving(true);
    try {
      await saveClientConfig(config);
      setIsSaved(true);
      setCachedConfig({ provider: config.provider, fastModel: config.fastModel, proModel: config.proModel, effort: config.effort, thinkingEnabled: config.thinkingEnabled });
      timerRef.current = setTimeout(() => setIsSaved(false), 2500);
    } catch (err: any) {
      setSaveError(err.message ?? 'Failed to save settings. Please try again.');
      timerRef.current = setTimeout(() => setSaveError(null), 4000);
    } finally { setIsSaving(false); }
  };

  const sectionHeader: Record<string, string> = {
    provider:  'Provider',
    auth:      'Authentication',
    model:     'Model Selection',
    skills:    'Skills',
    artemis:   'Artemis Agent',
    curator:   'Curator Agent',
    general:   'General Agent',
    pipeline:  'Pipeline',
    projects:  'Projects',
    system:    'System',
    developer: 'Developer Tools',
  };

  const sectionDesc: Record<string, string> = {
    provider:  'Choose your AI provider. Atomic supports all major providers via OpenRouter or direct API access.',
    auth:      `Enter your API key for ${activeProvider?.name}. Your key is encrypted with AES-256-GCM and stored server-side.`,
    model:     'Select models for Fast Mode (speed-optimised) and Safe Mode (deeper analysis). Cost estimates update automatically.',
    skills:    'Manage skills that augment every agent in the pipeline with domain-specific instructions.',
    artemis:   'Configure Artemis — the scoping agent that extracts requirements and produces the product brief.',
    curator:   'Configure Curator — the review agent that researches and refines the generated blueprint.',
    general:   'Configure the General conversational agent (read-only workspace access).',
    pipeline:  'Configure the pipeline orchestrator — parallelism, failure strategy, per-pillar model overrides.',
    projects:  'Manage projects. Each project has its own state, workspaces, blueprints, and version history.',
    system:    'Global system settings — token budgets, developer mode, streaming, version retention.',
    developer: 'Live event bus monitor, long-term agent memory inspector, and internal observability tools.',
  };

  const isProviderSection = ['provider', 'auth', 'model'].includes(activeSection);
  const isAgentSection = ['artemis', 'curator', 'general', 'pipeline'].includes(activeSection);
  const isSystemSection = ['system', 'developer'].includes(activeSection);

  return (
    <div className="min-h-screen flex" style={{ background: '#f5f4f0' }}>

      {/* ── Dark sidebar ─────────────────────────────────────────────── */}
      <aside
        className="w-56 shrink-0 flex flex-col border-r border-white/10 sticky top-0 h-screen overflow-y-auto"
        style={{ background: '#1c1612' }}
      >
        <div className="px-4 pt-5 pb-4">
          <button
            onClick={() => navigate('/')}
            className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/70
                       transition-colors mb-4"
          >
            <ArrowLeft size={12} /> Back to app
          </button>
          <div className="font-mono font-bold text-white text-base tracking-tighter">ATOMIC</div>
          <div className="text-[11px] text-white/40 mt-0.5">Settings</div>
        </div>

        <nav className="flex-1 px-2 py-2">
          {NAV_GROUPS.map((group, gi) => (
            <div key={group.label} className={gi > 0 ? 'mt-3' : ''}>
              <p className="text-[9px] font-semibold text-white/30 uppercase tracking-widest px-3 mb-1">
                {group.label}
              </p>
              {group.items.map(({ id, icon: Icon, label }) => (
                <button
                  key={id}
                  onClick={() => setActiveSection(id)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs
                              transition-colors mb-0.5 text-left
                              ${activeSection === id
                                ? 'bg-white/15 text-white font-medium'
                                : 'text-white/60 hover:text-white hover:bg-white/8'}`}
                >
                  <Icon size={13} className="shrink-0" />
                  {label}
                </button>
              ))}
            </div>
          ))}
        </nav>

        {/* Show sidebar Save only for provider sections */}
        {isProviderSection && (
          <div className="px-3 py-4 border-t border-white/8 mt-auto">
            <button
              onClick={handleSave}
              disabled={isSaving || isLoadingConfig}
              className={`w-full py-2.5 rounded-xl text-sm font-semibold transition-all
                          ${isSaved
                            ? 'bg-emerald-500 text-white'
                            : 'bg-white text-gray-900 hover:bg-gray-100 disabled:opacity-40'}`}
            >
              {isLoadingConfig ? 'Loading…' : isSaving ? 'Saving…' : isSaved ? '✓ Saved' : 'Save Settings'}
            </button>
          </div>
        )}

        {/* Atomic settings save indicator */}
        {(isAgentSection || isSystemSection) && atomicSettings.saved && (
          <div className="px-3 py-3 border-t border-white/8 mt-auto">
            <div className="flex items-center gap-2 text-xs text-emerald-400">
              <Check size={12} /> Settings saved
            </div>
          </div>
        )}
      </aside>

      {/* ── Main content ─────────────────────────────────────────────── */}
      <div className="flex-1 min-w-0 overflow-y-auto">

        {/* Header */}
        <header
          className="px-8 py-5 border-b border-gray-200 flex items-center justify-between sticky top-0 z-10"
          style={{ background: '#f5f4f0' }}
        >
          <div>
            <h1 className="text-lg font-bold text-gray-900">
              {sectionHeader[activeSection] ?? 'Settings'}
            </h1>
            <p className="text-xs text-gray-500 mt-0.5">
              {sectionDesc[activeSection]}
            </p>
          </div>

          {/* Save status indicator */}
          {(isSaved || saveError || atomicSettings.saved || atomicSettings.error) && (
            <div className={`flex items-center gap-2 text-sm px-4 py-2 rounded-xl
                            ${(isSaved || atomicSettings.saved)
                              ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                              : 'bg-red-50 text-red-700 border border-red-200'}`}>
              {isSaved || atomicSettings.saved
                ? <><Check size={14} /> Saved</>
                : <><AlertCircle size={14} /> {saveError ?? atomicSettings.error}</>}
            </div>
          )}
        </header>

        <main className="px-8 py-8 max-w-2xl">

          {/* ── Provider section ── */}
          {activeSection === 'provider' && (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {PROVIDERS.filter(p => p.tier === 1).map(p => (
                  <ProviderCard
                    key={p.slug}
                    provider={p}
                    isSelected={config.provider === p.slug}
                    onSelect={() => handleProviderSelect(p.slug)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* ── Authentication section ── */}
          {activeSection === 'auth' && (
            <div className="space-y-5">
              <div className="bg-white rounded-2xl border border-gray-200 p-6">
                {activeProvider && (
                  <ApiKeyInput
                    providerName={activeProvider.name}
                    value={config.apiKey}
                    placeholder={activeProvider.keyPlaceholder}
                    docsUrl={activeProvider.keyDocsUrl}
                    onTest={async () => {
                      try {
                        const res = await fetch('/api/v1/test-key', {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ provider: config.provider, apiKey: config.apiKey }),
                        });
                        return res.ok;
                      } catch { return false; }
                    }}
                    onChange={val => { setConfig(p => ({ ...p, apiKey: val })); setIsSaved(false); }}
                  />
                )}
              </div>

              <div className="flex items-start gap-3 p-4 bg-amber-50 border border-amber-200
                              rounded-xl text-sm text-amber-800">
                <AlertCircle size={15} className="shrink-0 mt-0.5 text-amber-600" />
                <p>
                  <strong>Security Note:</strong> Your key is encrypted (AES-256-GCM) and stored
                  server-side. It is only accessible via your encrypted session cookie and is
                  never written to localStorage.
                </p>
              </div>
            </div>
          )}

          {/* ── Model Selection section ── */}
          {activeSection === 'model' && (
            <div className="space-y-6">
              <div className="bg-white rounded-2xl border border-gray-200 p-6">
                {activeProvider && (
                  <>
                    <ModelPicker
                      provider={activeProvider}
                      fastModel={config.fastModel}
                      proModel={config.proModel}
                      onFastModelChange={val => { setConfig(p => ({ ...p, fastModel: val })); setIsSaved(false); }}
                      onProModelChange={val => { setConfig(p => ({ ...p, proModel: val })); setIsSaved(false); }}
                    />
                    <div className="mt-6 pt-6 border-t border-gray-100">
                      <CostEstimate
                        provider={activeProvider}
                        fastModelId={config.fastModel}
                        proModelId={config.proModel}
                      />
                    </div>

                    {/* Effort + Extended Thinking */}
                    <div className="mt-6 pt-6 border-t border-gray-100 space-y-5">
                      <div>
                        <label className="block text-xs font-semibold text-gray-700 mb-1">Effort level</label>
                        <p className="text-[11px] text-gray-400 mb-2">Controls token budget for pro-model calls. Higher effort produces richer output but costs more.</p>
                        <div className="grid grid-cols-4 gap-1.5">
                          {(['low', 'medium', 'high', 'max'] as const).map(lvl => (
                            <button key={lvl}
                              onClick={() => { setConfig(p => ({ ...p, effort: lvl })); setIsSaved(false); }}
                              className={`py-1.5 rounded-lg text-xs font-medium border transition-all capitalize
                                ${(config.effort ?? 'medium') === lvl
                                  ? 'bg-gray-900 text-white border-gray-900'
                                  : 'bg-white text-gray-600 border-gray-200 hover:border-gray-400'}`}
                            >{lvl}</button>
                          ))}
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="text-xs font-semibold text-gray-700">Extended thinking</p>
                          <p className="text-[11px] text-gray-400 mt-0.5">Enable Claude extended thinking for deeper reasoning on pro-model calls.</p>
                        </div>
                        <button
                          onClick={() => { setConfig(p => ({ ...p, thinkingEnabled: !p.thinkingEnabled })); setIsSaved(false); }}
                          className={`relative w-10 h-5.5 rounded-full transition-colors ${config.thinkingEnabled ? 'bg-gray-900' : 'bg-gray-200'}`}
                          role="switch" aria-checked={!!config.thinkingEnabled}
                        >
                          <span className={`absolute top-0.5 left-0.5 w-4.5 h-4.5 bg-white rounded-full shadow transition-transform ${config.thinkingEnabled ? 'translate-x-4.5' : 'translate-x-0'}`} />
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {/* ── Skills section ── */}
          {activeSection === 'skills' && <SkillsSection />}

          {/* ── Save button for provider/auth/model sections ── */}
          {isProviderSection && activeSection !== 'skills' && (
            <div className="mt-8 flex justify-end">
              <button
                onClick={handleSave}
                disabled={isSaving || isLoadingConfig}
                className={`flex items-center gap-2 px-6 py-2.5 rounded-xl text-sm font-semibold
                            transition-all shadow-sm
                            ${isSaved
                              ? 'bg-emerald-500 text-white'
                              : 'bg-gray-900 text-white hover:bg-gray-700 disabled:opacity-40'}`}
              >
                {isSaved ? <><Check size={14} /> Saved</> : isSaving ? 'Saving…' : 'Save Settings'}
              </button>
            </div>
          )}

          {/* ── Agent settings sections — load only when atomicSettings are ready ── */}
          {(isAgentSection || isSystemSection) && atomicSettings.loading && (
            <div className="flex items-center gap-2 text-sm text-gray-400 py-8">
              <div className="w-4 h-4 border-2 border-gray-300 border-t-gray-700 rounded-full animate-spin" />
              Loading settings…
            </div>
          )}

          {(isAgentSection || isSystemSection) && !atomicSettings.loading && !atomicSettings.settings && (
            <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-4">
              <AlertCircle size={14} /> Failed to load settings. Is the server running?
            </div>
          )}

          {/* ── Artemis section ── */}
          {activeSection === 'artemis' && atomicSettings.settings && (
            <ArtemisSection
              settings={atomicSettings.settings}
              onSave={(updates) => void atomicSettings.patch('artemis', updates)}
              saving={atomicSettings.saving}
            />
          )}

          {/* ── Curator section ── */}
          {activeSection === 'curator' && atomicSettings.settings && (
            <CuratorSection
              settings={atomicSettings.settings}
              onSave={(updates) => void atomicSettings.patch('curator', updates)}
              saving={atomicSettings.saving}
            />
          )}

          {/* ── General agent section ── */}
          {activeSection === 'general' && atomicSettings.settings && (
            <GeneralAgentSection
              settings={atomicSettings.settings}
              onSave={(updates) => void atomicSettings.patch('general', updates)}
              saving={atomicSettings.saving}
            />
          )}

          {/* ── Pipeline section ── */}
          {activeSection === 'pipeline' && atomicSettings.settings && (
            <PipelineSection
              settings={atomicSettings.settings}
              onSave={(updates) => void atomicSettings.patch('pipeline', updates)}
              saving={atomicSettings.saving}
            />
          )}

          {/* ── Projects section ── */}
          {activeSection === 'projects' && <ProjectsSection />}

          {/* ── System section ── */}
          {activeSection === 'system' && atomicSettings.settings && (
            <SystemSection
              settings={atomicSettings.settings}
              onSave={(updates) => void atomicSettings.patch('system', updates)}
              onReset={() => void atomicSettings.reset()}
              saving={atomicSettings.saving}
            />
          )}

          {/* ── Developer section ── */}
          {activeSection === 'developer' && <DeveloperSection />}

        </main>
      </div>
    </div>
  );
}
