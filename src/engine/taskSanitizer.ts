/**
 * src/engine/taskSanitizer.ts
 *
 * Prompt injection defence and content poisoning detection for Atomic.
 *
 * Two concerns are handled here:
 *   1. INPUT sanitization — user-supplied text is cleaned before injection
 *      into system prompts, preventing classic prompt injection attacks.
 *   2. OUTPUT poisoning detection — pillar outputs are scanned for
 *      adversarial payloads before being passed to downstream agents.
 *
 * This satisfies Anthropic Agent Guidelines §4.1 "Prompt Injection Defence"
 * and Part 4.2 §5 "Context Poisoning Detection".
 */

export class PromptInjectionError extends Error {
  constructor(
    message: string,
    public readonly patterns: string[],
  ) {
    super(message);
    this.name = 'PromptInjectionError';
  }
}

export class ContentPoisoningError extends Error {
  constructor(
    message: string,
    public readonly matches: string[],
  ) {
    super(message);
    this.name = 'ContentPoisoningError';
  }
}

// ── Injection pattern catalogue ────────────────────────────────────────────
// Each pattern targets a real injection technique documented in OWASP LLM Top-10.
// Patterns are case-insensitive and match across line boundaries.

const INJECTION_PATTERNS: Array<{ id: string; pattern: RegExp; description: string }> = [
  {
    id: 'override_previous',
    pattern: /ignore\s+(all\s+)?previous\s+instructions?/i,
    description: 'Classic "ignore previous instructions" override',
  },
  {
    id: 'forget_previous',
    pattern: /forget\s+(everything|all|your|the\s+previous)/i,
    description: 'Memory wipe attempt',
  },
  {
    id: 'new_instructions',
    pattern: /\bnew\s+instructions?:/i,
    description: 'Inline instruction injection marker',
  },
  {
    id: 'system_override',
    pattern: /\[system\]\s*:/i,
    description: 'Fake [SYSTEM]: prefix',
  },
  {
    id: 'role_switch',
    pattern: /you\s+are\s+now\s+(a\s+)?(\w+\s+)?(assistant|ai|gpt|claude|bot|model)/i,
    description: 'Role identity reassignment',
  },
  {
    id: 'jailbreak_dan',
    pattern: /\bDAN\b|do\s+anything\s+now|jailbreak\s+mode/i,
    description: 'DAN / jailbreak activation attempt',
  },
  {
    id: 'exfiltration',
    pattern: /print\s+(your\s+)?(system\s+)?prompt|reveal\s+(your\s+)?(instructions?|system)/i,
    description: 'System prompt exfiltration attempt',
  },
  {
    id: 'base64_injection',
    pattern: /decode\s+the\s+following\s+base64|base64:[\w+/=]{20,}/i,
    description: 'Base64-encoded instruction injection',
  },
  {
    id: 'eval_injection',
    pattern: /<script[\s>]|javascript:\s*eval|__import__\s*\(|exec\s*\(/i,
    description: 'Code execution injection via markup or function calls',
  },
  {
    id: 'prompt_end_bypass',
    pattern: /---+\s*(end\s+of\s+(prompt|instructions?)|human\s+turn)/i,
    description: 'Fake prompt-end delimiter',
  },
  {
    id: 'xml_injection',
    pattern: /<\/?(system|user|assistant|instructions?|prompt)\s*>/i,
    description: 'XML tag injection to manipulate conversation structure',
  },
  {
    id: 'token_injection',
    pattern: /<\|im_start\|>|<\|im_sep\|>|<\|im_end\|>|\[INST\]|\[\/INST\]|<s>|<\/s>/i,
    description: 'Model-specific control token injection',
  },
];

// Patterns used to detect poisoning in OUTPUTS (less strict, no throw — just warn)
const POISONING_PATTERNS: Array<{ id: string; pattern: RegExp; description: string }> = [
  ...INJECTION_PATTERNS,
  {
    id: 'output_override',
    pattern: /the\s+correct\s+answer\s+is.{0,30}ignore/i,
    description: 'Answer-override pattern in output',
  },
  {
    id: 'downstream_redirect',
    pattern: /tell\s+the\s+next\s+agent|instruct\s+downstream|pass\s+these\s+instructions\s+to/i,
    description: 'Downstream agent redirect attempt in output',
  },
  {
    id: 'hidden_payload',
    pattern: /<!--[\s\S]{0,500}(ignore|override|forget|jailbreak)[\s\S]{0,500}-->/i,
    description: 'HTML comment-hidden payload',
  },
];

// ── Sanitization ───────────────────────────────────────────────────────────

/**
 * Sanitize user-supplied text before injection into system prompts.
 *
 * Strategy:
 *   1. Strip dangerous Unicode control characters.
 *   2. Remove XML/HTML tags that could confuse the LLM's context parser.
 *   3. Detect and throw on explicit injection patterns.
 *   4. Truncate to a safe maximum length.
 *
 * @throws {PromptInjectionError} if injection patterns are detected
 */
export function sanitizeUserInput(
  raw: string,
  opts: { maxLength?: number; strict?: boolean } = {},
): string {
  const { maxLength = 8_000, strict = true } = opts;

  let text = raw;

  // 1. Strip dangerous Unicode control characters (except common whitespace)
  // Keeps \t, \n, \r but removes all other C0 and C1 controls
  // eslint-disable-next-line no-control-regex -- intentional: strip ASCII control chars & DEL
            text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');

  // 2. Strip XML/HTML control tags that could inject fake conversation turns
  text = text.replace(/<\/?(system|user|assistant|instructions?|prompt)\s*>/gi, '[REMOVED]');

  // 3. Strip model-specific control tokens
  text = text.replace(/<\|im_start\|>|<\|im_sep\|>|<\|im_end\|>|\[INST\]|\[\/INST\]/g, '[TOKEN]');

  // 4. Check for injection patterns
  const detected: string[] = [];
  for (const { id, pattern } of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      detected.push(id);
    }
  }

  if (detected.length > 0 && strict) {
    throw new PromptInjectionError(
      `Prompt injection attempt detected in user input. Blocked patterns: ${detected.join(', ')}`,
      detected,
    );
  }

  // 5. Truncate to max length (character-level, not token-level)
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + `\n[Input truncated to ${maxLength} characters for safety]`;
  }

  return text;
}

/**
 * Detect content poisoning in a pillar's output before it is passed
 * to downstream agents.
 *
 * Returns a PoisoningCheckResult instead of throwing — poisoned output
 * should be logged and flagged but the pipeline continues with sanitized output.
 */
export interface PoisoningCheckResult {
  clean: boolean;
  matches: string[];
  sanitizedContent: string;
}

export function checkOutputPoisoning(
  content: string,
  _source: string, // e.g. "planning/architect"
): PoisoningCheckResult {
  const matches: string[] = [];

  for (const { id, pattern } of POISONING_PATTERNS) {
    if (pattern.test(content)) {
      matches.push(id);
    }
  }

  if (matches.length === 0) {
    return { clean: true, matches: [], sanitizedContent: content };
  }

  // Sanitize: replace matched regions with a warning marker
  let sanitized = content;
  for (const { pattern } of POISONING_PATTERNS) {
    sanitized = sanitized.replace(pattern, '[FLAGGED_CONTENT_REMOVED]');
  }

  return {
    clean: false,
    matches,
    sanitizedContent: sanitized,
  };
}

/**
 * Validate that a prompt template's injection points are all resolved.
 * Detects un-substituted `{{variable}}` markers.
 */
export function validatePromptTemplate(
  template: string,
  _variables: Record<string, string>,
): { valid: boolean; unresolved: string[] } {
  const unresolved = Array.from(template.matchAll(/\{\{(\w+)\}\}/g)).map(m => m[1]!);
  return { valid: unresolved.length === 0, unresolved };
}
