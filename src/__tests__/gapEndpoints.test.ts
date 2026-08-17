/**
 * src/__tests__/gapEndpoints.test.ts
 *
 * HTTP integration tests for the v2.2 gap-closing endpoints:
 * permissions (Codex execpolicy + Kilo permission), elicitations (Codex
 * elicitation + Kilo question tool), quality ledger (OpenDesign ratchet)
 * and run summaries (Kilo Code kilo-telemetry).
 *
 * Boots the Express app in-process via the exported `createApp()` factory
 * and drives it through `supertest` — same pattern as http.test.ts.
 *
 * Run directly:
 *
 *   npm run test:http   (vitest picks up all src/__tests__/*.test.ts)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'http';
import request from 'supertest';
import { createApp } from '../../server';

const UUID = '00000000-0000-4000-8000-000000000001';
const H = { 'x-forwarded-proto': 'https' };

describe('v2.2 gap-closing endpoints', () => {
  let app: express.Express;
  let server: http.Server;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.PORT = '5001';
    process.env.CONFIG_ENCRYPTION_KEY = 'b'.repeat(64);
    process.env.ALLOWED_ORIGIN = 'https://test.local';
    process.env.OPENROUTER_API_KEY = 'sk-test-fake';
    const booted = await createApp({ port: 5001 });
    app = booted.app;
    server = booted.server;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    delete process.env.CONFIG_ENCRYPTION_KEY;
    delete process.env.ALLOWED_ORIGIN;
    delete process.env.OPENROUTER_API_KEY;
  });

  it('GET /permissions returns all 9 operations at full-auto default', async () => {
    const res = await request(app).get(`/api/v1/sessions/${UUID}/permissions`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.tiers).toHaveLength(9);
    for (const t of res.body.tiers) {
      expect(['full-auto', 'ask', 'deny']).toContain(t.tier);
    }
  });

  it('PATCH /permissions gates invalid operation/tier values with 400', async () => {
    const res = await request(app)
      .patch(`/api/v1/sessions/${UUID}/permissions`)
      .set(H)
      .send({ operation: 'not-an-operation', tier: 'ask' });
    expect(res.status).toBe(400);
  });

  it('PATCH /permissions persists and read-back reflects the session override', async () => {
    const patch = await request(app)
      .patch(`/api/v1/sessions/${UUID}/permissions`)
      .set(H)
      .send({ operation: 'undo', tier: 'deny' });
    expect(patch.status).toBe(200);
    expect(patch.body.tier).toBe('deny');

    const get = await request(app).get(`/api/v1/sessions/${UUID}/permissions`).set(H);
    const undo = get.body.tiers.find((t: { operation: string }) => t.operation === 'undo');
    expect(undo.tier).toBe('deny');
  });

  it('invalid session ids are rejected with 400 on all new endpoints', async () => {
    for (const path of ['/permissions', '/runs', '/elicitations', '/quality/blueprint']) {
      const res = await request(app).get(`/api/v1/sessions/bad${path}`).set(H);
      expect(res.status).toBe(400);
    }
  });

  it('GET /runs returns an empty run list for a fresh session', async () => {
    const res = await request(app).get(`/api/v1/sessions/${UUID}/runs`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
  });

  it('GET /quality/:pipeline returns an empty ledger with zeroed summary', async () => {
    const res = await request(app).get(`/api/v1/sessions/${UUID}/quality/blueprint`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
    expect(res.body.summary.rounds).toBe(0);
  });

  it('GET /elicitations returns pending + history', async () => {
    const res = await request(app).get(`/api/v1/sessions/${UUID}/elicitations`).set(H);
    expect(res.status).toBe(200);
    expect(res.body.has_pending).toBe(false);
    expect(res.body.pending).toEqual([]);
    expect(res.body.history).toEqual([]);
  });

  it('POST /answer-elicitation rejects empty or invalid answers with 400', async () => {
    const bad = await request(app)
      .post(`/api/v1/sessions/${UUID}/answer-elicitation`)
      .set(H)
      .send({});
    expect(bad.status).toBe(400);

    // Answers with a missing/empty text are filtered out; if nothing valid
    // remains the request is rejected with 400.
    const alsoBad = await request(app)
      .post(`/api/v1/sessions/${UUID}/answer-elicitation`)
      .set(H)
      .send({ answers: [{ id: 'x' }] });
    expect(alsoBad.status).toBe(400);
  });

  it('POST /answer-elicitation accepts well-formed answers (no-op when id unknown)', async () => {
    const res = await request(app)
      .post(`/api/v1/sessions/${UUID}/answer-elicitation`)
      .set(H)
      .send({ answers: [{ id: '00000000-0000-4000-8000-000000000002', answer: 'JWT' }] });
    expect(res.status).toBe(200);
    expect(res.body.answered).toEqual([]);
  });
});
