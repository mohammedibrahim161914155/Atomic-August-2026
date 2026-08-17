import { EngineEvent, GenerationMode, PipelineType } from '../engine/types';

async function readSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onEvent: (event: EngineEvent) => void,
  controller: AbortController,
  onSessionId?: (id: string) => void
): Promise<{ completed: boolean; currentSessionId?: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  let completed = false;
  let currentSessionId: string | undefined;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
            if (event['type'] === 'session_start' && event['sessionId']) {
              currentSessionId = event['sessionId'] as string;
              onSessionId?.(currentSessionId);
            }
            if (event['type'] === 'complete' || event['type'] === 'rerun_complete') {
              completed = true;
              const sessionId = (event['sessionId'] as string | undefined) ?? currentSessionId;
              if (sessionId) {
                try {
                  const bpRes = await fetch(`/api/v1/sessions/${sessionId}/blueprint`, {
                    headers: { 'Content-Type': 'application/json' }
                  });
                  if (bpRes.ok) {
                    const { blueprint } = await bpRes.json() as { blueprint: unknown };
                    onEvent({ ...event, blueprint } as EngineEvent);
                  } else {
                    onEvent({ ...event } as EngineEvent);
                  }
                } catch {
                  onEvent({ ...event } as EngineEvent);
                }
              } else {
                onEvent(event as EngineEvent);
              }
              return { completed, currentSessionId };
            }
            if (event['type'] === 'error') completed = true;
            onEvent(event as EngineEvent);
          } catch {
            // malformed SSE line — skip
          }
        }
      }
    }
  } catch (err: unknown) {
    if ((err as { name?: string })?.name !== 'AbortError') {
      console.error('SSE Read Error:', err);
    }
  }
  return { completed, currentSessionId };
}

export function startGeneration(
  prompt: string,
  mode: GenerationMode,
  onEvent: (event: EngineEvent) => void,
  pipelineType: PipelineType = 'blueprint'
): () => void {
  const controller = new AbortController();

  (async () => {
    let currentSessionId: string | undefined;
    let completed = false;
    let response: Response;

    // Route to appropriate endpoint based on pipeline type
    const url = pipelineType === 'blueprint'
      ? '/api/v1/generate'
      : '/api/v1/generate-pipeline';

    const body = pipelineType === 'blueprint'
      ? { prompt, mode }
      : { prompt, pipelineType, mode };

    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      onEvent({ type: 'error', message: (err as Error)?.message ?? 'Network error' });
      return;
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      onEvent({ type: 'error', message: body?.error ?? `HTTP ${response.status}` });
      return;
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('text/html')) {
      onEvent({ type: 'error', message: 'Received HTML instead of SSE stream. Is the backend running?' });
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      onEvent({ type: 'error', message: 'No response body' });
      return;
    }

    const result = await readSSEStream(
      reader,
      onEvent,
      controller,
      (id) => { currentSessionId = id; }
    );
    completed = result.completed;

    // Auto-reconnect for blueprint pipeline (has session continuity)
    if (!completed && !controller.signal.aborted && currentSessionId && pipelineType === 'blueprint') {
      setTimeout(() => {
        if (!controller.signal.aborted) resumeGeneration(currentSessionId!, onEvent, controller);
      }, 2000);
    }
  })();

  return () => controller.abort();
}

export function resumeGeneration(
  sessionId: string,
  onEvent: (event: EngineEvent) => void,
  controller: AbortController = new AbortController(),
  retryCount: number = 0
): () => void {

  (async () => {
    let completed = false;
    let response: Response;
    try {
      response = await fetch('/api/v1/resume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      onEvent({ type: 'error', message: (err as Error)?.message ?? 'Network error' });
      return;
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({})) as { error?: string };
      onEvent({ type: 'error', message: body?.error ?? `HTTP ${response.status}` });
      return;
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('text/html')) {
      onEvent({ type: 'error', message: 'Received HTML instead of SSE stream. Is the backend running?' });
      return;
    }
    if (contentType?.includes('application/json')) {
      const data = await response.json() as { blueprint?: unknown };
      if (data.blueprint) {
        onEvent({ type: 'complete', sessionId, blueprint: data.blueprint } as EngineEvent);
      }
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      onEvent({ type: 'error', message: 'No response body' });
      return;
    }

    const result = await readSSEStream(reader, onEvent, controller);
    completed = result.completed;
    
    if (!completed && !controller.signal.aborted) {
      if (retryCount >= 5) {
        onEvent({ type: 'error', message: 'Connection lost too many times. Please reload the page to try again.' });
        return;
      }
      const delay = Math.min(1000 * Math.pow(2, retryCount), 15_000) + Math.random() * 1000;
      setTimeout(() => {
        if (!controller.signal.aborted) resumeGeneration(sessionId, onEvent, controller, retryCount + 1);
      }, delay);
    }
  })();

  return () => controller.abort();
}

// ── Shared SSE connector used by rerun functions ──────────────────────────────

function connectSSE(
  url: string,
  body: Record<string, unknown>,
  onEvent: (event: EngineEvent) => void
): () => void {
  const controller = new AbortController();

  (async () => {
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      if ((err as { name?: string })?.name === 'AbortError') return;
      onEvent({ type: 'error', message: (err as Error)?.message ?? 'Network error' });
      return;
    }

    if (!response.ok) {
      const data = await response.json().catch(() => ({})) as { error?: string };
      onEvent({ type: 'error', message: data?.error ?? `HTTP ${response.status}` });
      return;
    }

    const reader = response.body?.getReader();
    if (!reader) {
      onEvent({ type: 'error', message: 'No response body' });
      return;
    }

    const decoder = new TextDecoder();
    let buffer = '';
    let completed = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
              if (event['type'] === 'complete' || event['type'] === 'rerun_complete') {
                completed = true;
                const sessionId = event['sessionId'] as string | undefined;
                if (sessionId) {
                  try {
                    const bpRes = await fetch(`/api/v1/sessions/${sessionId}/blueprint`, {
                      headers: { 'Content-Type': 'application/json' }
                    });
                    if (bpRes.ok) {
                      const { blueprint } = await bpRes.json() as { blueprint: unknown };
                      onEvent({ ...event, blueprint } as EngineEvent);
                    } else {
                      onEvent({ type: 'error', message: 'Failed to fetch blueprint after completion' });
                    }
                  } catch {
                    onEvent({ type: 'error', message: 'Failed to fetch blueprint after completion' });
                  }
                } else {
                  // Pipeline completions (non-blueprint) carry blueprint inline
                  onEvent(event as EngineEvent);
                }
                return;
              }
              if (event['type'] === 'error') {
                completed = true;
              }
              onEvent(event as EngineEvent);
            } catch { /* skip malformed line */ }
          }
        }
      }
    } catch (err: unknown) {
      if ((err as { name?: string })?.name !== 'AbortError') {
        console.error('SSE Read Error:', err);
      }
    }
    if (!completed && !controller.signal.aborted) {
      setTimeout(() => {
        if (!controller.signal.aborted) {
          connectSSE(url, body, onEvent);
        }
      }, 2000);
    }
  })();

  return () => controller.abort();
}

// ── Re-run a single pillar then Prosecutor + Synthesizer ─────────────────────

export function startRerunPillar(
  pillarName: string,
  sessionIdOrBlueprint: string | object,
  onEvent: (event: EngineEvent) => void
): () => void {
  const body =
    typeof sessionIdOrBlueprint === 'string'
      ? { pillarName, sessionId: sessionIdOrBlueprint }
      : { pillarName, blueprint: sessionIdOrBlueprint };
  return connectSSE('/api/v1/rerun-pillar', body, onEvent);
}
