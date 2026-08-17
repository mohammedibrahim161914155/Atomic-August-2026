import { describe, it, expect } from 'vitest';
import { saveCheckpoint, loadCheckpoint, generateSessionId } from './checkpoint';

describe('checkpoint', () => {
  it('generateSessionId returns a valid UUID v4', () => {
    const id = generateSessionId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('saveCheckpoint / loadCheckpoint round-trips data', async () => {
    const sid = generateSessionId();
    await saveCheckpoint(sid, 'test', { foo: 'bar' });
    expect(await loadCheckpoint(sid, 'test')).toEqual({ foo: 'bar' });
  });

  it('returns null for a missing key', async () => {
    expect(await loadCheckpoint('no-such-session', 'x')).toBeNull();
  });

  it('verifies session tokens safely', async () => {
    const { saveMeta, verifySessionToken } = await import('./checkpoint');
    const crypto = await import('crypto');
    const token = 'my_secret';
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    await saveMeta('sess_verify', { last_checkpoint: null, id: 'sess_verify', prompt: 'test', status: 'running', mode: 'fast', created_at: new Date().toISOString(), session_token: hash });

    expect(await verifySessionToken('sess_verify', token)).toBe(true);
    expect(await verifySessionToken('sess_verify', 'wrong')).toBe(false);
    expect(await verifySessionToken('sess_missing', 'whatever')).toBe(false);
  });

  it('lists sessions correctly', async () => {
    const { saveMeta, listSessions } = await import('./checkpoint');
    await saveMeta('l1', { last_checkpoint: null, id: 'l1', prompt: 'p1', mode: 'fast', status: 'running', created_at: '2020' });
    await saveMeta('l2', { last_checkpoint: null, id: 'l2', prompt: 'p2', mode: 'fast', status: 'running', created_at: '2021' });
    const list = await listSessions();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.some(x => x.id === 'l2')).toBe(true);
  });

  it('deletes sessions entirely', async () => {
    const { saveMeta, loadMeta, deleteSession, checkpointExists, saveCheckpoint } = await import('./checkpoint');
    await saveMeta('del_test', { last_checkpoint: null, id: 'del_test', prompt: 'p', mode: 'fast', status: 'running', created_at: '' });
    await saveCheckpoint('del_test', 'intent', { x: 1 });
    await deleteSession('del_test');
    expect(await loadMeta('del_test')).toBeNull();
    expect(await checkpointExists('del_test', 'intent')).toBe(false);
  });

  it('prunes expired keys if store supports it', async () => {
    const { pruneOldSessions } = await import('./checkpoint');
    const p = await pruneOldSessions();
    expect(typeof p).toBe('number');
  });
});
