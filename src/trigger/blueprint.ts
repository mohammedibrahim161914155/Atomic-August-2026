/**
 * src/trigger/blueprint.ts
 *
 * Trigger.dev v3 task for background blueprint generation.
 *
 * Usage:
 *   POST /api/v1/generate-async   → dispatches this task, returns { runId }
 *   GET  /api/v1/run/:runId        → proxies run status from Trigger.dev
 *
 * Requirements:
 *   TRIGGER_SECRET_KEY  — from https://cloud.trigger.dev → Project → API Keys
 *   TRIGGER_PROJECT_ID  — your Trigger.dev project slug  (optional, defaults to "proj_atomic")
 */

import { task, logger } from '@trigger.dev/sdk/v3';
import { generateBlueprint } from '../engine/index';
import { resolveConfig } from '../engine/config';
import { generateSessionId } from '../engine/checkpoint';
import type { EngineEvent } from '../engine/types';

export interface BlueprintTaskPayload {
  prompt: string;
  sessionId?: string;
  mode?: 'fast' | 'safe';
  provider?: string;
  fastModel?: string;
  proModel?: string;
  apiKey?: string;
}

export const generateBlueprintTask = task({
  id: 'generate-blueprint',
  maxDuration: 600,
  retry: {
    maxAttempts: 1,
  },
  run: async (payload: BlueprintTaskPayload) => {
    const {
      prompt,
      mode = 'fast',
      provider,
      fastModel,
      proModel,
      apiKey,
    } = payload;

    const sessionId = payload.sessionId ?? generateSessionId();
    logger.info('Blueprint task started', { sessionId, mode, provider });

    const config = resolveConfig(
      apiKey && provider
        ? { provider: provider as any, apiKey, fastModel, proModel }
        : {}
    );

    const events: EngineEvent[] = [];

    await generateBlueprint(
      prompt,
      config,
      (event) => {
        events.push(event);
        // Log milestone events so they're visible in the Trigger.dev dashboard
        if (
          event.type === 'session_start' ||
          event.type === 'pillar_start' ||
          event.type === 'pillar_prosecuted' ||
          event.type === 'prosecutor_done' ||
          event.type === 'synthesizer_done' ||
          event.type === 'complete' ||
          event.type === 'error'
        ) {
          logger.info(`[engine] ${event.type}`, event as Record<string, unknown>);
        }
      },
      mode,
      sessionId
    );

    const completed = events.find(e => e.type === 'complete');
    const errored = events.find(e => e.type === 'error');

    if (errored) {
      throw new Error((errored as { message?: string }).message ?? 'Blueprint generation failed');
    }

    logger.info('Blueprint task complete', { sessionId });

    return { sessionId, success: !!completed };
  },
});
