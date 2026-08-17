/**
 * @module @atomic/sdk
 *
 * Atomic TypeScript SDK — programmatic access to the Atomic multi-agent AI blueprint generator.
 *
 * @example Basic usage
 * ```typescript
 * import { AtomicClient } from '@atomic/sdk';
 *
 * const client = new AtomicClient({
 *   baseUrl: 'http://localhost:5000',
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
 * // Chat with Artemis to scope a new project
 * const session = await client.artemis.createSession();
 * const { content, workspace } = await client.artemis.chat({
 *   sessionId: session.sessionId,
 *   message:   "I'm building a B2B fintech platform",
 *   onChunk:   chunk => process.stdout.write(chunk),
 * });
 * console.log('Confidence:', workspace.confidenceScore);
 *
 * // Version history
 * const versions = await client.versions.list(blueprint.id);
 * console.log(`${versions.length} versions`);
 *
 * // Skills
 * const skills = await client.skills.list();
 * const customSkill = await client.skills.create({
 *   name:                 'GraphQL Expert',
 *   description:          'Enforces GraphQL best practices in all output',
 *   systemPromptAddition: 'Always prefer GraphQL for API design.',
 * });
 * ```
 */

// ── Primary exports ───────────────────────────────────────────────────────────

export { AtomicClient } from './client';
export { AtomicError, AtomicRateLimitError, AtomicAuthError } from './types';

// ── Resource exports ──────────────────────────────────────────────────────────

export type { Blueprints }      from './resources/blueprints';
export type { ArtemisResource } from './resources/artemis';
export type { CuratorResource } from './resources/curator';
export type { SkillsResource }  from './resources/skills';
export type { VersionsResource } from './resources/versions';
export type { ChatResource }    from './resources/chat';

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
  BlueprintListResponse,
  BlueprintPillar,
  BlueprintAgent,
  GenerateOptions,
  GenerateResult,
  GenerationEvent,

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
} from './types';
