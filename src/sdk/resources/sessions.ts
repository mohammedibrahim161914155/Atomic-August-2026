/**
 * src/sdk/resources/sessions.ts
 *
 * Session control resource — abort, steering, plan inspection, snapshots,
 * undo, elicitation answers, and permission grants.
 * Mirrors the server's /api/v1/sessions endpoints exactly.
 */

import type { AtomicHTTP } from '../client';
import type {
  Blueprint, Elicitation, Permission, SessionPlan, Snapshot, SteerOptions,
  SteerResult, UndoResult,
} from '../types';

export class SessionsResource {
  constructor(private readonly http: AtomicHTTP) {}

  /** Abort a running generation session immediately. */
  async abort(sessionId: string): Promise<{ aborted: boolean }> {
    return this.http.request<{ aborted: boolean }>(`/sessions/${sessionId}/abort`, {
      method: 'POST',
      noRetry: true, // abort should never be replayed
    });
  }

  /** Get the current execution plan for a session. */
  async getPlan(sessionId: string): Promise<SessionPlan> {
    return this.http.request<SessionPlan>(`/sessions/${sessionId}/plan`);
  }

  /** Steer an in-flight session with a new instruction. */
  async steer(sessionId: string, opts: SteerOptions): Promise<SteerResult> {
    return this.http.request<SteerResult>(`/sessions/${sessionId}/steer`, {
      method: 'POST',
      body:   opts,
    });
  }

  /** List applied steers for a session. */
  async listSteers(sessionId: string): Promise<{ steers: unknown[] }> {
    return this.http.request<{ steers: unknown[] }>(`/sessions/${sessionId}/steers`);
  }

  /** List snapshots taken for a session. */
  async listSnapshots(sessionId: string): Promise<{ snapshots: Snapshot[] }> {
    return this.http.request<{ snapshots: Snapshot[] }>(`/sessions/${sessionId}/snapshots`);
  }

  /** Undo the last destructive change in a session. */
  async undo(sessionId: string): Promise<UndoResult> {
    return this.http.request<UndoResult>(`/sessions/${sessionId}/undo`, {
      method: 'POST',
    });
  }

  /** Answer a pending elicitation question for a session. */
  async answerElicitation(sessionId: string, elicitationId: string, answer: string): Promise<{ answered: boolean }> {
    return this.http.request<{ answered: boolean }>(`/sessions/${sessionId}/answer-elicitation`, {
      method: 'POST',
      body:   { elicitationId, answer },
    });
  }

  /** List pending elicitations for a session. */
  async listElicitations(sessionId: string): Promise<{ elicitations: Elicitation[] }> {
    return this.http.request<{ elicitations: Elicitation[] }>(`/sessions/${sessionId}/elicitations`);
  }

  /** List permission grants for a session. */
  async listPermissions(sessionId: string): Promise<{ permissions: Permission[] }> {
    return this.http.request<{ permissions: Permission[] }>(`/sessions/${sessionId}/permissions`);
  }

  /** Grant or revoke a permission for a session. */
  async setPermission(sessionId: string, name: string, granted: boolean): Promise<{ permissions: Permission[] }> {
    return this.http.request<{ permissions: Permission[] }>(`/sessions/${sessionId}/permissions`, {
      method: 'PATCH',
      body:   { permissions: [{ name, granted }] },
    });
  }

  /** Get the quality ledger for a session's pipeline runs. */
  async getQuality(sessionId: string, pipeline: string): Promise<Record<string, unknown>> {
    return this.http.request<Record<string, unknown>>(`/sessions/${sessionId}/quality/${pipeline}`);
  }

  /** List run summaries for a session. */
  async listRuns(sessionId: string): Promise<{ runs: unknown[] }> {
    return this.http.request<{ runs: unknown[] }>(`/sessions/${sessionId}/runs`);
  }

  /** Get the restored blueprint of a session. */
  async getBlueprint(sessionId: string): Promise<Blueprint> {
    return this.http.request<Blueprint>(`/sessions/${sessionId}/blueprint`);
  }

  /** List all sessions visible to the current user. */
  async listMySessions(): Promise<{ sessions: unknown[] }> {
    return this.http.request<{ sessions: unknown[] }>('/my-sessions');
  }
}
