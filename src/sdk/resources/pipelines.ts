/**
 * src/sdk/resources/pipelines.ts
 *
 * Pipeline resource — pipeline configs, specialized pipelines
 * (feature-creator / tool-builder / agent-builder), health, and cost estimation.
 */

import type { AtomicHTTP } from '../client';
import type {
  CostEstimate, GenerateAsyncOptions, GenerateAsyncResult, PipelineConfig,
  PipelineHealth,
} from '../types';

export class PipelinesResource {
  constructor(private readonly http: AtomicHTTP) {}

  /** Get the configuration of a named pipeline. */
  async getConfig(name: string): Promise<PipelineConfig> {
    return this.http.request<PipelineConfig>(`/pipelines/${name}/config`);
  }

  /** Update the configuration of a named pipeline. */
  async setConfig(name: string, updates: Partial<PipelineConfig>): Promise<PipelineConfig> {
    return this.http.request<PipelineConfig>(`/pipelines/${name}/config`, {
      method: 'PATCH',
      body:   updates,
    });
  }

  /** Health summary of all pipelines (status + last run times). */
  async health(): Promise<PipelineHealth> {
    return this.http.request<PipelineHealth>('/pipelines/health');
  }

  /** Estimate the token/cost footprint of a prompt without running it. */
  async costEstimate(prompt: string): Promise<CostEstimate> {
    return this.http.request<CostEstimate>('/pipelines/cost-estimate', {
      method: 'POST',
      body:   { prompt },
    });
  }

  /** Run the feature-creator specialized pipeline (async). */
  async runFeatureCreator(opts: GenerateAsyncOptions): Promise<GenerateAsyncResult> {
    const result = await this.http.request<GenerateAsyncResult>('/pipelines/feature-creator', {
      method: 'POST',
      body:   { prompt: opts.prompt, mode: opts.mode ?? 'fast', config: opts.modelConfig },
    });
    return result;
  }

  /** Run the tool-builder specialized pipeline (async). */
  async runToolBuilder(opts: GenerateAsyncOptions): Promise<GenerateAsyncResult> {
    const result = await this.http.request<GenerateAsyncResult>('/pipelines/tool-builder', {
      method: 'POST',
      body:   { prompt: opts.prompt, mode: opts.mode ?? 'fast', config: opts.modelConfig },
    });
    return result;
  }

  /** Run the agent-builder specialized pipeline (async). */
  async runAgentBuilder(opts: GenerateAsyncOptions): Promise<GenerateAsyncResult> {
    const result = await this.http.request<GenerateAsyncResult>('/pipelines/agent-builder', {
      method: 'POST',
      body:   { prompt: opts.prompt, mode: opts.mode ?? 'fast', config: opts.modelConfig },
    });
    return result;
  }
}
