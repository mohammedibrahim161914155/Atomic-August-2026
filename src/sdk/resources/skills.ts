/**
 * src/sdk/resources/skills.ts
 *
 * Skills resource — manage built-in and custom skills.
 */

import type { AtomicHTTP } from '../client';
import type { Skill, CreateSkillInput } from '../types';

export class SkillsResource {
  constructor(private readonly http: AtomicHTTP) {}

  /** List all skills (built-in + custom) */
  async list(): Promise<Skill[]> {
    const res = await this.http.request<{ skills: Skill[] }>('/skills');
    return res.skills;
  }

  /** Get a single skill by ID */
  async get(id: string): Promise<Skill> {
    return this.http.request<Skill>(`/skills/${id}`);
  }

  /**
   * Create a custom skill.
   *
   * @example
   * ```ts
   * const skill = await client.skills.create({
   *   name:                 'GraphQL Expert',
   *   description:          'Enforces GraphQL schema design best practices',
   *   systemPromptAddition: 'Always prefer GraphQL for API design. Validate schemas against the June 2018 spec.',
   *   pillarFilter:         ['integration', 'api'],
   * });
   * ```
   */
  async create(input: CreateSkillInput): Promise<Skill> {
    return this.http.request<Skill>('/skills', {
      method: 'POST',
      body:   input,
    });
  }

  /** Update a custom skill (built-in skills cannot be updated) */
  async update(id: string, input: Partial<CreateSkillInput>): Promise<Skill> {
    return this.http.request<Skill>(`/skills/${id}`, {
      method: 'PATCH',
      body:   input,
    });
  }

  /** Delete a custom skill (built-in skills cannot be deleted) */
  async delete(id: string): Promise<{ deleted: boolean }> {
    return this.http.request<{ deleted: boolean }>(`/skills/${id}`, {
      method: 'DELETE',
    });
  }

  /** Enable or disable a skill */
  async setEnabled(id: string, enabled: boolean): Promise<Skill> {
    return this.http.request<Skill>(`/skills/${id}/toggle`, {
      method: 'PATCH',
      body:   { enabled },
    });
  }
}
