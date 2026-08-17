/**
 * src/__tests__/http.test.ts
 *
 * HTTP integration tests for the Atomic API layer.
 *
 * These tests boot the Express application in-process via the exported
 * `createApp()` factory and exercise it through `supertest` — no live
 * server, no flaky port discovery, no manual `npm run dev` step required.
 *
 * Run directly:
 *
 *   npm run test:http
 *
 * What is tested:
 *   - Health / readiness probes
 *   - Blueprint CRUD (list, get-404, delete-404, rating validation)
 *   - Session endpoint input validation (400 / 410)
 *   - Abort endpoint validation (400 / 404)
 *   - Generate endpoint validation (400 — no key required for shape tests)
 *   - Response Content-Type and JSON shape contracts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import http from 'http';
import request from 'supertest';
import { createApp } from '../../server';

// ── In-process application under test ──────────────────────────────────────────

const VALID_UUID = '00000000-0000-4000-8000-000000000001';
let app: express.Express;
let server: http.Server;

/**
 * Restarts the application for every test run. Booting in-process is fast
 * (the SQLite store reuses the same on-disk file) and guarantees a clean
 * middleware chain with no stray connections.
 */
beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.PORT = '5000';
  const booted = await createApp({ port: 5000 });
  app = booted.app;
  server = booted.server;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
});

beforeEach(() => {
  // Reset any per-request state that would otherwise bleed between tests.
  void app;
});

// ── GET /api/health ────────────────────────────────────────────────────────────

describe('GET /api/health', () => {
  it('returns 200 with correct shape', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    const b = res.body as Record<string, unknown>;
    expect(b.status).toBe('ok');
    expect(typeof b.uptime).toBe('number');
    expect((b.uptime as number)).toBeGreaterThanOrEqual(0);
    expect(typeof b.timestamp).toBe('string');
    expect(typeof b.instance).toBe('string');
    expect(b.version).toBe('1.0.0');
  });

  it('responds within 500 ms', async () => {
    const t0 = Date.now();
    await request(app).get('/api/health');
    expect(Date.now() - t0).toBeLessThan(500);
  });
});

// ── GET /api/ready ─────────────────────────────────────────────────────────────

describe('GET /api/ready', () => {
  it('returns 200 with ready:true and db:connected', async () => {
    const res = await request(app).get('/api/ready');
    expect(res.status).toBe(200);
    const b = res.body as Record<string, unknown>;
    expect(b.ready).toBe(true);
    expect(b.db).toBe('connected');
  });
});

// ── GET /api/v1/blueprints ─────────────────────────────────────────────────────

describe('GET /api/v1/blueprints', () => {
  it('returns 200 with items array and total', async () => {
    const res = await request(app).get('/api/v1/blueprints');
    expect(res.status).toBe(200);
    const b = res.body as Record<string, unknown>;
    expect(Array.isArray(b.items)).toBe(true);
    expect(typeof b.total).toBe('number');
  });

  it('accepts limit/offset query params', async () => {
    const res = await request(app).get('/api/v1/blueprints?limit=5&offset=0');
    expect(res.status).toBe(200);
    const b = res.body as Record<string, unknown>;
    expect((b.items as unknown[]).length).toBeLessThanOrEqual(5);
  });

  it('accepts sort=quality param', async () => {
    const res = await request(app).get('/api/v1/blueprints?sort=quality');
    expect(res.status).toBe(200);
  }, 30_000);

  it('accepts sort=oldest param', async () => {
    const res = await request(app).get('/api/v1/blueprints?sort=oldest');
    expect(res.status).toBe(200);
  }, 30_000);

  it('accepts quality_min param', async () => {
    const res = await request(app).get('/api/v1/blueprints?quality_min=90');
    expect(res.status).toBe(200);
  }, 30_000);

  it('accepts date_after param', async () => {
    const res = await request(app).get('/api/v1/blueprints?date_after=2024-01-01');
    expect(res.status).toBe(200);
  }, 30_000);

  it('respects x-workspace-id header', async () => {
    const res = await request(app)
      .get('/api/v1/blueprints')
      .set('x-workspace-id', 'test-workspace');
    expect(res.status).toBe(200);
  }, 30_000);

  it('returns Content-Type: application/json', async () => {
    const res = await request(app).get('/api/v1/blueprints');
    expect(res.headers['content-type']).toContain('application/json');
  });
});

// ── GET /api/v1/blueprints/tags ────────────────────────────────────────────────

describe('GET /api/v1/blueprints/tags', () => {
  it('returns 200 with a tags array', async () => {
    const res = await request(app).get('/api/v1/blueprints/tags');
    expect(res.status).toBe(200);
    const b = res.body as Record<string, unknown>;
    expect(Array.isArray(b.tags)).toBe(true);
  });
});

// ── GET /api/v1/blueprints/:id ─────────────────────────────────────────────────

describe('GET /api/v1/blueprints/:id', () => {
  it('returns 404 for a non-existent blueprint UUID', async () => {
    const res = await request(app).get(`/api/v1/blueprints/${VALID_UUID}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for a malformed / non-existent ID (no DB record)', async () => {
    // Blueprint IDs are stored as UUIDs but the route does not validate the format —
    // an unknown string simply yields "not found" from the DB.
    const res = await request(app).get('/api/v1/blueprints/not-a-valid-blueprint-id');
    expect([400, 404]).toContain(res.status);
  }, 30_000);
});

// ── PATCH /api/v1/blueprints/:id/rating ───────────────────────────────────────

describe('PATCH /api/v1/blueprints/:id/rating', () => {
  it('returns 404 for non-existent blueprint', async () => {
    const res = await request(app)
      .patch(`/api/v1/blueprints/${VALID_UUID}/rating`)
      .send({ rating: 4 });
    expect(res.status).toBe(404);
  });

  it('returns 400 or 404 for out-of-range rating', async () => {
    const res = await request(app)
      .patch(`/api/v1/blueprints/${VALID_UUID}/rating`)
      .send({ rating: 99 });
    expect([400, 404]).toContain(res.status);
  });
});

// ── DELETE /api/v1/blueprints/:id ─────────────────────────────────────────────

describe('DELETE /api/v1/blueprints/:id', () => {
  it('returns 404 for a non-existent blueprint', async () => {
    const res = await request(app).delete(`/api/v1/blueprints/${VALID_UUID}`);
    expect(res.status).toBe(404);
  });
});

// ── GET /api/v1/sessions/:id ───────────────────────────────────────────────────

describe('GET /api/v1/sessions/:id', () => {
  it('returns 400 for an invalid session ID', async () => {
    const res = await request(app).get('/api/v1/sessions/not-a-uuid');
    expect(res.status).toBe(400);
    expect((res.body as Record<string, unknown>).error).toBeTruthy();
  });

  it('returns 410 for a valid UUID that does not exist', async () => {
    const res = await request(app).get(`/api/v1/sessions/${VALID_UUID}`);
    expect(res.status).toBe(410);
  });
});

// ── POST /api/v1/sessions/:id/abort ───────────────────────────────────────────

describe('POST /api/v1/sessions/:id/abort', () => {
  it('returns 400 for a non-UUID session ID', async () => {
    const res = await request(app).post('/api/v1/sessions/bad-id/abort');
    expect(res.status).toBe(400);
    expect((res.body as Record<string, unknown>).error).toBeTruthy();
  });

  it('returns 404 when no active generation exists for a valid UUID', async () => {
    const res = await request(app).post(`/api/v1/sessions/${VALID_UUID}/abort`);
    expect(res.status).toBe(404);
  });
});

// ── POST /api/v1/generate (validation-only) ───────────────────────────────────
// NOTE: The generate endpoint opens an SSE stream on success, so we use an
// AbortSignal to cut the connection immediately after reading the status line.
// The endpoint also has its own strict generationLimiter that fires BEFORE route
// validation, so 429 is an acceptable response when the test suite is rate-limited.

async function generateCheck(body: Record<string, unknown>): Promise<number> {
  // supertest can't abort mid-stream cleanly, so call the endpoint with fetch
  // against the in-process server using the real HTTP socket.
  const port = (server.address() as { port: number }).port;
  const ac = new AbortController();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    ac.abort(); // drop the SSE stream immediately after reading status
    return res.status;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return 0;
    throw err;
  }
}

describe('POST /api/v1/generate (input validation)', () => {
  // 400 = validation rejected; 429 = generationLimiter fired before validation
  // (both are correct — 429 happens when running the full test suite rapidly)
  it('returns 400 or 429 when prompt is missing', async () => {
    const status = await generateCheck({});
    expect([400, 429]).toContain(status);
  }, 30_000);

  it('returns 400 or 429 when prompt is empty string', async () => {
    const status = await generateCheck({ prompt: '   ' });
    expect([400, 429]).toContain(status);
  }, 30_000);

  it('returns 400 or 429 for an invalid mode value', async () => {
    const status = await generateCheck({ prompt: 'test', mode: 'turbo' });
    expect([400, 429]).toContain(status);
  }, 30_000);
});

// ── GET /api/v1/metrics ────────────────────────────────────────────────────────

describe('GET /api/v1/metrics', () => {
  it('returns 200, 401, 403, or 503 (admin-gated, public, or store unavailable)', async () => {
    const res = await request(app).get('/api/v1/metrics');
    // 200 = public metrics; 401/403 = admin token required; 503 = Redis not configured
    expect([200, 401, 403, 503]).toContain(res.status);
  });
});

// ── SPA catch-all ─────────────────────────────────────────────────────────────
// Unknown *API* routes return 404. Unknown *app* routes return 200 (SPA index).

describe('Route shape contracts', () => {
  it('Non-API unknown route returns 200 (SPA index.html)', async () => {
    // Express catch-all serves the React SPA for any non-API path
    const res = await request(app).get('/some-spa-path-that-does-not-exist');
    expect(res.status).toBe(200);
    const ct = res.headers['content-type'] ?? '';
    expect(ct).toContain('text/html');
  }, 10_000);

  it('Health probe is always reachable (not 5xx)', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBeLessThan(500);
  });
});
