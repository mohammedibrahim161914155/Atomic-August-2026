/**
 * src/sdk/resources/chat.ts
 *
 * Chat resource — general-purpose blueprint Q&A (read-only mode).
 */

import type { AtomicHTTP } from '../client';
import type { Blueprint, GeneralChatOptions, GeneralChatResult } from '../types';

export class ChatResource {
  constructor(private readonly http: AtomicHTTP) {}

  /**
   * Ask a question about the blueprint in read-only mode.
   * General mode cannot modify the blueprint — enforced at the data layer.
   *
   * @example
   * ```ts
   * const result = await client.chat.ask({
   *   message:   'Explain the security model to a non-technical stakeholder',
   *   blueprint, // optional — enriches context
   *   onChunk:   chunk => process.stdout.write(chunk),
   * });
   * ```
   */
  async ask(opts: GeneralChatOptions): Promise<GeneralChatResult> {
    const { message, blueprint, onChunk } = opts;
    let content = '';
    await this.http.stream(
      '/chat/general',
      { message, blueprintId: blueprint?.id },
      chunk => { content += chunk; onChunk?.(chunk); },
    );
    return { content };
  }

  /**
   * Generate an explanation of the blueprint targeted at a specific audience.
   *
   * @param blueprintId Target blueprint
   * @param audience    'technical' | 'business' | 'non-technical'
   * @param onChunk     Optional streaming callback
   */
  async explain(
    blueprintId: string,
    audience:    'technical' | 'business' | 'non-technical' = 'technical',
    onChunk?:    (chunk: string) => void,
  ): Promise<string> {
    let content = '';
    await this.http.stream(
      '/chat/explain',
      { blueprintId, audience },
      chunk => { content += chunk; onChunk?.(chunk); },
    );
    return content;
  }

  /**
   * Compare two blueprints and generate a natural-language summary of the differences.
   */
  async compare(
    blueprintIdA: string,
    blueprintIdB: string,
    onChunk?:     (chunk: string) => void,
  ): Promise<{ summary: string; blueprint: Blueprint | null }> {
    let content = '';
    await this.http.stream(
      '/chat/compare',
      { blueprintIdA, blueprintIdB },
      chunk => { content += chunk; onChunk?.(chunk); },
    );
    return { summary: content, blueprint: null };
  }
}
