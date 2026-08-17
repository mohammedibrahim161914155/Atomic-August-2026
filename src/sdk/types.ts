/**
 * src/sdk/types.ts
 *
 * Shared TypeScript types for the Atomic SDK.
 * These mirror the server-side types exactly so consumers get full type safety
 * without importing server-side modules.
 */

// ── Core ───────────────────────────────────────────────────────────────────────

export interface AtomicClientConfig {
  /** Base URL of your running Atomic server (default: http://localhost:5000) */
  baseUrl?:    string;
  /** Optional API key for authenticated endpoints */
  apiKey?:     string;
  /** Request timeout in milliseconds (default: 120_000) */
  timeout?:    number;
  /** Custom fetch implementation (for Node < 18 or testing) */
  fetch?:      typeof globalThis.fetch;
}

export type GenerationMode = 'fast' | 'safe';
export type PipelineType   = 'blueprint' | 'feature-creator' | 'debug-analyzer' | 'refactor-planner';

// ── Blueprint ──────────────────────────────────────────────────────────────────

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

// ── Artemis ────────────────────────────────────────────────────────────────────

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

// ── Curator ────────────────────────────────────────────────────────────────────

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
  blueprint:       Blueprint;
  activeSkillIds?: string[];
  onChunk?:        (chunk: string) => void;
}

export interface CuratorChatResult {
  content:       string;
  proposedEdits: ProposedEdit[];
}

// ── Version History ────────────────────────────────────────────────────────────

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

// ── Skills ─────────────────────────────────────────────────────────────────────

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

// ── Chat ───────────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id:        string;
  role:      'user' | 'assistant' | 'system';
  content:   string;
  timestamp: string;
}

export interface GeneralChatOptions {
  message:     string;
  blueprint?:  Blueprint;
  onChunk?:    (chunk: string) => void;
}

export interface GeneralChatResult {
  content: string;
}

// ── Errors ─────────────────────────────────────────────────────────────────────

export class AtomicError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AtomicError';
  }
}

export class AtomicRateLimitError extends AtomicError {
  constructor(public readonly retryAfterMs?: number) {
    super(429, 'Rate limit exceeded');
    this.name = 'AtomicRateLimitError';
  }
}

export class AtomicAuthError extends AtomicError {
  constructor() {
    super(401, 'Authentication required or API key invalid');
    this.name = 'AtomicAuthError';
  }
}
