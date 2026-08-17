/**
 * src/engine/systemState.ts
 *
 * Atomic System State — §7 of the v4 spec.
 *
 * The Pipeline Orchestrator owns the canonical AtomicSystemState — the single
 * source of truth for the entire system. All state mutations are pure functions
 * through the orchestrator; no component mutates state directly.
 *
 * Key properties:
 *   - Per-session state — one AtomicSystemState per generation session
 *   - Event bus integration — state transitions emit events to subscribers
 *   - Persistent checkpointing — critical state is flushed to SQLite
 *   - Zero shared mutable globals — sessions are isolated maps
 */

import { randomUUID } from 'crypto';
import { publishEvent } from './eventBus';

// ── Pillar status states (§13) ────────────────────────────────────────────────

export type PillarStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'complete'
  | 'failed'
  | 'retrying'
  | 'improving'
  | 'paused'
  | 'skipped'
  | 'low-confidence';

// ── Chat mode ─────────────────────────────────────────────────────────────────

export type ChatMode = 'artemis' | 'curator' | 'general';

// ── Message ───────────────────────────────────────────────────────────────────

export interface SystemMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  streaming?: boolean;
}

// ── Workspace state shapes (lightweight summaries — full data in workspaceManager) ──

export interface ArtemisWorkspaceSummary {
  phase: 'questioning' | 'brief_ready' | 'approved' | 'decomposing' | 'complete';
  confidenceScore: number;
  messageCount: number;
  hasBrief: boolean;
  lastUpdated: string;
}

export interface PipelineWorkspaceSummary {
  totalPillars: number;
  completedPillars: number;
  failedPillars: number;
  overallProgress: number; // 0–1
  lastUpdated: string;
}

export interface CuratorWorkspaceSummary {
  phase: 'idle' | 'analyzing' | 'report_ready' | 'editing' | 'complete';
  findingCount: number;
  editCount: number;
  lastUpdated: string;
}

export interface PillarWorkspaceSummary {
  pillarId: string;
  status: PillarStatus;
  agentCount: number;
  qualityScore?: number;
  lastUpdated: string;
  streamingContent?: string; // live streaming buffer (cleared on commit)
}

// ── Token usage ───────────────────────────────────────────────────────────────

export interface TokenUsageReport {
  totalBudget: number;
  consumed: number;
  remaining: number;
  utilizationPct: number;
  exhausted: boolean;
  perAgent: Array<{ agentId: string; tokens: number }>;
}

// ── System error ──────────────────────────────────────────────────────────────

export interface SystemError {
  id: string;
  timestamp: string;
  category: 'agent' | 'system' | 'validation' | 'permission';
  message: string;
  pillarId?: string;
  agentId?: string;
  recoverable: boolean;
}

// ── Settings (subset stored in state) ────────────────────────────────────────

export interface AtomicSettings {
  artemis: {
    model: string;
    activeSkillIds: string[];
    confidenceThreshold: number;
    breakdownStrategy: 'flat' | 'hierarchical' | 'milestone' | 'component';
    tone: 'technical' | 'business' | 'hybrid';
    toolAccess: Record<string, boolean>;
  };
  curator: {
    model: string;
    activeSkillIds: string[];
    refinementDepth: 'surface' | 'deep' | 'comprehensive';
    editConfirmationMode: 'always-confirm' | 'auto-apply' | 'preview-first';
    trustedDomains: string[];
    sourceRecencyMonths: number;
    toolAccess: Record<string, boolean>;
  };
  general: {
    model: string;
    activeSkillIds: string[];
    toolAccess: Record<string, boolean>;
  };
  pipeline: {
    globalModel: string;
    pillarModelOverrides: Record<string, string>;
    maxParallelSubAgents: number;
    defaultFailureStrategy: 'retry' | 'skip' | 'block' | 'fallback';
    maxRetries: number;
    retryBackoffMs: number;
  };
  system: {
    trustedDomains: string[];
    developerMode: boolean;
    tokenBudget: number;
    streamingEnabled: boolean;
    versionRetention: 'all' | number;
  };
}

const DEFAULT_SETTINGS: AtomicSettings = {
  artemis: {
    model: 'openai/gpt-5.4',
    activeSkillIds: [],
    confidenceThreshold: 0.75,
    breakdownStrategy: 'hierarchical',
    tone: 'hybrid',
    toolAccess: {},
  },
  curator: {
    model: 'openai/gpt-5.4',
    activeSkillIds: ['security-reviewer', 'strict-typescript'],
    refinementDepth: 'deep',
    editConfirmationMode: 'always-confirm',
    trustedDomains: [
      'docs.anthropic.com', 'openai.com', 'developer.mozilla.org',
      'typescript-lang.org', 'nodejs.org', 'react.dev', 'vitejs.dev',
      'expressjs.com', 'sqlite.org', 'redis.io', 'postgresql.org',
      'github.com', 'npmjs.com', 'cve.mitre.org', 'owasp.org',
      'nist.gov', 'rfc-editor.org', 'w3.org', 'ecma-international.org',
    ],
    sourceRecencyMonths: 18,
    toolAccess: {},
  },
  general: {
    model: 'openai/gpt-5.3-chat',
    activeSkillIds: [],
    toolAccess: {},
  },
  pipeline: {
    globalModel: 'openai/gpt-5.4',
    pillarModelOverrides: {},
    maxParallelSubAgents: 5,
    defaultFailureStrategy: 'retry',
    maxRetries: 3,
    retryBackoffMs: 1000,
  },
  system: {
    trustedDomains: [],
    developerMode: false,
    tokenBudget: 500_000,
    streamingEnabled: true,
    versionRetention: 'all',
  },
};

// ── Atomic System State ───────────────────────────────────────────────────────

export interface AtomicSystemState {
  sessionId: string;
  projectId: string;
  phase: 'scoping' | 'pipeline' | 'refinement' | 'complete';
  traceId: string;

  workspaces: {
    artemis: ArtemisWorkspaceSummary | null;
    pipeline: PipelineWorkspaceSummary | null;
    curator: CuratorWorkspaceSummary | null;
    pillars: Record<string, PillarWorkspaceSummary>;
  };

  chat: {
    mode: ChatMode;
    artemisThread: SystemMessage[];
    curatorThread: SystemMessage[];
    generalThread: SystemMessage[];
  };

  pillarStatuses: Record<string, PillarStatus>;

  blueprintId: string | null;
  blueprintVersions: number[];
  currentBlueprintVersion: number;

  tokenUsage: TokenUsageReport;
  settings: AtomicSettings;
  errors: SystemError[];
  lastUpdated: string;
}

// ── In-memory state store ────────────────────────────────────────────────────

const MAX_SESSIONS = 50;
const stateMap = new Map<string, AtomicSystemState>();
const lruOrder: string[] = [];

function touchSession(sessionId: string): void {
  const idx = lruOrder.indexOf(sessionId);
  if (idx !== -1) lruOrder.splice(idx, 1);
  lruOrder.push(sessionId);
}

function evictIfNeeded(): void {
  while (stateMap.size >= MAX_SESSIONS) {
    const oldest = lruOrder.shift();
    if (oldest) stateMap.delete(oldest);
  }
}

// ── State manager ─────────────────────────────────────────────────────────────

export class AtomicStateManager {
  /**
   * Create a new session state. Returns the new state.
   */
  static create(sessionId: string, projectId: string, settingsOverride?: Partial<AtomicSettings>): AtomicSystemState {
    evictIfNeeded();

    const state: AtomicSystemState = {
      sessionId,
      projectId,
      phase: 'scoping',
      traceId: randomUUID(),

      workspaces: {
        artemis: null,
        pipeline: null,
        curator: null,
        pillars: {},
      },

      chat: {
        mode: 'artemis',
        artemisThread: [],
        curatorThread: [],
        generalThread: [],
      },

      pillarStatuses: {},

      blueprintId: null,
      blueprintVersions: [],
      currentBlueprintVersion: 0,

      tokenUsage: {
        totalBudget: DEFAULT_SETTINGS.system.tokenBudget,
        consumed: 0,
        remaining: DEFAULT_SETTINGS.system.tokenBudget,
        utilizationPct: 0,
        exhausted: false,
        perAgent: [],
      },

      settings: {
        ...DEFAULT_SETTINGS,
        ...settingsOverride,
      },

      errors: [],
      lastUpdated: new Date().toISOString(),
    };

    stateMap.set(sessionId, state);
    touchSession(sessionId);

    publishEvent('session.created', sessionId, state.traceId, { projectId });

    return state;
  }

  /**
   * Get session state. Returns null if not found.
   */
  static get(sessionId: string): AtomicSystemState | null {
    const state = stateMap.get(sessionId);
    if (state) touchSession(sessionId);
    return state ?? null;
  }

  /**
   * Update pillar status and emit event.
   */
  static setPillarStatus(
    sessionId: string,
    pillarId: string,
    status: PillarStatus,
    traceId: string,
  ): void {
    const state = stateMap.get(sessionId);
    if (!state) return;

    const prev = state.pillarStatuses[pillarId];
    state.pillarStatuses[pillarId] = status;
    state.lastUpdated = new Date().toISOString();

    // Map status to event type
    const eventMap: Partial<Record<PillarStatus, string>> = {
      queued: 'pillar.queued',
      running: 'pillar.started',
      complete: 'pillar.completed',
      failed: 'pillar.failed',
      retrying: 'pillar.retrying',
      improving: 'pillar.improving',
      skipped: 'pillar.skipped',
    };

    const eventType = eventMap[status];
    if (eventType) {
      publishEvent(
        eventType as Parameters<typeof publishEvent>[0],
        sessionId,
        traceId,
        { pillarId, previousStatus: prev, newStatus: status },
      );
    }
  }

  /**
   * Update live streaming content for a pillar workspace.
   */
  static updatePillarStream(sessionId: string, pillarId: string, chunk: string): void {
    const state = stateMap.get(sessionId);
    if (!state) return;

    if (!state.workspaces.pillars[pillarId]) {
      state.workspaces.pillars[pillarId] = {
        pillarId,
        status: 'running',
        agentCount: 0,
        lastUpdated: new Date().toISOString(),
        streamingContent: '',
      };
    }

    const ws = state.workspaces.pillars[pillarId]!;
    ws.streamingContent = (ws.streamingContent ?? '') + chunk;
    // Cap streaming buffer at 50KB
    if ((ws.streamingContent?.length ?? 0) > 50_000) {
      ws.streamingContent = ws.streamingContent!.slice(-50_000);
    }
  }

  /**
   * Commit pillar workspace (clears streaming buffer, sets status to complete).
   */
  static commitPillarWorkspace(
    sessionId: string,
    pillarId: string,
    agentCount: number,
    qualityScore?: number,
  ): void {
    const state = stateMap.get(sessionId);
    if (!state) return;

    state.workspaces.pillars[pillarId] = {
      pillarId,
      status: 'complete',
      agentCount,
      qualityScore,
      lastUpdated: new Date().toISOString(),
      streamingContent: undefined, // cleared on commit
    };

    // Update pipeline workspace summary
    const total = Object.keys(state.pillarStatuses).length;
    const completed = Object.values(state.pillarStatuses).filter(s => s === 'complete').length;
    state.workspaces.pipeline = {
      totalPillars: total,
      completedPillars: completed,
      failedPillars: Object.values(state.pillarStatuses).filter(s => s === 'failed').length,
      overallProgress: total > 0 ? completed / total : 0,
      lastUpdated: new Date().toISOString(),
    };

    state.lastUpdated = new Date().toISOString();
  }

  /**
   * Set the system phase and emit event.
   */
  static setPhase(sessionId: string, phase: AtomicSystemState['phase'], traceId: string): void {
    const state = stateMap.get(sessionId);
    if (!state) return;
    state.phase = phase;
    state.lastUpdated = new Date().toISOString();
    publishEvent('pipeline.started', sessionId, traceId, { phase });
  }

  /**
   * Add a message to a chat thread.
   */
  static addMessage(
    sessionId: string,
    thread: ChatMode,
    role: 'user' | 'assistant',
    content: string,
  ): SystemMessage {
    const state = stateMap.get(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);

    const message: SystemMessage = {
      id: randomUUID(),
      role,
      content,
      timestamp: new Date().toISOString(),
    };

    const threadKey = `${thread}Thread` as 'artemisThread' | 'curatorThread' | 'generalThread';
    state.chat[threadKey].push(message);

    // Cap thread length at 200 messages
    if (state.chat[threadKey].length > 200) {
      state.chat[threadKey] = state.chat[threadKey].slice(-200);
    }

    state.lastUpdated = new Date().toISOString();
    return message;
  }

  /**
   * Record an error.
   */
  static addError(sessionId: string, error: Omit<SystemError, 'id' | 'timestamp'>): void {
    const state = stateMap.get(sessionId);
    if (!state) return;

    const entry: SystemError = {
      ...error,
      id: randomUUID(),
      timestamp: new Date().toISOString(),
    };

    state.errors.push(entry);
    // Cap errors at 100
    if (state.errors.length > 100) state.errors = state.errors.slice(-100);

    publishEvent('error.system', sessionId, state.traceId, entry);
    state.lastUpdated = new Date().toISOString();
  }

  /**
   * Update token usage from the token budget manager report.
   */
  static updateTokenUsage(sessionId: string, report: TokenUsageReport): void {
    const state = stateMap.get(sessionId);
    if (!state) return;
    state.tokenUsage = report;
    state.lastUpdated = new Date().toISOString();
  }

  /**
   * Set blueprint info on the state.
   */
  static setBlueprintId(sessionId: string, blueprintId: string, version: number): void {
    const state = stateMap.get(sessionId);
    if (!state) return;
    state.blueprintId = blueprintId;
    state.currentBlueprintVersion = version;
    if (!state.blueprintVersions.includes(version)) {
      state.blueprintVersions.push(version);
      state.blueprintVersions.sort((a, b) => a - b);
    }
    state.lastUpdated = new Date().toISOString();
  }

  /**
   * Tear down session state. Called when session ends or project switches.
   */
  static destroy(sessionId: string): void {
    stateMap.delete(sessionId);
    const idx = lruOrder.indexOf(sessionId);
    if (idx !== -1) lruOrder.splice(idx, 1);
  }

  /**
   * Get a serializable snapshot of the state (safe for SSE / JSON serialization).
   */
  static snapshot(sessionId: string): AtomicSystemState | null {
    return stateMap.get(sessionId) ?? null;
  }

  static get DEFAULT_SETTINGS(): AtomicSettings {
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AtomicSettings;
  }
}
