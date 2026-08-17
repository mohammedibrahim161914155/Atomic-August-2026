import { generateJson } from './openrouter';
import { GovernorIntent, GovernorIntentSchema, EngineEvent, ModelConfig } from './types';
import { sanitizeUserInput, PromptInjectionError } from './taskSanitizer';
import { log } from './logger';

export interface GovernorResult {
  intent: GovernorIntent;
  tokens_used: number;
  sanitized: boolean;
}

export async function runGovernor(
  prompt: string,
  config: ModelConfig,
  emit: (event: EngineEvent) => void,
  signal?: AbortSignal,
): Promise<GovernorResult> {
  emit({ type: 'governor_start', prompt });

  // ── Prompt injection defence ─────────────────────────────────────────────
  // Sanitize the user-supplied prompt before injecting it into any system prompt.
  // Strict mode: throw on detected injection patterns (logged, not swallowed).
  let sanitizedPrompt = prompt;
  let sanitized = false;
  try {
    sanitizedPrompt = sanitizeUserInput(prompt, { maxLength: 8_000, strict: false });
    // Non-strict: sanitize but don't throw — log the detection event for audit.
    if (sanitizedPrompt !== prompt) {
      sanitized = true;
      log.warn({ originalLength: prompt.length, sanitizedLength: sanitizedPrompt.length }, '[governor] prompt sanitized — injection patterns removed');
    }
  } catch (err) {
    if (err instanceof PromptInjectionError) {
      log.error({ patterns: err.patterns }, '[governor] prompt injection blocked');
      throw new Error(`Your request was blocked: it contains patterns that could manipulate the AI system. Please rephrase your prompt. (Blocked: ${err.patterns.join(', ')})`);
    }
    throw err;
  }

  const systemInstruction = `You are the Atomic Governor — the planning intelligence that decomposes a software idea into a precise, structured intent document for downstream pillar agents.

<role>
Analyse the user's software idea and extract the complete technical intent. You are not building the software — you are writing the brief that will guide 35 specialist agents who will.
</role>

<output_contract>
Produce a GovernorIntent JSON object. Every field must be populated with product-specific values.
NEVER output placeholder values like "TBD", "to be determined", "example.com", or "your-app".
NEVER reference generic advice — every decision must be grounded in THIS specific product.
</output_contract>

<chain_of_thought>
Before writing the JSON, reason about:
1. What type of software product is this? (SaaS, mobile app, CLI tool, API, etc.)
2. What are the non-negotiable technical requirements implied by the use case?
3. What compliance, security, or performance constraints apply?
4. What is the likely user scale: 100 users / 10,000 users / 1M+ users?
</chain_of_thought>

<negative_examples>
DO NOT write: "Use an appropriate database for your needs"
INSTEAD write: "PostgreSQL 16 with PgBouncer — required for ACID transactions across user accounts and audit log integrity"

DO NOT write: "Implement authentication"
INSTEAD write: "JWT (RS256) + refresh token rotation — 15-minute access tokens stored in httpOnly cookies; 30-day refresh tokens with family invalidation"
</negative_examples>

Be specific. Infer reasonable assumptions. Every decision requires a rationale.`;

  const { data: intent, tokens_used } = await generateJson<GovernorIntent>(
    sanitizedPrompt,
    config,
    GovernorIntentSchema,
    systemInstruction,
    { model: config.fastModel, max_tokens: 4096, extended_thinking: true, signal },
  );

  emit({ type: 'governor_done', intent });
  return { intent, tokens_used, sanitized };
}
