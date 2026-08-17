/**
 * src/sdk/resources/curator.ts
 *
 * Curator resource — post-pipeline refinement agent.
 * The Curator is the only agent that can write to the blueprint.
 */

import type { AtomicHTTP } from '../client';
import type {
  Blueprint, CuratorSession, CuratorWorkspace,
  CuratorChatOptions, CuratorChatResult, ProposedEdit, RefinementReport,
} from '../types';

export class CuratorResource {
  constructor(private readonly http: AtomicHTTP) {}

  /**
   * Create a new Curator session for a given blueprint.
   *
   * @example
   * ```ts
   * const session = await client.curator.createSession(blueprint.id);
   * const result = await client.curator.chat({
   *   sessionId:  session.sessionId,
   *   message:    'Analyse the security model',
   *   blueprint,
   *   onChunk:    chunk => process.stdout.write(chunk),
   * });
   * ```
   */
  async createSession(blueprintId: string, config?: Record<string, unknown>): Promise<CuratorSession> {
    return this.http.request<CuratorSession>('/curator/session', {
      method: 'POST',
      body:   { blueprintId, config },
    });
  }

  /** Get the current Curator workspace for a session */
  async getWorkspace(sessionId: string): Promise<CuratorWorkspace> {
    const res = await this.http.request<{ workspace: CuratorWorkspace }>(
      `/curator/${sessionId}/workspace`,
    );
    return res.workspace;
  }

  /**
   * Send a message to the Curator and stream the response.
   * Any edits the Curator proposes are returned in `proposedEdits`.
   */
  async chat(opts: CuratorChatOptions): Promise<CuratorChatResult> {
    const { sessionId: _sessionIdUnused, message, blueprint, activeSkillIds = [], onChunk } = opts;

    let content = '';
    await this.http.stream(
      '/curator/chat',
      { message, blueprintId: blueprint.id, activeSkillIds },
      chunk => {
        content += chunk;
        onChunk?.(chunk);
      },
    );

    // Return proposed edits from workspace
    const workspace = await this.http.request<{ workspace: CuratorWorkspace }>(
      '/curator/workspace',
    ).catch(() => ({ workspace: null }));

    return {
      content,
      proposedEdits: workspace.workspace?.appliedEdits ?? [],
    };
  }

  /**
   * Generate a full refinement report for a blueprint.
   * This is a long-running operation (may take 30–120s).
   */
  async generateReport(blueprintId: string, depth: 'surface' | 'deep' | 'comprehensive' = 'deep'): Promise<RefinementReport> {
    return this.http.request<RefinementReport>('/curator/report', {
      method: 'POST',
      body:   { blueprintId, depth },
    });
  }

  /**
   * Apply a proposed edit to the blueprint.
   * Creates a new version before applying — never destructive.
   *
   * @returns The updated blueprint
   */
  async applyEdit(editId: string, blueprintId: string): Promise<Blueprint> {
    return this.http.request<Blueprint>('/curator/apply-edit', {
      method: 'POST',
      body:   { editId, blueprintId },
    });
  }

  /**
   * Dismiss (reject) a proposed edit without applying it.
   */
  async dismissEdit(editId: string): Promise<{ dismissed: boolean }> {
    return this.http.request<{ dismissed: boolean }>('/curator/dismiss-edit', {
      method: 'POST',
      body:   { editId },
    });
  }

  /**
   * Run a targeted improvement pass on a single pillar.
   * The Curator sends feedback to the pillar sub-agent and streams the result.
   */
  async improvePillar(opts: {
    blueprintId: string;
    pillarId:    string;
    feedback:    string;
    onChunk?:    (chunk: string) => void;
  }): Promise<{ content: string; pillarId: string }> {
    const { blueprintId, pillarId, feedback, onChunk } = opts;
    let content = '';
    await this.http.stream(
      '/curator/improve-pillar',
      { blueprintId, pillarId, feedback },
      chunk => { content += chunk; onChunk?.(chunk); },
    );
    return { content, pillarId };
  }

  /** Get all proposed edits pending for a session */
  async getPendingEdits(sessionId: string): Promise<ProposedEdit[]> {
    const res = await this.http.request<{ edits: ProposedEdit[] }>(
      `/curator/${sessionId}/edits`,
    );
    return res.edits;
  }
}
