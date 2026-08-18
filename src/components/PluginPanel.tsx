/**
 * src/components/PluginPanel.tsx
 *
 * Real plugin panel — replaces the "Coming soon" placeholder in the Chat
 * composer. Lists every registered client plugin with:
 *   - live health status (registry.checkHealth)
 *   - enable/disable toggle (persisted in localStorage)
 *   - doctor validation state (warnings surface to the user)
 *   - a simple per-plugin config dialog for the built-in exporters
 *     (Linear / Notion API keys, team/page IDs)
 */

import { useCallback, useState } from 'react';
import {
  Activity, Check, RefreshCw, Settings, XCircle,
} from 'lucide-react';
import { pluginRegistry } from '../plugins';
import { ApiKeyInput } from './ApiKeyInput';

// ── Small presentational helpers ─────────────────────────────────────────────

function StatusDot({ healthy, checking }: { healthy?: boolean; checking: boolean }) {
  if (checking) return <RefreshCw size={11} className="animate-spin text-gray-400" />;
  if (healthy === undefined) return <Activity size={11} className="text-gray-300" />;
  return healthy
    ? <Check className="h-3 w-3 text-emerald-500" />
    : <XCircle size={11} className="text-red-400" />;
}

// ── Plugin config dialog (built-in exporters) ────────────────────────────────

interface ConfigDialogProps {
  pluginId: string;
  onClose:  () => void;
  onSaved:  () => void;
}

function PluginConfigDialog({ pluginId, onClose, onSaved }: ConfigDialogProps) {
  const reg = pluginRegistry.get(pluginId);

  // Local plugin-scoped storage helper (mirrors registry storage layout so the
  // dialog writes the same keys the exporter reads).
  const storage = (() => {
    const prefix = `atomic_plugin_${pluginId}_`;
    const get = (key: string): string | null => {
      try { return localStorage.getItem(`${prefix}${key}`); } catch { return null; }
    };
    const set = (key: string, value: unknown): void => {
      try { localStorage.setItem(`${prefix}${key}`, JSON.stringify(value)); } catch { /* */ }
    };
    const del = (key: string): void => {
      try { localStorage.removeItem(`${prefix}${key}`); } catch { /* */ }
    };
    return { get, set, del };
  })();

  const isLinear = pluginId === 'built-in/export-linear';
  const _isNotion = pluginId === 'built-in/export-notion';
  const secondaryKey = isLinear ? 'team_id' : 'parent_id';

  const [apiKey, setApiKey] = useState<string>(storage.get('api_key') ?? '');
  const [secondary, setSecondary] = useState<string>(storage.get(secondaryKey) ?? '');
  const [testMessage, setTestMessage] = useState<string>('');
  const [saved, setSaved] = useState(false);

  // onTest returns a boolean so ApiKeyInput can drive its own success/error UI.
  const testConnection = useCallback(async () => {
    setTestMessage('');
    // Point storage at the values being tested, run the exporter's own
    // healthCheck, then restore the originals so un-saved edits never leak.
    const prevKey = storage.get('api_key');
    const prevSec = storage.get(secondaryKey);
    storage.set('api_key', apiKey);
    storage.set(secondaryKey, secondary);
    try {
      const health = await pluginRegistry.checkHealth(pluginId);
      setTestMessage(health.message);
      return health.healthy;
    } catch {
      setTestMessage('Connection test failed');
      return false;
    } finally {
      if (prevKey === null) storage.del('api_key'); else storage.set('api_key', prevKey);
      if (prevSec === null) storage.del(secondaryKey); else storage.set(secondaryKey, prevSec);
    }
  }, [apiKey, secondary, pluginId]);

  const save = useCallback(() => {
    storage.set('api_key', apiKey);
    storage.set(secondaryKey, secondary);
    setSaved(true);
    onSaved();
  }, [apiKey, secondary, onSaved]);

  if (!reg) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3.5" style={{ background: '#1c1612' }}>
          <p className="text-sm font-medium text-white">{reg.manifest.name} — Configuration</p>
          <button onClick={onClose} className="text-white/50 hover:text-white" aria-label="Close"><XCircle size={15} /></button>
        </div>
        <div className="p-5 space-y-4">
          <ApiKeyInput
            value={apiKey}
            onChange={setApiKey}
            providerName={isLinear ? 'Linear' : 'Notion'}
            placeholder={isLinear ? 'lin_api_…' : 'ntn_… or secret_…'}
            onTest={testConnection}
          />
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-1.5">
              {isLinear ? 'Team ID' : 'Parent Page ID'}
            </label>
            <input
              value={secondary}
              onChange={e => setSecondary(e.target.value)}
              placeholder={isLinear ? 'T0000000' : '32-char page ID'}
              className="w-full rounded-lg border border-gray-200 px-3 py-2 text-xs font-mono
                         focus:outline-none focus:ring-2 focus:ring-violet-500/30 focus:border-violet-400"
            />
          </div>
          {testMessage && (
            <p className="text-[11px] text-gray-500 truncate" title={testMessage}>{testMessage}</p>
          )}
          {saved && (
            <p className="text-xs text-emerald-600 flex items-center gap-1.5">
              <Check size={12} /> Saved to plugin storage
            </p>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={onClose}
              className="text-xs px-3.5 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!apiKey.trim() || !secondary.trim()}
              className="text-xs px-3.5 py-2 rounded-lg bg-violet-600 text-white hover:bg-violet-700
                         disabled:opacity-40 disabled:cursor-not-allowed font-medium"
            >
              Save configuration
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Plugin row ───────────────────────────────────────────────────────────────

interface PluginRowProps {
  pluginId: string;
  enabled:  boolean;
  onToggle: () => void;
  onConfig: () => void;
  health?:  { healthy: boolean; message?: string };
  checking: boolean;
  warnings: string[];
}

function PluginRow({ pluginId, enabled, onToggle, onConfig, health, checking, warnings }: PluginRowProps) {
  const reg = pluginRegistry.get(pluginId);
  if (!reg) return null;

  return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-gray-100 hover:bg-gray-50 transition-colors">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <p className="text-xs font-medium text-gray-800 truncate">{reg.manifest.name}</p>
          <StatusDot healthy={health?.healthy} checking={checking} />
        </div>
        {health?.message && (
          <p className="text-[10px] text-gray-400 truncate mt-0.5" title={health.message}>{health.message}</p>
        )}
        {warnings.length > 0 && (
          <p className="text-[10px] text-amber-600 mt-0.5 truncate" title={warnings.join('; ')}>
            {warnings.length} manifest warning{warnings.length > 1 ? 's' : ''}
          </p>
        )}
        {reg.digest && (
          <p className="text-[10px] text-gray-300 font-mono mt-0.5">digest {reg.digest}</p>
        )}
        {reg.consecutiveErrors ? (
          <p className="text-[10px] text-red-400 mt-0.5">{reg.consecutiveErrors} consecutive error{reg.consecutiveErrors > 1 ? 's' : ''} (budget: {reg.consecutiveErrors}/3)</p>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        {(pluginId === 'built-in/export-linear' || pluginId === 'built-in/export-notion') && (
          <button
            onClick={onConfig}
            className="p-1.5 rounded-lg text-gray-400 hover:text-violet-600 hover:bg-violet-50 transition-colors"
            aria-label={`Configure ${reg.manifest.name}`}
            title="Configure"
          >
            <Settings size={13} />
          </button>
        )}
        <button
          onClick={onToggle}
          className={`relative w-8 h-[18px] rounded-full transition-colors ${enabled ? 'bg-violet-500' : 'bg-gray-200'}`}
          role="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? 'Disable' : 'Enable'} ${reg.manifest.name}`}
        >
          <div className={`absolute top-[2px] w-3.5 h-3.5 bg-white rounded-full shadow transition-transform ${enabled ? 'translate-x-4' : 'translate-x-0.5'}`} />
        </button>
      </div>
    </div>
  );
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function PluginPanel() {
  const [, setTick] = useState(0);
  const [checkingAll, setCheckingAll] = useState(false);
  const [configFor, setConfigFor] = useState<string | null>(null);

  const refresh = useCallback(() => setTick(t => t + 1), []);

  const checkAll = useCallback(async () => {
    setCheckingAll(true);
    try {
      setHealth(await pluginRegistry.checkAllHealth());
    } finally {
      setCheckingAll(false);
    }
  }, []);

  // Lazy initial state: seed persisted health once before the first render so
  // no synchronous setState-in-effect cascade is needed (React 19 rule).
  const [health, setHealth] = useState<Record<string, { healthy: boolean; message: string }>>(() => {
    const initial: Record<string, { healthy: boolean; message: string }> = {};
    for (const reg of pluginRegistry.all()) {
      if (reg.lastHealth) initial[reg.manifest.id] = { healthy: reg.lastHealth.healthy, message: reg.lastHealth.message ?? '' };
    }
    return initial;
  });

  const plugins = pluginRegistry.all();

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-2">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-400">Plugins</p>
        <button
          onClick={checkAll}
          disabled={checkingAll}
          className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-violet-600 disabled:opacity-50"
          title="Run health checks on all plugins"
        >
          {checkingAll ? <RefreshCw size={10} className="animate-spin" /> : <Activity size={10} />}
          Check health
        </button>
      </div>
      {plugins.length === 0 && (
        <p className="text-xs text-gray-400 px-1">No plugins registered yet.</p>
      )}
      <div className="space-y-1.5">
        {plugins.map(reg => (
          <PluginRow
            key={reg.manifest.id}
            pluginId={reg.manifest.id}
            enabled={reg.enabled}
            onToggle={() => {
              if (reg.enabled) pluginRegistry.disable(reg.manifest.id); else pluginRegistry.enable(reg.manifest.id);
              refresh();
            }}
            onConfig={() => setConfigFor(reg.manifest.id)}
            health={health[reg.manifest.id]}
            checking={checkingAll}
            warnings={reg.doctorWarnings ?? []}
          />
        ))}
      </div>
      {configFor && (
        <PluginConfigDialog
          pluginId={configFor}
          onClose={() => setConfigFor(null)}
          onSaved={() => { setConfigFor(null); refresh(); }}
        />
      )}
    </div>
  );
}
