/**
 * src/sdk/resources/curator.ts
 *
 * Curator resource — post-pipeline refinement agent.
 * The Curator is the only agent that can write to the blueprint.
 * Routes follow the real server contract: session-scoped
 * /curator/:sessionId/{chat,analyze,propose-edit,apply-edit,workspace}.
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
    const workspace = await this.http.request<CuratorWorkspace>('/curator/session', {
      method: 'POST',
      body:   { blueprintId, config },
    });
    return { sessionId: workspace.sessionId, workspace };
  }

  /** Get the current Curator workspace for a session */
  async getWorkspace(sessionId: string): Promise<CuratorWorkspace> {
    return this.http.request<CuratorWorkspace>(`/curator/${sessionId}/workspace`);
  }

  /**
   * Send a message to the Curator and stream the response.
   * Any edits the Curator proposes are returned in `proposedEdits`.
   */
  async chat(opts: CuratorChatOptions): Promise<CuratorChatResult> {
    const { sessionId, message, blueprint, activeSkillIds = [], onChunk } = opts;

    const content = await this.http.stream(
      `/curator/${sessionId}/chat`,
      { message, blueprintId: blueprint?.id, blueprint, activeSkillIds },
      chunk => onChunk?.(chunk),
    );

    // Return proposed edits from the (now updated) workspace
    const workspace = await this.getWorkspace(sessionId).catch(() => null);

    return {
      content,
      proposedEdits: workspace?.appliedEdits ?? [],
    };
  }

  /**
   * Run a refinement analysis pass over a blueprint, producing a scored report
   * with findings and proposed edits. Long-running (may take 30–120s).
   */
  async analyze(sessionId: string, opts: { blueprint: Blueprint; activeSkillIds?: string[] }): Promise<CuratorWorkspace> {
    return this.http.request<CuratorWorkspace>(`/curator/${sessionId}/analyze`, {
      method: 'POST',
      body:   opts,
    });
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
   * Propose a refinement edit without applying it.
   */
  async proposeEdit(sessionId: string, opts: {
    findingId?:   string;
    description:  string;
    fieldPath:    string;
    newValue:     string;
    rationale:    string;
  }): Promise<ProposedEdit> {
    return this.http.request<ProposedEdit>(`/curator/${sessionId}/propose-edit`, {
      method: 'POST',
      body:   opts,
    });
  }

  /**
   * Apply a proposed edit to the blueprint.
   * Creates a new version before applying — never destructive.
   *
   * @returns The updated blueprint
   */
  async applyEdit(editId: string, blueprintId: string): Promise<Blueprint> {
    return this.http.request<Blueprint>(`/curator/${blueprintId}/apply-edit`, {
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
    const content = await this.http.stream(
      '/curator/improve-pillar',
      { blueprintId, pillarId, feedback },
      chunk => onChunk?.(chunk),
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

  /** Delete a Curator session. */
  async deleteSession(sessionId: string): Promise<{ deleted: boolean }> {
    return this.http.request<{ deleted: boolean }>(`/curator/${sessionId}`, { method: 'DELETE' });
  }
}
