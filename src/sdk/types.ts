/**
 * src/sdk/types.ts
 *
 * Shared TypeScript types for the Atomic SDK.
 * These mirror the server-side types exactly so consumers get full type safety
 * without importing server-side modules.
 *
 * @module @atomic/sdk/types
 */

// ── SDK metadata ──────────────────────────────────────────────────────────────

export const SDK_VERSION = '2.5.0';
export const SDK_USER_AGENT = `atomic-sdk-ts/${SDK_VERSION}`;

// ── Config ────────────────────────────────────────────────────────────────────

export interface AtomicClientConfig {
  /** Base URL of your running Atomic server (default: http://localhost:3000) */
  baseUrl?: string;
  /** Optional API key for authenticated endpoints */
  apiKey?: string;
  /** Request timeout in milliseconds (default: 120_000) */
  timeout?: number;
  /** Custom fetch implementation (for Node < 18 or testing) */
  fetch?: typeof globalThis.fetch;
  /** Maximum retry attempts for retriable failures (default: 3) */
  maxRetries?: number;
  /** Base backoff delay in ms for retries (default: 500) */
  retryBaseDelayMs?: number;
  /** Multi-tenant workspace id sent as X-Workspace-Id (default: 'default') */
  workspaceId?: string;
  /** Extra headers merged into every request (e.g. custom auth) */
  headers?: Record<string, string>;
  /** Custom User-Agent (default: atomic-sdk-ts/VERSION) */
  userAgent?: string;
}

export type GenerationMode = 'fast' | 'safe';
export type PipelineType = 'blueprint' | 'feature-creator' | 'tool-builder' | 'agent-builder';

// ── Errors ────────────────────────────────────────────────────────────────────

/**
 * Base error for all Atomic SDK failures. Instances carry the HTTP status code,
 * a human-readable message, optional structured details, and an optional cause
 * for chaining underlying network failures.
 */
export class AtomicError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AtomicError';
  }
}

export class AtomicAuthError extends AtomicError {
  constructor(message = 'Authentication required or API key invalid', cause?: unknown) {
    super(401, message, undefined, cause);
    this.name = 'AtomicAuthError';
  }
}

export class AtomicForbiddenError extends AtomicError {
  constructor(message = 'Insufficient permissions for this operation', cause?: unknown) {
    super(403, message, undefined, cause);
    this.name = 'AtomicForbiddenError';
  }
}

export class AtomicNotFoundError extends AtomicError {
  constructor(message = 'Resource not found', cause?: unknown) {
    super(404, message, undefined, cause);
    this.name = 'AtomicNotFoundError';
  }
}

export class AtomicConflictError extends AtomicError {
  constructor(message = 'Resource conflict (e.g. idempotency key collision)', cause?: unknown) {
    super(409, message, undefined, cause);
    this.name = 'AtomicConflictError';
  }
}

export class AtomicValidationError extends AtomicError {
  constructor(message = 'Request validation failed', details?: unknown, cause?: unknown) {
    super(422, message, details, cause);
    this.name = 'AtomicValidationError';
  }
}

export class AtomicRateLimitError extends AtomicError {
  constructor(public readonly retryAfterMs?: number) {
    super(429, 'Rate limit exceeded');
    this.name = 'AtomicRateLimitError';
  }
}

export class AtomicServerError extends AtomicError {
  constructor(message = 'Atomic server error', cause?: unknown) {
    super(500, message, undefined, cause);
    this.name = 'AtomicServerError';
  }
}

export class AtomicTimeoutError extends AtomicError {
  constructor(message = 'Request timed out', cause?: unknown) {
    super(408, message, undefined, cause);
    this.name = 'AtomicTimeoutError';
  }
}

/** Thrown when all retry attempts are exhausted for a retriable failure. */
export class AtomicRetryExhaustedError extends AtomicError {
  constructor(
    public readonly attempts: number,
    public readonly lastError: AtomicError,
  ) {
    super(lastError.statusCode, `Retry exhausted after ${attempts} attempts: ${lastError.message}`, lastError.details, lastError.cause);
    this.name = 'AtomicRetryExhaustedError';
  }
}

/** Thrown when SSE stream parsing fails unrecoverably. */
export class AtomicStreamError extends AtomicError {
  constructor(message: string, cause?: unknown) {
    super(500, message, undefined, cause);
    this.name = 'AtomicStreamError';
  }
}

/**
 * Maps an HTTP response status to the matching AtomicError subclass so callers
 * can narrow on the class rather than the status code.
 */
export function atomicErrorFromResponse(status: number, message: string, details?: unknown, cause?: unknown): AtomicError {
  switch (status) {
    case 401: return new AtomicAuthError(message, cause);
    case 403: return new AtomicForbiddenError(message, cause);
    case 404: return new AtomicNotFoundError(message, cause);
    case 408: return new AtomicTimeoutError(message, cause);
    case 409: return new AtomicConflictError(message, cause);
    case 422: return new AtomicValidationError(message, details, cause);
    case 429: return new AtomicRateLimitError();
    default:
      return status >= 500 ? new AtomicServerError(message, cause) : new AtomicError(status, message, details, cause);
  }
}

// ── Blueprint ─────────────────────────────────────────────────────────────────

export interface Blueprint {
  id:            string;
  prompt:        string;
  mode:          GenerationMode;
  quality_score: number;
  created_at:    string;
  updated_at?:   string;
  intent?:       { product_name?: string; [key: string]: unknown };
  sections:      Record<string, string>;
  pillars:       Record<string, BlueprintPillar>;
  session_id?:   string;
  rating?:       number | null;
}

export interface BlueprintPillar {
  name:           string;
  agents:         BlueprintAgent[];
  failed_agents?: string[];
  [key: string]:  unknown;
}

export interface BlueprintAgent {
  agent:   string;
  content: string;
  status?: string;
  [key: string]: unknown;
}

export interface BlueprintSummary {
  id:            string;
  prompt:        string;
  mode:          GenerationMode;
  quality_score: number;
  created_at:    string;
  rating?:       number | null;
  tags?:         string[];
}

export interface BlueprintListOptions {
  /** 1-based page index used for cursor-style paging (server uses offset: (page-1)*pageSize) */
  page?:     number;
  /** Results per page (default: 20, max: 100) — sent as `limit` */
  pageSize?: number;
  /** Full-text search query — sent as `search` */
  search?:   string;
  /** Filter by tag */
  tag?:      string;
  /** Sort order: 'newest' | 'oldest' | 'quality' */
  sort?:     'newest' | 'oldest' | 'quality';
  /** Date-after ISO string filter */
  dateAfter?: string;
  /** Minimum quality score filter (0–100) — sent as `quality_min` */
  qualityMin?: number;
  /** Descending sort order */
  order?:    'asc' | 'desc';
}

export interface BlueprintListResponse {
  blueprints: BlueprintSummary[];
  total:      number;
  page:       number;
  pageSize:   number;
}

export interface GenerateOptions {
  prompt:       string;
  mode?:        GenerationMode;
  pipelineType?: PipelineType;
  modelConfig?: {
    provider?:  string;
    fastModel?: string;
    proModel?:  string;
    apiKey?:    string;
  };
  onProgress?: (event: GenerationEvent) => void;
}

export interface GenerationEvent {
  type:       string;
  pillar?:    string;
  agent?:     string;
  message?:   string;
  progress?:  number;
  [key: string]: unknown;
}

export interface GenerateResult {
  sessionId: string;
  blueprint: Blueprint;
}

// ── Async generation (generate-async + run polling) ───────────────────────────

export interface GenerateAsyncOptions {
  prompt: string;
  mode?:  GenerationMode;
  pipelineType?: PipelineType;
  modelConfig?: {
    provider?:  string;
    fastModel?: string;
    proModel?:  string;
    apiKey?:    string;
  };
}

export interface GenerateAsyncResult {
  runId: string;
}

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'aborted';

export interface RunInfo {
  runId:       string;
  status:      RunStatus;
  sessionId?:  string;
  error?:      string;
  progress?:   number;
  started_at?: string;
  [key: string]: unknown;
}

// ── Sessions (plan/steer/snapshots/undo/elicitation/permissions) ──────────────

export interface SessionPlan {
  steps:        PlanStep[];
  createdAt:    string;
  [key: string]: unknown;
}

export interface PlanStep {
  id:          string;
  description: string;
  status?:     string;
  [key: string]: unknown;
}

export interface SteerOptions {
  instruction: string;
  targetPillar?: string;
}

export interface SteerResult {
  accepted:  boolean;
  steerId?:  string;
  [key: string]: unknown;
}

export interface Snapshot {
  id:        string;
  timestamp: string;
  label?:    string;
  [key: string]: unknown;
}

export interface UndoResult {
  undone:     boolean;
  blueprint?: Blueprint;
  [key: string]: unknown;
}

export interface Elicitation {
  id:            string;
  question:      string;
  options?:      string[];
  answered?:     boolean;
  [key: string]: unknown;
}

export interface Permission {
  name:        string;
  granted:     boolean;
  [key: string]: unknown;
}

// ── Artemis ───────────────────────────────────────────────────────────────────

export interface ArtemisSession {
  sessionId:  string;
  workspace:  ArtemisWorkspace;
}

export interface ArtemisWorkspace {
  sessionId:       string;
  brief:           ProjectBrief | null;
  confidenceScore: number;
  approved:        boolean;
  thread:          ChatMessage[];
  updatedAt:       string;
}

export interface ProjectBrief {
  projectName:     string;
  description:     string;
  problemStatement?: string;
  targetUsers:     string[];
  techStack?:      Record<string, string[]>;
  constraints?:    Record<string, unknown>;
  successCriteria: string[];
  outOfScope:      string[];
  openQuestions:   string[];
  confidenceScore: number;
  completedAt:     string;
  artemisSessionId: string;
}

export interface ArtemisChatOptions {
  sessionId:          string;
  message:            string;
  activeSkillIds?:    string[];
  confidenceThreshold?: number;
  onChunk?:           (chunk: string) => void;
}

export interface ArtemisChatResult {
  content:   string;
  workspace: ArtemisWorkspace;
}

// ── Curator ───────────────────────────────────────────────────────────────────

export interface CuratorSession {
  sessionId:  string;
  workspace:  CuratorWorkspace;
}

export interface CuratorWorkspace {
  sessionId:    string;
  blueprintId:  string;
  report:       RefinementReport | null;
  appliedEdits: ProposedEdit[];
  status:       'idle' | 'analyzing' | 'ready' | 'applying';
  updatedAt:    string;
}

export interface RefinementReport {
  overallScore:  QualityScore;
  dimensions:    Record<string, DimensionScore>;
  findings:      Finding[];
  generatedAt:   string;
  modelUsed:     string;
  [key: string]: unknown;
}

export interface QualityScore {
  value:   number;
  label:   string;
  summary: string;
}

export interface DimensionScore {
  score:       number;
  summary:     string;
  keyFindings: string[];
}

export interface Finding {
  id:             string;
  severity:       'critical' | 'warning' | 'suggestion';
  pillarId?:      string;
  description:    string;
  impact:         string;
  recommendation: string;
  source?:        { url: string; name: string };
}

export interface ProposedEdit {
  id:          string;
  title:       string;
  description: string;
  fieldPath:   string;
  newValue:    string;
  rationale:   string;
  findingId?:  string;
  appliedAt?:  string;
}

export interface CuratorChatOptions {
  sessionId:       string;
  message:         string;
  blueprint?:      Blueprint;
  activeSkillIds?: string[];
  onChunk?:        (chunk: string) => void;
}

export interface CuratorChatResult {
  content:       string;
  proposedEdits: ProposedEdit[];
}

// ── Version History ───────────────────────────────────────────────────────────

export type VersionAuthor     = 'curator' | 'pipeline' | 'user' | 'pillar_subagent';
export type VersionChangeType = 'full' | 'pillar' | 'checkpoint' | 'restore';

export interface BlueprintVersion {
  id:              string;
  blueprintId:     string;
  versionNumber:   number;
  parentVersion:   number | null;
  timestamp:       string;
  author:          VersionAuthor;
  authorDetail:    string;
  changeSummary:   string;
  changeType:      VersionChangeType;
  affectedPillars: string[];
  diff:            BlueprintDiff;
  integrityHash:   string;
}

export interface BlueprintDiff {
  added:     { path: string; after?: string }[];
  removed:   { path: string; before?: string }[];
  modified:  { path: string; before?: string; after?: string }[];
  unchanged: number;
}

export interface RestoreVersionResult {
  newVersionNumber: number;
  blueprint:        Blueprint;
  restoredFrom:     number;
}

export interface IntegrityResult {
  valid:     boolean;
  expected:  string;
  computed:  string;
  versionNumber: number;
}

// ── Skills ────────────────────────────────────────────────────────────────────

export interface Skill {
  id:                   string;
  name:                 string;
  description:          string;
  category:             string;
  isBuiltIn:            boolean;
  enabled:              boolean;
  systemPromptAddition: string;
  pillarFilter?:        string[];
  createdAt?:           string;
}

export interface CreateSkillInput {
  name:                 string;
  description:          string;
  category?:            string;
  systemPromptAddition: string;
  pillarFilter?:        string[];
}

// ── Chat ──────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id:        string;
  role:      'user' | 'assistant' | 'system';
  content:   string;
  timestamp: string;
}

export interface GeneralChatOptions {
  message:     string;
  blueprintId?: string;
  blueprint?:  Blueprint;
  onChunk?:    (chunk: string) => void;
}

export interface GeneralChatResult {
  content: string;
}

// ── Engine plugins (server-side plugin API) ───────────────────────────────────

export interface PluginInstallInput {
  id:          string;
  pack?:       string;
  source?:     string;
  manifest?:   Record<string, unknown>;
  trusted?:    boolean;
}

export interface InstalledPlugin {
  id:          string;
  name:        string;
  version?:    string;
  enabled:     boolean;
  trusted?:    boolean;
  digest?:     string;
  [key: string]: unknown;
}

export interface PluginTrustInfo {
  trusted:       boolean;
  trustSource?:  string;
  verifiedAt?:   string;
  [key: string]: unknown;
}

export interface PluginRunOptions {
  hook?:    string;
  payload?: Record<string, unknown>;
}

export interface PluginRunResult {
  success: boolean;
  output?: unknown;
  error?:  string;
  [key: string]: unknown;
}

export interface DoctorReport {
  valid:          boolean;
  errors:         string[];
  warnings:       string[];
  [key: string]:  unknown;
}

// ── Observability ───────────────────────────────────────────────────────────────

export interface TraceEntry {
  id:        string;
  name:      string;
  duration?: number;
  status?:   string;
  [key: string]: unknown;
}

export interface EventEntry {
  id:        string;
  type:      string;
  payload?:  Record<string, unknown>;
  timestamp: string;
  [key: string]: unknown;
}

// ── Pipelines ─────────────────────────────────────────────────────────────────

export interface PipelineConfig {
  name:      string;
  enabled:   boolean;
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface PipelineHealth {
  pipelines: Record<string, { status: string; lastRun?: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface CostEstimate {
  prompt:          string;
  estimatedTokens?: number;
  estimatedCostMicrodollars?: number;
  [key: string]:   unknown;
}
