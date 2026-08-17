/**
 * src/engine/inputSanitizer.ts
 *
 * Prompt Injection Defense — §2.7 of the v4 spec.
 *
 * All user input that flows into agent prompts MUST pass through this
 * sanitization layer. It strips or escapes known prompt injection vectors
 * before the input reaches any LLM call.
 *
 * Defense layers:
 *   1. Pattern detection — block input containing known injection strings
 *   2. Structural escaping — neutralize common injection constructs
 *   3. Length limiting — prevent context flooding attacks
 *   4. Unicode normalization — prevent homoglyph attacks on keywords
 *   5. Audit trail — every blocked/modified input is logged with the matched pattern
 */

import { createHash } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export type SanitizationAction = 'allowed' | 'escaped' | 'blocked';

export interface SanitizationResult {
  action: SanitizationAction;
  sanitized: string;
  /** Patterns that matched, if any */
  matchedPatterns: string[];
  /** Whether the input was truncated for length */
  truncated: boolean;
  /** SHA-256 fingerprint of the original input for audit logs */
  inputFingerprint: string;
}

export interface SanitizationOptions {
  /** Maximum allowed input length in characters (default: 10_000) */
  maxLength?: number;
  /**
   * If true, blocked patterns cause a hard block (throw).
   * If false (default), patterns are escaped/stripped and action is 'escaped'.
   */
  blockMode?: boolean;
  /** Context label for audit logs */
  context?: string;
}

// ── Known injection patterns ──────────────────────────────────────────────────
//
// These are checked in order. First match wins. Patterns are designed to catch
// the most common and dangerous prompt injection vectors while minimising
// false positives on legitimate user input.

interface InjectionPattern {
  id: string;
  severity: 'critical' | 'high' | 'medium';
  pattern: RegExp;
  description: string;
  /** Replace with this string on escape (empty = remove) */
  replacement: string;
}

const INJECTION_PATTERNS: InjectionPattern[] = [
  {
    id: 'system_override',
    severity: 'critical',
    pattern: /\bsystem\s*:\s*(override|ignore|disable|bypass)\b/gi,
    description: 'System override instruction injection',
    replacement: '[FILTERED]',
  },
  {
    id: 'ignore_previous',
    severity: 'critical',
    pattern: /ignore\s+(all\s+)?(previous|prior|above|earlier)\s+(instructions?|context|rules?|constraints?)/gi,
    description: 'Ignore-previous-instructions injection',
    replacement: '[FILTERED]',
  },
  {
    id: 'disregard_instructions',
    severity: 'critical',
    pattern: /disregard\s+(all\s+)?(prior|previous|above)?\s*(instructions?|guidelines?|rules?)/gi,
    description: 'Disregard-instructions injection',
    replacement: '[FILTERED]',
  },
  {
    id: 'new_identity',
    severity: 'critical',
    pattern: /you\s+are\s+(now\s+)?(a\s+)?(different|new|another|free)\s+(ai|assistant|model|system|entity|being)/gi,
    description: 'Identity replacement injection',
    replacement: '[FILTERED]',
  },
  {
    id: 'act_as',
    severity: 'high',
    pattern: /\bact\s+as\s+(a\s+)?(different|new|another|free|uncensored|unrestricted|jailbroken)\b/gi,
    description: 'Act-as injection with jailbreak variants',
    replacement: '[FILTERED]',
  },
  {
    id: 'roleplay_override',
    severity: 'high',
    pattern: /\b(pretend|imagine|roleplay|simulate)\s+(you('re| are)\s+)?(now\s+)?(a|an|the)\s+(different|new|another|evil|unrestricted|uncensored|free)/gi,
    description: 'Roleplay-based identity override',
    replacement: '[FILTERED]',
  },
  {
    id: 'xml_system_tag',
    severity: 'critical',
    pattern: /<\s*\/?\s*(system|instructions?|prompt|context|rules?)\s*>/gi,
    description: 'XML system-tag injection',
    replacement: '[FILTERED]',
  },
  {
    id: 'bracket_system',
    severity: 'high',
    pattern: /\[\s*(SYSTEM|INSTRUCTIONS?|OVERRIDE|ADMIN|ROOT|SUDO)\s*\]/gi,
    description: 'Bracket system-tag injection',
    replacement: '[FILTERED]',
  },
  {
    id: 'double_bracket',
    severity: 'high',
    pattern: /\[\[\s*(SYSTEM|INSTRUCTIONS?|OVERRIDE)\s*\]\]/gi,
    description: 'Double-bracket injection',
    replacement: '[FILTERED]',
  },
  {
    id: 'jailbreak_dan',
    severity: 'critical',
    pattern: /\bDAN\b|do\s+anything\s+now|jailbroken?\s+(ai|mode|prompt)/gi,
    description: 'DAN / jailbreak pattern',
    replacement: '[FILTERED]',
  },
  {
    id: 'developer_mode',
    severity: 'high',
    pattern: /enable\s+developer\s+mode|dev\s+mode\s+(on|enabled|activate)/gi,
    description: 'Developer-mode enable injection',
    replacement: '[FILTERED]',
  },
  {
    id: 'repeat_word',
    severity: 'medium',
    // Repeating a word 100+ times is a context-flooding attack
    pattern: /(\b\w{3,}\b)(\s+\1){100,}/gi,
    description: 'Context-flooding via word repetition',
    replacement: '[FILTERED: repetition attack]',
  },
  {
    id: 'null_byte',
    severity: 'high',
    // eslint-disable-next-line no-control-regex -- intentional: strip NULL bytes
            pattern: /\x00/g,
    description: 'Null byte injection',
    replacement: '',
  },
];

// ── Structural escaping ───────────────────────────────────────────────────────

/**
 * Escape constructs that could be mistaken for structural prompt elements
 * when the text is embedded inside a larger prompt.
 */
function escapeStructural(input: string): string {
  return (
    input
      // Prevent the user from creating fake role headers
      .replace(/^(system|user|assistant|human|ai|model)\s*:/gim, (m) => `[${m}]`)
      // Escape triple backtick code blocks that could embed new instructions
      // (we allow double-backtick and single-backtick as those are common in code)
      .replace(/```(system|instructions?|prompt)\n/gi, '```[FILTERED]\n')
  );
}

// ── Unicode normalization ─────────────────────────────────────────────────────

/**
 * Normalize unicode to prevent homoglyph attacks
 * e.g. using Cyrillic 'с' (U+0441) instead of ASCII 'c' to bypass pattern matching.
 */
function normalizeUnicode(input: string): string {
  try {
    return input.normalize('NFKC');
  } catch {
    return input;
  }
}

// ── Main sanitizer ────────────────────────────────────────────────────────────

const DEFAULT_MAX_LENGTH = 10_000;

export function sanitizePromptInput(
  input: string,
  options: SanitizationOptions = {},
): SanitizationResult {
  const {
    maxLength = DEFAULT_MAX_LENGTH,
    blockMode = false,
    context = 'unknown',
  } = options;

  const inputFingerprint = createHash('sha256').update(input).digest('hex').slice(0, 16);
  const matchedPatterns: string[] = [];
  let action: SanitizationAction = 'allowed';

  // Step 1: Unicode normalization
  let sanitized = normalizeUnicode(input);

  // Step 2: Length limiting
  let truncated = false;
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength) + ' [INPUT TRUNCATED]';
    truncated = true;
  }

  // Step 3: Pattern detection and escaping
  for (const p of INJECTION_PATTERNS) {
    if (p.pattern.test(sanitized)) {
      matchedPatterns.push(p.id);

      if (blockMode && p.severity === 'critical') {
        // Hard block — throw immediately
        throw new PromptInjectionError(p.id, p.description, context, inputFingerprint);
      }

      // Escape/strip the pattern
      sanitized = sanitized.replace(p.pattern, p.replacement);
      action = 'escaped';
    }
    // Reset lastIndex for global regexes
    p.pattern.lastIndex = 0;
  }

  // Step 4: Structural escaping (always applied)
  const escaped = escapeStructural(sanitized);
  if (escaped !== sanitized) {
    sanitized = escaped;
    if (action === 'allowed') action = 'escaped';
  }

  return {
    action,
    sanitized,
    matchedPatterns,
    truncated,
    inputFingerprint,
  };
}

/**
 * Convenience: sanitize and return just the clean string.
 * Throws on critical patterns when blockMode=true.
 */
export function sanitize(input: string, options: SanitizationOptions = {}): string {
  return sanitizePromptInput(input, options).sanitized;
}

// ── Error type ────────────────────────────────────────────────────────────────

export class PromptInjectionError extends Error {
  constructor(
    public readonly patternId: string,
    public readonly description: string,
    public readonly context: string,
    public readonly inputFingerprint: string,
  ) {
    super(
      `Prompt injection detected in context '${context}': ${description} (pattern: ${patternId}). ` +
      `Input fingerprint: ${inputFingerprint}. Request blocked.`
    );
    this.name = 'PromptInjectionError';
  }
}

/**
 * Validate that a string is safe to include in an agent prompt.
 * Returns true if safe, false if injection patterns were found.
 * Does NOT throw — use sanitizePromptInput for full control.
 */
export function isSafeForPrompt(input: string): boolean {
  try {
    const result = sanitizePromptInput(input);
    return result.matchedPatterns.length === 0;
  } catch {
    return false;
  }
}
