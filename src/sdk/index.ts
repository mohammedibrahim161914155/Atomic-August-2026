/**
 * @module @atomic/sdk
 *
 * Atomic TypeScript SDK — programmatic access to the Atomic multi-agent AI
 * blueprint generator. Embeddable in any app: Replit, Codex, Claude Code,
 * OpenCode, Kilo Code, or your own platform.
 *
 * @example Basic usage
 * ```typescript
 * import { AtomicClient } from '@atomic/sdk';
 *
 * const client = new AtomicClient({
 *   baseUrl: 'http://localhost:3000',
 *   apiKey:  process.env.ATOMIC_API_KEY,
 * });
 *
 * // Generate a blueprint
 * const { blueprint } = await client.blueprints.generate({
 *   prompt: 'A SaaS for managing restaurant inventory with real-time tracking',
 *   mode:   'safe',
 *   onProgress: ev => console.log(`[${ev.type}]`, ev.pillar ?? ''),
 * });
 *
 * console.log('Quality score:', blueprint.quality_score);
 * console.log('App name:',      blueprint.intent?.product_name);
 *
 * // Engine plugins
 * const report = await client.plugins.doctor(manifest);
 * const plugin = await client.plugins.install({ id: 'export-linear', pack: 'export-linear@1.0.0' });
 * await client.plugins.run(plugin.id, { hook: 'export', payload: { blueprintId: blueprint.id } });
 *
 * // Session steering
 * await client.sessions.steer(sessionId, { instruction: 'Prioritize GDPR compliance' });
 *
 * // Pipeline cost estimation (before running anything expensive)
 * const estimate = await client.pipelines.costEstimate(prompt);
 * console.log('Estimated tokens:', estimate.estimatedTokens);
 * ```
 */

// ── Primary exports ───────────────────────────────────────────────────────────

export { AtomicClient, AtomicHTTP, backoffDelay } from './client';
export type { RequestOptions } from './client';
export {
  atomicErrorFromResponse,
  SDK_VERSION,
  SDK_USER_AGENT,
} from './types';

// ── Error classes ─────────────────────────────────────────────────────────────

export {
  AtomicError,
  AtomicAuthError,
  AtomicForbiddenError,
  AtomicNotFoundError,
  AtomicConflictError,
  AtomicValidationError,
  AtomicRateLimitError,
  AtomicServerError,
  AtomicTimeoutError,
  AtomicRetryExhaustedError,
  AtomicStreamError,
} from './types';

// ── Resource exports ──────────────────────────────────────────────────────────

export type { Blueprints }        from './resources/blueprints';
export type { ArtemisResource }   from './resources/artemis';
export type { CuratorResource }   from './resources/curator';
export type { SkillsResource }    from './resources/skills';
export type { VersionsResource }  from './resources/versions';
export type { ChatResource }      from './resources/chat';
export type { PluginsResource }   from './resources/plugins';
export type { SessionsResource }  from './resources/sessions';
export type { PipelinesResource } from './resources/pipelines';
export type { ObservabilityResource } from './resources/observability';

// ── Type exports ──────────────────────────────────────────────────────────────

export type {
  // Config
  AtomicClientConfig,

  // Core
  GenerationMode,
  PipelineType,

  // Blueprint
  Blueprint,
  BlueprintSummary,
  BlueprintListOptions,
  BlueprintListResponse,
  BlueprintPillar,
  BlueprintAgent,
  GenerateOptions,
  GenerateResult,
  GenerationEvent,

  // Async generation
  GenerateAsyncOptions,
  GenerateAsyncResult,
  RunInfo,
  RunStatus,

  // Sessions
  SessionPlan,
  PlanStep,
  SteerOptions,
  SteerResult,
  Snapshot,
  UndoResult,
  Elicitation,
  Permission,

  // Artemis
  ArtemisSession,
  ArtemisWorkspace,
  ArtemisChatOptions,
  ArtemisChatResult,
  ProjectBrief,

  // Curator
  CuratorSession,
  CuratorWorkspace,
  CuratorChatOptions,
  CuratorChatResult,
  RefinementReport,
  QualityScore,
  DimensionScore,
  Finding,
  ProposedEdit,

  // Versions
  BlueprintVersion,
  BlueprintDiff,
  RestoreVersionResult,
  IntegrityResult,
  VersionAuthor,
  VersionChangeType,

  // Skills
  Skill,
  CreateSkillInput,

  // Chat
  ChatMessage,
  GeneralChatOptions,
  GeneralChatResult,

  // Plugins
  PluginInstallInput,
  InstalledPlugin,
  PluginTrustInfo,
  PluginRunOptions,
  PluginRunResult,
  DoctorReport,

  // Pipelines
  PipelineConfig,
  PipelineHealth,
  CostEstimate,

  // Observability
  TraceEntry,
  EventEntry,
} from './types';
