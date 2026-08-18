import 'dotenv/config';
process.setSourceMapsEnabled(true);
if (process.env.NODE_ENV) process.env.NODE_ENV = process.env.NODE_ENV.toLowerCase().trim();
import express, { Router } from 'express';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import Redis from 'ioredis';
import cookieParser from 'cookie-parser';
import { generateBlueprint } from './src/engine/index';
import { healthMonitor } from './src/engine/providerHealthMonitor';
import { EngineEvent } from './src/engine/types';
import fs from 'fs';
import path from 'path';
import pino from 'pino';
import helmet from 'helmet';
import { createEngineLogger, engineLoggerStorage } from './src/engine/logger';
import { randomBytes, createHash, timingSafeEqual, createCipheriv, createDecipheriv, randomUUID } from 'crypto';
import {
  generateSessionId, saveCheckpoint, loadCheckpoint,
  saveMeta, loadMeta, listSessions, pruneOldSessions, isValidSessionId,
  verifySessionToken
} from './src/engine/checkpoint';
import {
  generatePlan, savePlan, loadPlan,
  steerSession, listSteerHistory,
  listStageSnapshots, undoLatestStage,
  resolvePipelineDefaults,
} from './src/engine/agenticCore';
import { getStore } from './src/engine/store';
import { answerElicitations, pendingElicitations, listElicitationHistory } from './src/engine/elicitation';
import { listEffectiveTiers, setOperationTier } from './src/engine/permissionRegistry';
import { listLedger, summarizeLedger } from './src/engine/qualityLedger';
import { listRunSummaries } from './src/engine/runSummary';
import {
  listPlugins, getPlugin, getPublicPlugin,
} from './src/plugins/engine/registry';
import { publicManifest } from './src/plugins/engine/schema';
import { validateManifest } from './src/plugins/engine/doctor';
import { installPlugin, uninstallPlugin } from './src/plugins/engine/registry';
import type { GrantableCapability } from './src/plugins/engine/trust';
import {
  trustView, grantTrust, revokeTrust,
} from './src/plugins/engine/trust';
import { runPluginPipeline } from './src/plugins/engine/runtime';
import { generateSkillPack, listSkillPacks } from './src/plugins/engine/skillPack';
import { Blueprint, BlueprintSchema, GovernorIntent, PillarOutput, GenerationMode, PillarName } from './src/engine/types';
import { runPillar } from './src/engine/pillarRunner';
import { runProsecutor } from './src/engine/prosecutor';
import { runSynthesizer } from './src/engine/synthesizer';
import { resolveConfig, ModelConfig } from './src/engine/config';
import { PILLAR_MAP } from './src/engine/pillarRegistry';
import type { PipelineDefaults } from './src/engine/agenticCore';
import { createQueue, queueStorage, validateApiKey } from './src/engine/openrouter';
import {
  saveBlueprint,
  listBlueprints,
  getBlueprint,
  deleteBlueprint as deleteBlueprintRecord,
  setRating,
  setNote,
  setTags,
  listAllTags,
} from './src/engine/blueprintStore';
import { getDb } from './src/engine/store.sqlite';
import { listAllMemories, getMemoryCount } from './src/engine/agentLongTermMemory';

// NOTE: Vite must NEVER be statically imported here. A static import forces esbuild
// to bundle the entire Vite toolchain (esbuild, rollup, postcss, …) into the
// production server, which adds megabytes of dead weight and crashes at startup
// when Vite's top-level `new URL('../../package.json', import.meta.url)` reads are
// evaluated with an empty `import.meta` in CJS output. The dev middleware is loaded
// through a dynamic `await import()` so it only executes in development.
type ViteModule = { createServer: (config: unknown) => Promise<{ middlewares: unknown }> };

function getEncKey(): Buffer | null {
  const hex = process.env.CONFIG_ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

function encryptConfig(plaintext: string): string {
  const key = getEncKey();
  if (!key) return plaintext; // dev fallback: no encryption without key
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

function decryptConfig(ciphertext: string): string {
  const key = getEncKey();
  if (!key) return ciphertext; // dev fallback
  try {
    const buf = Buffer.from(ciphertext, 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return ciphertext; // return as-is if decryption fails (e.g., unencrypted legacy entry)
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      reqId: string;
      log: pino.Logger;
    }
  }
}

const logOpts: pino.LoggerOptions = { level: process.env.LOG_LEVEL ?? 'info' };
if (process.env.NODE_ENV !== 'production') {
  logOpts.transport = { target: 'pino-pretty', options: { colorize: true } };
}
const log = pino(logOpts);

const INSTANCE_ID = randomUUID();
const ACTIVE_GENS_KEY = `atomic:active_gens:${INSTANCE_ID}`;
const activeAbortControllers = new Set<AbortController>();
/** Maps sessionId → AbortController so individual sessions can be cancelled via the API */
const generationSessionMap = new Map<string, AbortController>();

async function incrementActive(): Promise<number> {
  const store = await getStore();
  const val = await store.incr(ACTIVE_GENS_KEY);
  await store.expire(ACTIVE_GENS_KEY, 600); // 10 minutes TTL
  return val;
}
async function decrementActive(): Promise<void> {
  const store = await getStore();
  const current = parseInt((await store.get(ACTIVE_GENS_KEY)) ?? '0', 10);
  if (current > 0) {
    await store.decr(ACTIVE_GENS_KEY);
    await store.expire(ACTIVE_GENS_KEY, 600); // refresh TTL
  }
}
async function getActiveCount(): Promise<number> {
  const store = await getStore();
  const val = await store.get(ACTIVE_GENS_KEY);
  return parseInt(val ?? '0', 10);
}

/**
 * Creates the fully configured Express application (middleware, routes,
 * error handlers). Exported so that integration tests can exercise the
 * route layer with supertest without booting a real HTTP socket, and so
 * that embedding frameworks can host the API inside their own server.
 *
 * @param opts.testMode — when true the app listens on the port you supply
 *                        but skips the production-environment guards that
 *                        are only meaningful when running as a daemon.
 */
async function createApp(opts: { port: number } = { port: 5000 }): Promise<{ app: express.Express; server: import('http').Server; store: Awaited<ReturnType<typeof getStore>> }> {
  if (process.env.NODE_ENV === 'production' && !process.env.REDIS_URL) {
    log.warn('[atomic] WARNING: REDIS_URL not set in production. ' +
    'Running with local SQLite — sessions will NOT persist across restarts ' +
    'and will NOT be shared across replicas.');
  }

  if (process.env.NODE_ENV === 'production' && !process.env.CONFIG_ENCRYPTION_KEY) {
    log.error(
      '[atomic] FATAL: CONFIG_ENCRYPTION_KEY is required in production. ' +
      'User API keys cannot be stored safely without it. ' +
      'Generate one with: openssl rand -hex 32'
    );
    process.exit(1);
  }

  const store = await getStore();
  // Only reset the counter when running without Redis (SQLite is single-process,
  // so the counter is always stale after a restart). When Redis is in use,
  // each replica manages its OWN counter under a per-instance key, and the
  // shared cap is derived by summing all instance counters.
  const usingRedis = !!process.env.REDIS_URL;
  if (!usingRedis) {
    await store.set(ACTIVE_GENS_KEY, '0');
    log.info(`[atomic] Reset active_gens counter to 0 on startup (${ACTIVE_GENS_KEY}) — any in-flight generations from a previous crash have been cleared`);
  } else {
    log.info(`[atomic] Using per-instance active_gens counter (${ACTIVE_GENS_KEY}) with TTL — crashed instances will auto-expire`);
  }

  setInterval(pruneOldSessions, 60 * 60 * 1000); // Prune every hour
  await pruneOldSessions();
  const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_GENERATIONS ?? '3', 10);
  const TIMEOUT_FAST_MS = parseInt(process.env.TIMEOUT_FAST_MS ?? String(5 * 60 * 1000), 10);
  const TIMEOUT_SAFE_MS = parseInt(process.env.TIMEOUT_SAFE_MS ?? String(12 * 60 * 1000), 10);
  const TIMEOUT_RERUN_MS = parseInt(process.env.TIMEOUT_RERUN_MS ?? String(8 * 60 * 1000), 10);
  const MAX_TOKENS_PER_SESSION = parseInt(process.env.MAX_TOKENS_PER_SESSION ?? String(500_000), 10);

  const PORT = opts.port;
  if (isNaN(PORT) || PORT < 1 || PORT > 65535) {
    log.error('Invalid PORT value — must be 1-65535');
    process.exit(1);
  }
  if (isNaN(MAX_CONCURRENT) || MAX_CONCURRENT < 1) {
    log.error('Invalid MAX_CONCURRENT_GENERATIONS — must be a positive integer');
    process.exit(1);
  }
  if (isNaN(TIMEOUT_FAST_MS) || TIMEOUT_FAST_MS < 1000) {
    log.error('Invalid TIMEOUT_FAST_MS — must be a positive integer >= 1000');
    process.exit(1);
  }
  if (isNaN(TIMEOUT_SAFE_MS) || TIMEOUT_SAFE_MS < 1000) {
    log.error('Invalid TIMEOUT_SAFE_MS — must be a positive integer >= 1000');
    process.exit(1);
  }
  if (isNaN(TIMEOUT_RERUN_MS) || TIMEOUT_RERUN_MS < 1000) {
    log.error('Invalid TIMEOUT_RERUN_MS — must be a positive integer >= 1000');
    process.exit(1);
  }
  if (isNaN(MAX_TOKENS_PER_SESSION) || MAX_TOKENS_PER_SESSION < 1) {
    log.error('Invalid MAX_TOKENS_PER_SESSION — must be a positive integer');
    process.exit(1);
  }

  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());

  if (process.env.NODE_ENV === 'production' && !process.env.OPENROUTER_API_KEY) {
    log.warn('OPENROUTER_API_KEY environment variable is not set. Generations will fail.');
  }

  // HTTPS Redirect middleware for production
  app.use((req, res, next) => {
    if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(`https://${req.headers.host}${req.url}`);
    }
    next();
  });

  app.use(helmet({
    contentSecurityPolicy: process.env.NODE_ENV === 'production'
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com"],
            imgSrc: ["'self'", "data:", "blob:"],
            connectSrc: ["'self'", "ws:", "wss:"],
            fontSrc: ["'self'", "fonts.gstatic.com"],
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
    xFrameOptions: process.env.NODE_ENV === 'production' ? { action: 'sameorigin' } : false,
  }));

// CSRF PROTECTION: All mutation endpoints are protected by SameSite=Strict
// httpOnly session cookies. Because cookies are SameSite=Strict, browsers
// will not attach them to cross-origin requests, making CSRF impossible
// without the cookie. The previous hardcoded string header check provided
// false security (any attacker reading the public JS bundle could replicate
// the string) and has been removed.

  app.use((req, res, next) => {
    // Honor an incoming X-Request-ID from clients, gateways, or load-balancers.
    // Sanitise: accept only alphanum + hyphens, max 64 chars; otherwise generate.
    const incoming = req.headers['x-request-id'];
    const incomingStr = Array.isArray(incoming) ? incoming[0] : incoming;
    const reqId =
      incomingStr && /^[\w-]{1,64}$/.test(incomingStr)
        ? incomingStr
        : randomBytes(8).toString('hex');
    const start = Date.now();
    req.reqId = reqId;
    res.setHeader('X-Request-ID', reqId);
    req.log = log.child({ reqId });
    res.on('finish', () => {
      req.log.debug({ method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
    });
    next();
  });

  const redisClient = process.env.REDIS_URL ? new Redis(process.env.REDIS_URL) : null;

  const rateLimitStore = (prefix: string) =>
    redisClient
      ? new RedisStore({
          sendCommand: (...args: string[]) => (redisClient as any).sendCommand(args),
          prefix: `rl:${prefix}:`,
        })
      : undefined;

  const generationLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests — please wait before trying again." },
    validate: { xForwardedForHeader: true, forwardedHeader: true },
    store: rateLimitStore('gen'),
  });

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { xForwardedForHeader: true, forwardedHeader: true },
    store: rateLimitStore('api'),
  });

  const inlineBlueprintLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many blueprint sessions created — please wait.' },
    validate: { xForwardedForHeader: true, forwardedHeader: true },
    store: rateLimitStore('blueprint'),
  });

  app.use('/api/', apiLimiter);

  app.use(compression({
    filter: (req, res) => {
      if (
        req.path.startsWith('/api/v1/generate') ||
        req.path.startsWith('/api/v1/resume') ||
        req.path.startsWith('/api/v1/rerun-pillar')
      ) return false;
      return compression.filter(req, res);
    }
  }));
  app.use(express.json({ limit: '5mb' }));

  if (process.env.NODE_ENV === 'production' && !process.env.ALLOWED_ORIGIN) {
    log.error('ALLOWED_ORIGIN must be set in production. Exiting.');
    process.exit(1);
  }

  app.use((req, res, next) => {
    const allowed = process.env.ALLOWED_ORIGIN ?? 'http://localhost:3000';
    const requestOrigin = req.headers.origin;
    if (requestOrigin === allowed) {
      res.setHeader('Access-Control-Allow-Origin', allowed);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-forwarded-for, forwarded');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  const extractConfig = async (req: express.Request): Promise<ModelConfig> => {
    // Prefer stored config (from httpOnly cookie)
    const configId = req.cookies['atomic_cfg'];
    if (configId) {
      const store = await getStore();
      const raw = await store.get(`cfg:${configId}`);
      if (raw) {
        try {
          const cfg = JSON.parse(decryptConfig(raw));
          req.log.debug({ provider: cfg.provider }, 'Using stored config');
          return cfg;
        } catch {
          req.log.warn({ configId }, 'Corrupted config entry in store — falling back to env config');
        }
      }
    }
    // Fallback: server-side env var config (no user key in body)
    return resolveConfig({});
  };

  function validateGenerateBody(
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ): void {
    const { prompt } = req.body ?? {};
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
      res.status(400).json({ error: 'prompt is required and must be a non-empty string.' });
      return;
    }
    const MAX_PROMPT_CHARS = 4_000;
    if (prompt.length > MAX_PROMPT_CHARS) {
      res.status(400).json({
        error: `Prompt exceeds ${MAX_PROMPT_CHARS} characters (received ${prompt.length}).`
      });
      return;
    }
    // Strip null bytes and non-printable ASCII control characters (except newline/tab)
    // eslint-disable-next-line no-control-regex
    const sanitized = prompt.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
    if (sanitized.length === 0) {
      res.status(400).json({ error: 'Prompt contains no valid content after sanitization.' });
      return;
    }
    // Warn if the prompt looks like a system prompt injection attempt
    const INJECTION_PATTERNS = [
      /ignore (all |previous |above |prior )?instructions/i,
      /you are now/i,
      /disregard (your |all |the )?(previous |prior |above )?instructions/i,
      /system prompt/i,
      /\]\s*\n\s*\[system/i,
    ];
    if (INJECTION_PATTERNS.some(p => p.test(sanitized))) {
      req.log.warn({ reqId: req.reqId }, 'Potential prompt injection detected');
      // Log but do not block — these patterns can appear in legitimate software descriptions.
      // The log entry provides an audit trail.
    }
    req.body.prompt = sanitized;
    next();
  }

  const v1 = Router();

  function requireAdmin(
    req: express.Request, res: express.Response, next: express.NextFunction
  ): void {
    const token = req.headers['x-admin-token'] as string | undefined;
    const adminToken = process.env.ADMIN_TOKEN;
    if (!adminToken) {
      // Admin token not configured — block access entirely
      res.status(503).json({ error: 'Admin endpoint not configured' });
      return;
    }
    const a = createHash('sha256').update(token || '').digest();
    const b = createHash('sha256').update(adminToken).digest();
    if (!token || !timingSafeEqual(a, b)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  }

  v1.post('/configure-key', apiLimiter, async (req, res): Promise<void> => {
    const body = req.body as { provider?: string; apiKey?: string; fastModel?: string; proModel?: string; effort?: string; thinkingEnabled?: boolean } | undefined;
    const { provider, apiKey, fastModel, proModel, effort, thinkingEnabled } = body ?? {};
    if (!apiKey || !provider) {
      res.status(400).json({ error: 'provider and apiKey are required' });
      return;
    }
    
    // Update: Use format-only check instead of live validation
    const keyPatterns: Record<string, RegExp> = {
      openrouter: /^sk-or-/,
      openai: /^sk-(proj-|[A-Za-z0-9]{32,})/,
      anthropic: /^sk-ant-/,
      google: /^AIza/,
      deepseek: /^sk-/,
      xai: /^xai-/,
      mistral: /^[A-Za-z0-9]{32,}$/,
      zai: /^[A-Za-z0-9]{32,}$/,
      minimax: /^[A-Za-z0-9]{32,}$/,
    };
    const pattern = keyPatterns[provider];
    if (pattern && !pattern.test(apiKey.trim())) {
      res.status(400).json({ error: 'API key format is invalid for the selected provider.' });
      return;
    }
    
    const configId = randomBytes(16).toString('hex');
    const store = await getStore();
    const configPayload = encryptConfig(JSON.stringify({ provider, apiKey, fastModel, proModel, effort, thinkingEnabled }));
    await store.set(`cfg:${configId}`, configPayload, 7 * 24 * 60 * 60);
    
    res.cookie('atomic_cfg', configId, {
      httpOnly: true, 
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', 
      maxAge: 7 * 24 * 60 * 60 * 1000, 
      path: '/api/v1',
    });
    res.json({ ok: true });
  });

  v1.get('/my-config', async (req, res): Promise<void> => {
    const configId = req.cookies['atomic_cfg'];
    if (!configId) {
      res.status(404).json({ error: 'No config saved' });
      return;
    }
    try {
      const store = await getStore();
      const raw = await store.get(`cfg:${configId}`);
      if (!raw) {
        res.status(404).json({ error: 'Config not found' });
        return;
      }
      const cfg = JSON.parse(decryptConfig(raw));
      // Never return the apiKey to the client
      res.json({
        provider:        cfg.provider,
        fastModel:       cfg.fastModel,
        proModel:        cfg.proModel,
        effort:          cfg.effort,
        thinkingEnabled: cfg.thinkingEnabled,
      });
    } catch {
      res.status(500).json({ error: 'Failed to read config' });
    }
  });

  v1.get('/sessions', requireAdmin, async (_req, res): Promise<void> => {
    try {
      res.json({ sessions: await listSessions() });
    } catch (err: any) {
      log.error({ err }, 'Error listing sessions');
      res.status(500).json({ error: 'Failed to list sessions', sessions: [] });
    }
  });

  v1.get('/my-sessions', async (req, res): Promise<void> => {
    try {
      const sessionIds = Object.keys(req.cookies)
        .filter(key => key.startsWith('atomic_token_'))
        .map(key => key.replace('atomic_token_', ''));

      const verified = await Promise.all(
        sessionIds.map(async (id) => {
          if (!isValidSessionId(id)) return null;
          const token = req.cookies[`atomic_token_${id}`];
          if (!token) return null;
          const ok = await verifySessionToken(id, token);
          if (!ok) return null;
          return loadMeta(id);
        })
      );
      res.json({ sessions: verified.filter(Boolean).slice(0, 50) });
    } catch (err: any) {
      log.error({ err }, 'Error listing user sessions');
      res.status(500).json({ error: 'Failed to list sessions', sessions: [] });
    }
  });

  v1.get('/sessions/:id', async (req, res): Promise<void> => {
    const sessionId = req.params.id;
    if (!sessionId || !isValidSessionId(sessionId)) { res.status(400).json({ error: 'Invalid sessionId' }); return; }
    const sessionToken = req.cookies[`atomic_token_${sessionId}`];
    if (!(await verifySessionToken(sessionId, sessionToken))) {
      const meta = await loadMeta(sessionId);
      if (!meta) {
        res.status(410).json({ error: 'Session has expired or does not exist.' });
      } else {
        res.status(403).json({ error: 'Forbidden' });
      }
      return;
    }
    try {
      const meta = await loadMeta(sessionId);
      if (!meta) { res.status(404).json({ error: 'Session not found' }); return; }
      res.json({ session: { id: meta.id, prompt: meta.prompt, mode: meta.mode, status: meta.status, created_at: meta.created_at } });
    } catch (err: any) {
      log.error({ err }, 'Error loading session');
      res.status(500).json({ error: 'Failed to load session' });
    }
  });

  v1.get('/sessions/:id/blueprint', async (req, res): Promise<void> => {
    const sessionId = req.params.id;
    if (!sessionId || !isValidSessionId(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId' }); return;
    }
    const sessionToken = req.cookies[`atomic_token_${sessionId}`];
    if (!(await verifySessionToken(sessionId, sessionToken))) {
      res.status(403).json({ error: 'Forbidden' }); return;
    }
    const blueprint = await loadCheckpoint<Blueprint>(sessionId, 'blueprint');
    if (!blueprint) { res.status(404).json({ error: 'Blueprint not found' }); return; }
    res.json({ blueprint });
  });

  v1.get('/health', async (req, res): Promise<void> => {
    const notices: Array<{ id: string; level: 'info' | 'warning' | 'error'; message: string }> = [];
    try {
      const store = await getStore();
      await store.set('health:ping', '1', 60);
      const v = await store.get('health:ping');
      if (v !== '1') throw new Error('Store read-write check failed');

      // Check active generation pressure (curator degradation signal)
      const active = await getActiveCount();
      const MAX = parseInt(process.env.MAX_CONCURRENT_GENERATIONS ?? '3', 10);
      if (active >= MAX) {
        notices.push({ id: 'capacity-high', level: 'warning', message: `Generation capacity is at limit (${active}/${MAX}). New requests may queue.` });
      }

      // Check if a stored API key exists for the configured model
      try {
        const cfg = await extractConfig(req);
        if (!cfg.apiKey) {
          notices.push({ id: 'no-api-key', level: 'error', message: 'No API key configured. Go to Settings to add your key.' });
        }
      } catch {
        notices.push({ id: 'config-error', level: 'warning', message: 'Could not read model configuration. Check Settings.' });
      }

      res.json({ ok: true, notices });
    } catch (err: any) {
      log.error({ err }, 'Health check failed');
      notices.push({ id: 'store-error', level: 'error', message: 'Server store error — blueprint saving may be affected.' });
      res.status(503).json({ ok: false, error: err.message, notices });
    }
  });

  v1.get('/metrics', requireAdmin, async (_req, res) => {
    try {
      const store = await getStore();
      const [started, completed, failed, tokens, costMicro] = await Promise.all([
        store.get('metrics:generations_started'),
        store.get('metrics:generations_completed'),
        store.get('metrics:generations_failed'),
        store.get('metrics:total_tokens_used'),
        store.get('metrics:total_cost_microdollars'),
      ]);
      const totalCostMicro = parseInt(costMicro ?? '0', 10);
      res.json({
        total_generations_started: parseInt(started ?? '0', 10),
        total_generations_completed: parseInt(completed ?? '0', 10),
        total_generations_failed: parseInt(failed ?? '0', 10),
        total_tokens_used: parseInt(tokens ?? '0', 10),
        total_estimated_cost_usd: parseFloat((totalCostMicro / 1_000_000).toFixed(6)),
        active_generations: await getActiveCount(),
        uptime_seconds: Math.floor(process.uptime()),
        node_version: process.version,
      });
    } catch (err: any) {
      res.status(503).json({ error: 'Metrics unavailable', detail: err.message });
    }
  });

  v1.post('/test-key', async (req, res): Promise<void> => {
    let config = await extractConfig(req);
    const body = req.body as { provider?: string; apiKey?: string } | undefined;
    
    // If testing a newly typed key that hasn't been saved yet
    if (body?.apiKey && body?.provider) {
      config = { ...config, provider: body.provider as any, apiKey: body.apiKey };
    }
    
    if (!config.apiKey) {
      res.status(400).json({ error: 'No API key configured.' });
      return;
    }

    const isValid = await validateApiKey(config);
    if (!isValid) {
      res.status(401).json({ error: 'Invalid API key or provider configuration.' });
      return;
    }

    res.json({ ok: true });
  });

  function createEventSender(
    res: express.Response,
    abort: AbortController,
    sessionId: string | undefined,
    MAX_TOKENS_PER_SESSION: number
  ) {
    const state = { isEnded: false, hasExceeded: false };
    let accumulatedTokens = 0;

    const send = (event: EngineEvent) => {
      if (state.hasExceeded) return;

      // Accumulate tokens from any event that reports them
      const tokenEvent = event as { tokens_used?: number; total_tokens?: number; blueprint?: { total_tokens?: number } };
      if (tokenEvent.tokens_used) {
        accumulatedTokens += tokenEvent.tokens_used;
      }
      // total_tokens is usually absolute, but we'll take the max to be safe
      if (tokenEvent.total_tokens) {
        accumulatedTokens = Math.max(accumulatedTokens, tokenEvent.total_tokens);
      }
      if (tokenEvent.blueprint?.total_tokens) {
        accumulatedTokens = Math.max(accumulatedTokens, tokenEvent.blueprint.total_tokens);
      }

      if (accumulatedTokens > MAX_TOKENS_PER_SESSION) {
        log.warn({ tokens: accumulatedTokens, sessionId }, 'Session exceeded token budget (incremental check)');
        res.write(`data: ${JSON.stringify({ type: 'error', message: 'Token limit exceeded.' })}\n\n`);
        state.hasExceeded = true;
        abort.abort();
        return;
      }

      if (event.type === 'complete' || event.type === 'rerun_complete') {
        getStore().then(s => s.incr('metrics:generations_completed')).catch(e => log.error({ err: e }, 'metrics err'));
        const bp = (event as { blueprint?: Blueprint }).blueprint;
        if (bp?.total_tokens) {
          getStore()
            .then(s => s.incr('metrics:total_tokens_used'))
            .catch(e => log.error({ err: e }, 'metrics err'));
        }
        if (bp?.estimated_cost_usd) {
          // Store cost in micro-dollars (integer) to use Redis INCR safely.
          // 1 micro-dollar = $0.000001. Max representable: ~$9,223,372 (int64).
          const microDollars = Math.round((bp.estimated_cost_usd ?? 0) * 1_000_000);
          if (microDollars > 0) {
            getStore()
              .then(s => s.incrBy('metrics:total_cost_microdollars', microDollars))
              .catch(e => log.error({ err: e }, 'metrics err'));
          }
        }
      }
      if (event.type === 'error') {
        getStore().then(s => s.incr('metrics:generations_failed')).catch(e => log.error({ err: e }, 'metrics err'));
      }
      
      if (state.isEnded || abort.signal.aborted) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    return { send, state };
  }

  v1.post('/generate', generationLimiter, validateGenerateBody, async (req, res): Promise<void> => {
    const body = req.body as { prompt: string; mode?: GenerationMode; sessionId?: string; idempotency_key?: string };
    const { prompt, mode = 'fast', sessionId, idempotency_key } = body;
    const config = await extractConfig(req);
    if (mode && mode !== 'fast' && mode !== 'safe') {
      res.status(400).json({ error: 'mode must be "fast" or "safe"' });
      return;
    }

    if (idempotency_key && typeof idempotency_key === 'string') {
      if (idempotency_key.length > 128) {
        res.status(400).json({ error: 'idempotency_key must be 128 characters or fewer.' });
        return;
      }
      const store = await getStore();
      const existingSession = await store.get(`idem:${idempotency_key}`);
      if (existingSession) {
        // Return a redirect to the existing session instead of creating a new one
        res.status(200).json({
          existing: true,
          sessionId: existingSession,
          message: 'Duplicate request — use the existing session ID to resume.'
        });
        return;
      }
    }

    if (sessionId) {
      if (!isValidSessionId(sessionId)) {
        res.status(400).json({ error: 'Invalid sessionId' });
        return;
      }
      const sessionToken = req.cookies[`atomic_token_${sessionId}`];
      if (!(await verifySessionToken(sessionId, sessionToken))) {
        const meta = await loadMeta(sessionId);
        if (!meta) {
          res.status(410).json({ error: 'Session has expired or does not exist.' });
        } else {
          res.status(403).json({ error: 'Forbidden' });
        }
        return;
      }
    }

    const newActive = await incrementActive();
    if (newActive > MAX_CONCURRENT) {
      await decrementActive();
      res.status(429).json({ error: `Server busy — try again shortly.` });
      return;
    }

    const abort = new AbortController();
    activeAbortControllers.add(abort);
    req.on('close', () => abort.abort());

    const isNew = !sessionId;
    const actualSessionId = sessionId ?? generateSessionId();
    generationSessionMap.set(actualSessionId, abort);
    const sessionToken = isNew ? randomBytes(32).toString('hex') : undefined;
    const sessionTokenHash = sessionToken ? createHash('sha256').update(sessionToken).digest('hex') : undefined;

    if (idempotency_key && typeof idempotency_key === 'string') {
      const store = await getStore();
      await store.set(`idem:${idempotency_key}`, actualSessionId, 24 * 60 * 60);
    }

    if (isNew && sessionToken) {
      res.cookie(`atomic_token_${actualSessionId}`, sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/api/v1',
      });
      await saveMeta(actualSessionId, {
        id: actualSessionId,
        prompt: prompt.trim(),
        mode: mode as GenerationMode,
        created_at: new Date().toISOString(),
        status: 'running',
        last_checkpoint: null,
        ...(sessionTokenHash ? { session_token: sessionTokenHash } : {})
      });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const { send, state } = createEventSender(res, abort, actualSessionId, MAX_TOKENS_PER_SESSION);

    // First event: give the client the correlation ID so it can tag all logs.
    send({ type: 'request_id', reqId: req.reqId });

    getStore().then(s => s.incr('metrics:generations_started')).catch(e => log.error({ err: e }, 'metrics err'));

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);

    const timeoutMs = mode === 'safe' ? TIMEOUT_SAFE_MS : TIMEOUT_FAST_MS;
    const timeoutId = setTimeout(() => {
      if (!state.isEnded) {
        state.isEnded = true;
        abort.abort();
        const msg = `Generation timed out after ${Math.round(timeoutMs/60000)} minutes`;
        res.write(`data: ${JSON.stringify({ type: 'error', message: msg, reqId: req.reqId })}\n\n`);
        res.end();
      }
    }, timeoutMs);

    try {
      const queue = createQueue(8); // Per-request isolated concurrency
      await queueStorage.run(queue, async () => {
        const engineLogger = createEngineLogger({ reqId: req.reqId, sessionId: actualSessionId });
        await engineLoggerStorage.run(engineLogger, async () => {
          await generateBlueprint(prompt.trim(), config, send, mode as GenerationMode, actualSessionId, abort.signal, engineLogger);
        });
      });
      // Auto-save completed blueprint to persistent history
      if (!abort.signal.aborted) {
        const finalMeta = await loadMeta(actualSessionId);
        if (finalMeta?.status === 'complete') {
          const bp = await loadCheckpoint<Blueprint>(actualSessionId, 'blueprint');
          if (bp) {
            try { saveBlueprint(bp); } catch (e) { req.log.error({ err: e }, '[blueprintStore] auto-save failed'); }
          }
        }
      }
    } catch (err: any) {
      if (!abort.signal.aborted) {
        req.log.error({ err }, 'Generation failed');
        if (err.name === 'StreamInterruptionError') {
          send({ type: 'stream_interrupted', message: err.message, reqId: req.reqId });
        } else {
          send({ type: 'error', message: err.message ?? 'Generation failed', reqId: req.reqId });
        }
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeoutId);
      generationSessionMap.delete(actualSessionId);
      activeAbortControllers.delete(abort);
      await decrementActive();
      if (!state.isEnded) {
        state.isEnded = true;
        res.end();
      }
    }
  });

  v1.post('/resume', generationLimiter, async (req, res): Promise<void> => {
    const body = req.body as { sessionId?: string };
    const { sessionId } = body;
    const session_token = sessionId ? req.cookies[`atomic_token_${sessionId}`] : undefined;
    const config = await extractConfig(req);
    if (!sessionId) { res.status(400).json({ error: 'sessionId is required' }); return; }
    if (!isValidSessionId(sessionId)) { res.status(400).json({ error: 'Invalid sessionId' }); return; }

    if (!(await verifySessionToken(sessionId, session_token))) {
      const meta = await loadMeta(sessionId);
      if (!meta) {
        res.status(410).json({ error: 'Session has expired or does not exist.' });
      } else {
        res.status(403).json({ error: 'Forbidden' });
      }
      return;
    }

    const meta = await loadMeta(sessionId);
    if (!meta) { res.status(404).json({ error: 'Session not found' }); return; }
    if (meta.status === 'complete') {
      const blueprint = await loadCheckpoint<Blueprint>(sessionId, 'blueprint');
      res.json({ blueprint });
      return;
    }

    const newActive = await incrementActive();
    if (newActive > MAX_CONCURRENT) {
      await decrementActive();
      res.status(429).json({ error: 'Server busy — try again shortly.' });
      return;
    }

    const abort = new AbortController();
    activeAbortControllers.add(abort);
    generationSessionMap.set(sessionId, abort);
    req.on('close', () => abort.abort());

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const { send, state } = createEventSender(res, abort, sessionId, MAX_TOKENS_PER_SESSION);

    // First event: give the client the correlation ID so it can tag all logs.
    send({ type: 'request_id', reqId: req.reqId });
    
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);

    const timeoutId = setTimeout(() => {
      if (!state.isEnded) {
        state.isEnded = true;
        abort.abort();
        const msg = `Generation timed out after ${Math.round(TIMEOUT_SAFE_MS/60000)} minutes`;
        res.write(`data: ${JSON.stringify({ type: 'error', message: msg, reqId: req.reqId })}\n\n`);
        res.end();
      }
    }, TIMEOUT_SAFE_MS);

    send({ type: 'resume_start', sessionId, resumeFrom: meta.last_checkpoint ?? 'start' });

    try {
      const queue = createQueue(8); // Per-request isolated concurrency
      await queueStorage.run(queue, async () => {
        const engineLogger = createEngineLogger({ reqId: req.reqId, sessionId });
        await engineLoggerStorage.run(engineLogger, async () => {
          await generateBlueprint(meta.prompt, config, send, meta.mode, sessionId, abort.signal, engineLogger);
        });
      });
    } catch (err: any) {
      if (!abort.signal.aborted) {
        req.log.error({ err }, 'Resume failed');
        if (err.name === 'StreamInterruptionError') {
          send({ type: 'stream_interrupted', message: err.message, reqId: req.reqId });
        } else {
          send({ type: 'error', message: err.message ?? 'Generation failed', reqId: req.reqId });
        }
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeoutId);
      generationSessionMap.delete(sessionId);
      activeAbortControllers.delete(abort);
      await decrementActive();
      if (!state.isEnded) {
        state.isEnded = true;
        res.end();
      }
    }
  });

  v1.post('/rerun-pillar', generationLimiter, inlineBlueprintLimiter, async (req, res): Promise<void> => {
    const body = req.body as { sessionId?: string; pillarName?: string; blueprint?: unknown };
    const { sessionId: incomingSessionId, pillarName, blueprint: inlineBlueprint } = body;
    const session_token = incomingSessionId ? req.cookies[`atomic_token_${incomingSessionId}`] : undefined;
    const config = await extractConfig(req);

    if (!pillarName) { res.status(400).json({ error: 'pillarName is required' }); return; }

    let sessionId = incomingSessionId;
    let existingBlueprint: Blueprint | null = null;
    let createdSessionToken: string | undefined;

    if (inlineBlueprint) {
      const parseResult = BlueprintSchema.safeParse(inlineBlueprint);
      if (!parseResult.success) {
        res.status(400).json({
          error: 'Invalid blueprint', issues: parseResult.error.issues
        });
        return;
      }
      sessionId = generateSessionId();
      // If saving an inline blueprint to a new session, skip token check as it's a novel session
      existingBlueprint = parseResult.data as Blueprint;
      await saveCheckpoint(sessionId!, 'blueprint', existingBlueprint);
      await saveCheckpoint(sessionId!, 'intent', existingBlueprint.intent);
      await Promise.all(Object.entries(existingBlueprint.pillars).map(([name, pillar]) =>
        saveCheckpoint(sessionId!, `pillar_${name}`, pillar)
      ));
      await saveCheckpoint(sessionId!, 'prosecutor', existingBlueprint.prosecutor);
      createdSessionToken = randomBytes(32).toString('hex');
      res.cookie(`atomic_token_${sessionId}`, createdSessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/api/v1',
      });
      const newSessionTokenHash = createHash('sha256').update(createdSessionToken).digest('hex');
      await saveMeta(sessionId, {
        id: sessionId, prompt: existingBlueprint.prompt, mode: 'fast',
        created_at: existingBlueprint.created_at, status: 'complete',
        last_checkpoint: 'blueprint', session_token: newSessionTokenHash
      });
      // Token delivered as httpOnly cookie in HTTP response headers before SSE body begins.
      // Client uses this cookie to authenticate future rerun / resume calls.
    } else if (!sessionId) {
      res.status(400).json({ error: 'sessionId or blueprint is required' }); return;
    } else if (!isValidSessionId(sessionId)) {
      res.status(400).json({ error: 'Invalid sessionId' }); return;
    } else if (!(await verifySessionToken(sessionId, session_token!))) {
      const meta = await loadMeta(sessionId);
      if (!meta) {
        res.status(410).json({ error: 'Session has expired or does not exist.' });
      } else {
        res.status(403).json({ error: 'Forbidden' });
      }
      return;
    }

    const intent = await loadCheckpoint<GovernorIntent>(sessionId, 'intent');
    if (!intent) { res.status(404).json({ error: 'Session intent not found' }); return; }

    const currentBlueprint = await loadCheckpoint<Blueprint>(sessionId, 'blueprint');
    if (!currentBlueprint) { res.status(404).json({ error: 'Blueprint not found' }); return; }

    const newActive = await incrementActive();
    if (newActive > MAX_CONCURRENT) {
      await decrementActive();
      res.status(429).json({ error: 'Server busy — try again shortly.' }); return;
    }

    const abort = new AbortController();
    activeAbortControllers.add(abort);
    if (sessionId) generationSessionMap.set(sessionId, abort);
    req.on('close', () => abort.abort());

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const { send, state } = createEventSender(res, abort, sessionId, MAX_TOKENS_PER_SESSION);

    // First event: give the client the correlation ID so it can tag all logs.
    send({ type: 'request_id', reqId: req.reqId });

    if (inlineBlueprint && createdSessionToken) {
      send({
        type: 'session_start',
        sessionId: sessionId!, // always non-null here: generated above for inline blueprints
        mode: 'fast',
      });
    }

    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': ping\n\n');
    }, 15_000);

    const timeoutId = setTimeout(() => {
      if (!state.isEnded) {
        state.isEnded = true;
        abort.abort();
        const msg = `Generation timed out after ${Math.round(TIMEOUT_RERUN_MS/60000)} minutes`;
        res.write(`data: ${JSON.stringify({ type: 'error', message: msg, reqId: req.reqId })}\n\n`);
        res.end();
      }
    }, TIMEOUT_RERUN_MS);

    send({ type: 'rerun_start', pillarName });

    if (!(pillarName in PILLAR_MAP)) {
      if (!state.isEnded) { res.write(`data: ${JSON.stringify({ type: 'error', message: 'Unknown pillar: ' + pillarName })}\n\n`); res.end(); }
      return;
    }

    const def = PILLAR_MAP[pillarName as PillarName];

    const rerunLogger = createEngineLogger({ reqId: req.reqId, sessionId });
    try {
      const queue = createQueue(8);
      await queueStorage.run(queue, async () => {
        await engineLoggerStorage.run(rerunLogger, async () => {
          let priorContext: string | undefined = undefined;
          if (pillarName !== 'planning') {
            const planningPillar = currentBlueprint.pillars['planning'];
            if (planningPillar) {
              priorContext = planningPillar.synthesizer_output
                || planningPillar.summary.master_record_md
                || (planningPillar.prosecutor_report ? JSON.stringify(planningPillar.prosecutor_report, null, 2) : undefined);
            }
          }
          if (['production', 'edge_cases', 'integration'].includes(pillarName)) {
            const securityPillar = currentBlueprint.pillars['security'];
            if (securityPillar) {
              const securityContext = securityPillar.synthesizer_output
                || securityPillar.summary.master_record_md
                || (securityPillar.prosecutor_report ? JSON.stringify(securityPillar.prosecutor_report, null, 2) : undefined);
              priorContext = (priorContext ? priorContext + '\n\n' : '') + securityContext;
            }
          }

          rerunLogger.info({ pillarName }, '[rerun-pillar] starting pillar run');
          const newPillarOutput = await runPillar(
            pillarName as PillarName, config, def.govSysPrompt, def.prosSysPrompt, def.staticGovPrompt, def.agents, intent, send, abort.signal, priorContext
          );
          if (abort.signal.aborted) return;
          await saveCheckpoint(sessionId, `pillar_${pillarName}`, newPillarOutput);
          rerunLogger.info({ pillarName }, '[rerun-pillar] pillar complete, running prosecutor');

          const updatedPillars = { ...currentBlueprint.pillars, [pillarName]: newPillarOutput } as unknown as Record<string, PillarOutput>;

          const newProsecutor = await runProsecutor(updatedPillars, config, send, abort.signal);
          if (abort.signal.aborted) return;
          await saveCheckpoint(sessionId, 'prosecutor', newProsecutor);
          rerunLogger.info({ pillarName }, '[rerun-pillar] prosecutor complete, running synthesizer');

          const newBlueprint = await runSynthesizer(
            currentBlueprint.prompt, config, intent, updatedPillars, newProsecutor, send, abort.signal
          );
          if (abort.signal.aborted) return;
          
          newBlueprint.generation_time_ms = currentBlueprint.generation_time_ms;
          newBlueprint.session_id = sessionId;

          await saveCheckpoint(sessionId, 'blueprint', newBlueprint);
          rerunLogger.info({ pillarName }, '[rerun-pillar] complete');
          // Auto-save updated blueprint to persistent history
          try { saveBlueprint(newBlueprint); } catch (e) { rerunLogger.error({ err: e }, '[blueprintStore] rerun auto-save failed'); }
          send({ type: 'rerun_complete', sessionId });
        });
      });
    } catch (err: any) {
      if (!abort.signal.aborted) {
        rerunLogger.error({ err, pillarName }, 'Pillar re-run failed');
        send({ type: 'error', message: err.message ?? 'Re-run failed', reqId: req.reqId });
      }
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeoutId);
      if (sessionId) generationSessionMap.delete(sessionId);
      activeAbortControllers.delete(abort);
      await decrementActive();
      if (!state.isEnded) {
        state.isEnded = true;
        res.end();
      }
    }
  });



  // ── Trigger.dev: async blueprint dispatch ────────────────────────────────
  // Only active when TRIGGER_SECRET_KEY is configured. Falls back gracefully.
  v1.post('/generate-async', apiLimiter, validateGenerateBody, async (req, res): Promise<void> => {
    const triggerKey = process.env.TRIGGER_SECRET_KEY;
    if (!triggerKey) {
      res.status(503).json({
        error: 'Trigger.dev not configured. Set TRIGGER_SECRET_KEY to enable async generation.',
        fallback: 'Use POST /api/v1/generate (SSE streaming) instead.',
      });
      return;
    }
    try {
      const { prompt, mode, provider, fastModel, proModel } = req.body as {
        prompt: string; mode?: string; provider?: string; fastModel?: string; proModel?: string;
      };
      const config = await extractConfig(req);
      const { tasks } = await import('@trigger.dev/sdk/v3');
      const { generateBlueprintTask: _generateBlueprintTask } = await import('./src/trigger/blueprint');
      const handle = await tasks.trigger<typeof _generateBlueprintTask>('generate-blueprint', {
        prompt,
        mode: (mode === 'safe' ? 'safe' : 'fast') as 'fast' | 'safe',
        provider: provider ?? config.provider,
        fastModel: fastModel ?? config.fastModel,
        proModel: proModel ?? config.proModel,
        apiKey: config.apiKey,
      });
      res.json({ runId: handle.id, publicAccessToken: handle.publicAccessToken });
    } catch (err: any) {
      req.log.error({ err }, 'generate-async dispatch failed');
      res.status(500).json({ error: err.message ?? 'Failed to dispatch async generation' });
    }
  });

  // ── Trigger.dev: run status proxy ────────────────────────────────────────
  v1.get('/run/:runId', async (req, res): Promise<void> => {
    const triggerKey = process.env.TRIGGER_SECRET_KEY;
    if (!triggerKey) {
      res.status(503).json({ error: 'Trigger.dev not configured' });
      return;
    }
    try {
      const { runs } = await import('@trigger.dev/sdk/v3');
      const run = await runs.retrieve(req.params.runId);
      res.json({
        runId: run.id,
        status: run.status,
        output: run.output,
        error: run.error,
      });
    } catch (err: any) {
      req.log.error({ err }, 'run status check failed');
      res.status(500).json({ error: err.message ?? 'Failed to retrieve run status' });
    }
  });

  // ── Blueprint HTML export renderer ──────────────────────────────────────────
  // Self-contained, print-ready HTML with embedded CSS. No external assets.

  async function renderBlueprintHtml(blueprint: Blueprint, notes: Record<string, string> = {}): Promise<string> {
    const { marked } = await import('marked');

    const productName = blueprint.intent?.product_name ?? 'Blueprint';
    const domain      = blueprint.intent?.domain ?? '';
    const date        = new Date(blueprint.created_at).toLocaleDateString('en-US', {
      month: 'long', day: 'numeric', year: 'numeric',
    });

    const sectionEntries = Object.entries(blueprint.sections);
    const tocHtml = sectionEntries.map(([key], i) => {
      const title = key.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return `<li><a href="#${key}"><span class="toc-num">0${i + 1}</span>${title}</a></li>`;
    }).join('\n');

    const sectionsHtml = await Promise.all(
      sectionEntries.map(async ([key, content], i) => {
        const title      = key.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const bodyHtml   = await marked(content as string);
        const note       = notes[key];
        const noteHtml   = note
          ? `<aside class="section-note"><strong>Note:</strong> ${note.replace(/</g, '&lt;')}</aside>`
          : '';
        return `
    <section id="${key}" class="bp-section">
      <h2><span class="sec-num">0${i + 1}</span>${title}</h2>
      <div class="prose">${bodyHtml}</div>
      ${noteHtml}
    </section>`;
      })
    );

    const agentCount = Object.values(blueprint.pillars)
      .reduce((n, p: any) => n + (p?.agents?.length ?? 0), 0);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${productName} — Atomic Blueprint</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --brand:   #6b0c22;
      --brand-lt:#f3e8ec;
      --gray-50: #f9fafb;
      --gray-200:#e5e7eb;
      --gray-500:#6b7280;
      --gray-800:#1f2937;
      --gray-900:#111827;
      --radius:  8px;
      font-size: 16px;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      color: var(--gray-800);
      background: #fff;
      line-height: 1.65;
      max-width: 860px;
      margin: 0 auto;
      padding: 48px 32px 96px;
    }

    /* ── Cover ── */
    .cover {
      border-bottom: 2px solid var(--brand);
      padding-bottom: 40px;
      margin-bottom: 48px;
    }
    .cover .logo {
      font-family: 'Courier New', Courier, monospace;
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.3em;
      color: var(--gray-500);
      text-transform: uppercase;
      margin-bottom: 24px;
    }
    .cover h1 {
      font-size: 2.4rem;
      font-weight: 800;
      color: var(--gray-900);
      line-height: 1.1;
      margin-bottom: 8px;
    }
    .cover .domain-tag {
      display: inline-block;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--brand);
      background: var(--brand-lt);
      padding: 3px 10px;
      border-radius: 99px;
      margin-bottom: 20px;
    }
    .cover blockquote {
      border-left: 3px solid var(--brand);
      padding-left: 16px;
      color: var(--gray-500);
      font-style: italic;
      font-size: 0.95rem;
      margin: 20px 0;
    }
    .cover-meta {
      display: flex;
      gap: 24px;
      flex-wrap: wrap;
      font-size: 0.8rem;
      color: var(--gray-500);
      margin-top: 20px;
    }
    .cover-meta span { display: flex; align-items: center; gap: 6px; }
    .cover-meta strong { color: var(--gray-800); }

    /* ── ToC ── */
    .toc {
      background: var(--gray-50);
      border: 1px solid var(--gray-200);
      border-radius: var(--radius);
      padding: 24px 28px;
      margin-bottom: 56px;
      page-break-inside: avoid;
    }
    .toc h2 {
      font-size: 0.7rem;
      font-weight: 700;
      letter-spacing: 0.15em;
      text-transform: uppercase;
      color: var(--gray-500);
      margin-bottom: 14px;
    }
    .toc ol { padding-left: 0; list-style: none; counter-reset: none; }
    .toc li { margin: 6px 0; }
    .toc a {
      color: var(--gray-800);
      text-decoration: none;
      font-size: 0.9rem;
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .toc a:hover { color: var(--brand); }
    .toc-num {
      font-family: monospace;
      font-size: 0.75rem;
      color: var(--brand);
      min-width: 24px;
    }

    /* ── Sections ── */
    .bp-section { margin-bottom: 64px; }
    .bp-section h2 {
      font-size: 1.65rem;
      font-weight: 800;
      color: var(--gray-900);
      display: flex;
      align-items: baseline;
      gap: 14px;
      margin-bottom: 24px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--gray-200);
    }
    .sec-num {
      font-family: 'Courier New', Courier, monospace;
      font-size: 1rem;
      color: var(--brand);
    }

    /* ── Prose ── */
    .prose h1, .prose h2, .prose h3, .prose h4 {
      font-weight: 700; color: var(--gray-900); margin: 1.6em 0 0.6em;
    }
    .prose h3 { font-size: 1.1rem; }
    .prose h4 { font-size: 1rem; color: var(--gray-500); }
    .prose p  { margin-bottom: 1em; }
    .prose ul, .prose ol { margin: 0.75em 0 1em 1.5em; }
    .prose li { margin-bottom: 0.35em; }
    .prose code {
      font-family: 'Courier New', Courier, monospace;
      font-size: 0.85em;
      background: var(--gray-50);
      border: 1px solid var(--gray-200);
      border-radius: 4px;
      padding: 1px 5px;
      color: var(--brand);
    }
    .prose pre {
      background: var(--gray-50);
      border: 1px solid var(--gray-200);
      border-radius: var(--radius);
      padding: 16px 20px;
      overflow-x: auto;
      margin: 1em 0;
    }
    .prose pre code {
      background: none; border: none; padding: 0; color: var(--gray-800);
      font-size: 0.82rem;
    }
    .prose blockquote {
      border-left: 3px solid var(--brand);
      padding: 4px 0 4px 16px;
      color: var(--gray-500);
      font-style: italic;
      margin: 1em 0;
    }
    .prose table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 0.9rem; }
    .prose th { background: var(--gray-50); font-weight: 700; padding: 8px 12px; border: 1px solid var(--gray-200); text-align: left; }
    .prose td { padding: 8px 12px; border: 1px solid var(--gray-200); vertical-align: top; }
    .prose a { color: var(--brand); text-decoration: none; }
    .prose strong { font-weight: 700; color: var(--gray-900); }

    /* ── Notes ── */
    .section-note {
      margin-top: 20px;
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-radius: var(--radius);
      padding: 12px 16px;
      font-size: 0.85rem;
      color: #92400e;
    }

    /* ── Footer ── */
    footer {
      margin-top: 80px;
      padding-top: 24px;
      border-top: 1px solid var(--gray-200);
      font-size: 0.75rem;
      color: var(--gray-500);
      display: flex;
      justify-content: space-between;
    }

    /* ── Print ── */
    @media print {
      body { max-width: 100%; padding: 0; font-size: 11pt; }
      .cover { padding-bottom: 24pt; }
      .toc   { page-break-after: always; }
      .bp-section { page-break-inside: avoid; }
      .bp-section h2 { page-break-after: avoid; }
      .prose pre { page-break-inside: avoid; white-space: pre-wrap; }
      a { color: inherit; text-decoration: none; }
    }
  </style>
</head>
<body>

  <!-- Cover -->
  <header class="cover">
    <div class="logo">Atomic Blueprint</div>
    <h1>${productName.replace(/</g, '&lt;')}</h1>
    ${domain ? `<span class="domain-tag">${domain.replace(/</g, '&lt;')}</span>` : ''}
    <blockquote>${blueprint.prompt.replace(/</g, '&lt;')}</blockquote>
    <div class="cover-meta">
      <span>Generated <strong>${date}</strong></span>
      <span>Quality Score <strong>${blueprint.quality_score}/100</strong></span>
      <span>Tokens <strong>${Math.round((blueprint.total_tokens ?? 0) / 1000)}k</strong></span>
      <span>Agents <strong>${agentCount}</strong></span>
      ${blueprint.generation_time_ms ? `<span>Time <strong>${(blueprint.generation_time_ms / 1000).toFixed(1)}s</strong></span>` : ''}
    </div>
  </header>

  <!-- Table of Contents -->
  <nav class="toc">
    <h2>Table of Contents</h2>
    <ol>${tocHtml}</ol>
  </nav>

  <!-- Sections -->
  ${sectionsHtml.join('\n')}

  <footer>
    <span>Generated by <strong>Atomic</strong> — Production-grade system blueprints</span>
    <span>${new Date().toISOString().split('T')[0]}</span>
  </footer>

</body>
</html>`;
  }

  // ── Blueprint persistence endpoints ──────────────────────────────────────────

  // GET /api/v1/blueprints/tags — all distinct tags with counts
  v1.get('/blueprints/tags', apiLimiter, (req, res): void => {
    try {
      const tags = listAllTags();
      res.json({ tags });
    } catch (err: any) {
      log.error({ err }, '[blueprints] tags list failed');
      res.status(500).json({ error: 'Failed to list tags' });
    }
  });

  // PATCH /api/v1/blueprints/:id/tags — { tags: string[] }
  v1.patch('/blueprints/:id/tags', apiLimiter, (req, res): void => {
    try {
      const { tags } = req.body ?? {};
      if (!Array.isArray(tags)) {
        res.status(400).json({ error: 'tags must be an array of strings' }); return;
      }
      const ok = setTags(req.params.id!, tags as string[]);
      if (!ok) { res.status(404).json({ error: 'Blueprint not found' }); return; }
      res.json({ ok: true });
    } catch (err: any) {
      log.error({ err }, '[blueprints] tags update failed');
      res.status(500).json({ error: 'Failed to update tags' });
    }
  });

  // GET /api/v1/blueprints — paginated list with full filter/sort support
  v1.get('/blueprints', apiLimiter, (req, res): void => {
    try {
      const limit       = Math.min(parseInt(String(req.query.limit  ?? '20'), 10), 100);
      const offset      = Math.max(parseInt(String(req.query.offset ?? '0'),  10), 0);
      const search      = typeof req.query.search      === 'string' ? req.query.search      : undefined;
      const tag         = typeof req.query.tag         === 'string' ? req.query.tag         : undefined;
      const sort        = typeof req.query.sort        === 'string' ? req.query.sort        : 'newest';
      const date_after  = typeof req.query.date_after  === 'string' ? req.query.date_after  : undefined;
      const quality_min = typeof req.query.quality_min === 'string' ? parseInt(req.query.quality_min, 10) : undefined;
      // Multi-tenancy: workspace comes from header or cookie, defaults to 'default'
      const workspace_id = (req.headers['x-workspace-id'] as string)
                        || req.cookies['atomic_workspace']
                        || 'default';
      const result = listBlueprints({
        limit, offset, search, tag,
        sort: sort as 'newest' | 'oldest' | 'quality',
        quality_min: quality_min && !isNaN(quality_min) ? quality_min : undefined,
        date_after,
        workspace_id,
      });
      res.json(result);
    } catch (err: any) {
      log.error({ err }, '[blueprints] list failed');
      res.status(500).json({ error: 'Failed to list blueprints' });
    }
  });

  // POST /api/v1/sessions/:id/abort — terminate an active generation by session ID
  v1.post('/sessions/:id/abort', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    if (!isValidSessionId(id)) {
      res.status(400).json({ error: 'Invalid session id' });
      return;
    }
    const controller = generationSessionMap.get(id);
    if (!controller) {
      res.status(404).json({ error: 'No active generation found for this session' });
      return;
    }
    controller.abort();
    generationSessionMap.delete(id);
    log.info({ sessionId: id }, '[atomic] session aborted via API');
    res.json({ ok: true, aborted: true });
  });

  // ── Agentic Core endpoints (v2.1) ──────────────────────────────────────────
  // Plan mode (OpenAI Codex planning-first pattern), mid-run steering (Kimi
  // mid-flight correction), stage snapshots with undo (Kilo Code), and
  // per-pipeline verdict/budget configuration (OpenDesign composite verdict).

  // POST /api/v1/generate-plan — decompose a prompt into a milestone plan.
  // The plan is stored as a first-class checkpoint and drives the next
  // blueprint run in this session (milestone.started/passed events).
  v1.post('/generate-plan', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { prompt } = req.body ?? {};
      if (!prompt || typeof prompt !== 'string' || prompt.trim().length === 0) {
        res.status(400).json({ error: 'prompt is required.' });
        return;
      }
      if (prompt.length > 4_000) {
        res.status(400).json({ error: 'Prompt exceeds 4000 characters.' });
        return;
      }
      const config = await extractConfig(req);
      const id = (req.body?.sessionId as string | undefined) ?? generateSessionId();
      if (!isValidSessionId(id)) {
        res.status(400).json({ error: 'Invalid sessionId' });
        return;
      }
      const controller = new AbortController();
      generationSessionMap.set(id, controller);
      try {
        const plan = await generatePlan(prompt.trim(), config, controller.signal);
        const version = await savePlan(id, plan);
        res.json({ ok: true, sessionId: id, plan, version });
      } finally {
        generationSessionMap.delete(id);
      }
    } catch (err) {
      const isAbort = (err as { name?: string })?.name === 'AbortError' ||
        (err as Error)?.message === 'The operation was aborted.';
      log.error({ err }, '[atomic] generate-plan failed');
      res.status(isAbort ? 499 : 500).json({ error: 'Plan generation failed' });
    }
  });

  // POST /api/v1/sessions/:id/steer — queue a mid-run course correction.
  // The blueprint pipeline drains queued steers at milestone boundaries and
  // emits steer.received events (Kimi mid-flight correction pattern).
  v1.post('/sessions/:id/steer', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    if (!isValidSessionId(id)) {
      res.status(400).json({ error: 'Invalid session id' });
      return;
    }
    const { message } = req.body ?? {};
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'message is required.' });
      return;
    }
    if (message.length > 1_000) {
      res.status(400).json({ error: 'Steer message exceeds 1000 characters.' });
      return;
    }
    const steer = await steerSession(id, message.trim());
    res.status(201).json({ ok: true, steer });
  });

  // GET /api/v1/sessions/:id/steers — steering history (pending + applied).
  v1.get('/sessions/:id/steers', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    if (!isValidSessionId(id)) {
      res.status(400).json({ error: 'Invalid session id' });
      return;
    }
    const history = await listSteerHistory(id);
    res.json({ ok: true, steers: history });
  });

  // GET /api/v1/sessions/:id/plan — retrieve the stored execution plan.
  v1.get('/sessions/:id/plan', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    if (!isValidSessionId(id)) {
      res.status(400).json({ error: 'Invalid session id' });
      return;
    }
    const plan = await loadPlan(id);
    if (!plan) {
      res.status(404).json({ error: 'No plan stored for this session' });
      return;
    }
    res.json({ ok: true, plan });
  });

  // GET /api/v1/sessions/:id/snapshots — list content-addressed stage
  // snapshots (Kilo Code pattern) for rollback and audit.
  v1.get('/sessions/:id/snapshots', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    if (!isValidSessionId(id)) {
      res.status(400).json({ error: 'Invalid session id' });
      return;
    }
    const snapshots = await listStageSnapshots(id);
    res.json({ ok: true, snapshots });
  });

  // POST /api/v1/sessions/:id/undo — roll back to the latest stage snapshot
  // (per-message revert semantics).
  v1.post('/sessions/:id/undo', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    if (!isValidSessionId(id)) {
      res.status(400).json({ error: 'Invalid session id' });
      return;
    }
    const snapshot = await undoLatestStage(id);
    if (!snapshot) {
      res.status(404).json({ error: 'No stage snapshot to undo' });
      return;
    }
    res.json({ ok: true, snapshot });
  });

  // ── Elicitation endpoints (Codex elicitation + Kilo Code question tool) ──
  // POST /api/v1/sessions/:id/answer-elicitation — answer model-asked
  // clarifying questions. The pipeline asks via askElicitation; the UI
  // answers here. Unanswered questions auto-deny after their deadline.
  v1.post('/sessions/:id/answer-elicitation', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    if (!isValidSessionId(id)) {
      res.status(400).json({ error: 'Invalid session id' });
      return;
    }
    const body = req.body ?? {};
    const answers = Array.isArray(body.answers)
      ? (body.answers as Array<{ id?: string; answer?: string }>).filter(a => a && a.id && typeof a.answer === 'string')
      : [];
    if (answers.length === 0) {
      res.status(400).json({ error: 'answers must be a non-empty array of { id, answer }' });
      return;
    }
    const answered = await answerElicitations(id, answers.map(a => ({ id: a.id!, answer: a.answer! }))); // eslint-disable-line @typescript-eslint/no-non-null-assertion
    res.json({ ok: true, answered });
  });

  // GET /api/v1/sessions/:id/elicitations — pending + answered model-asked
  // questions (typed: clarify/confirm/choose with options).
  v1.get('/sessions/:id/elicitations', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    if (!isValidSessionId(id)) {
      res.status(400).json({ error: 'Invalid session id' });
      return;
    }
    const pending = await pendingElicitations(id);
    const history = await listElicitationHistory(id);
    res.json({ ok: true, pending: pending.elicitations, has_pending: pending.has_pending, history });
  });

  // ── Permission endpoints (Codex execpolicy + Kilo Code permission) ──────
  // GET /api/v1/sessions/:id/permissions — effective permission tier per
  // pipeline operation (session overrides merged over global over defaults).
  v1.get('/sessions/:id/permissions', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    if (!isValidSessionId(id)) {
      res.status(400).json({ error: 'Invalid session id' });
      return;
    }
    const tiers = await listEffectiveTiers(id);
    res.json({ ok: true, tiers });
  });

  // PATCH /api/v1/sessions/:id/permissions — set the permission tier for one
  // pipeline operation. Tiers: full-auto (default) | ask | deny.
  v1.patch('/sessions/:id/permissions', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    if (!isValidSessionId(id)) {
      res.status(400).json({ error: 'Invalid session id' });
      return;
    }
    const body = req.body ?? {};
    const { operation, tier } = body;
    const validOperations = ['generate', 'repair', 'rerun-pillar', 'steer', 'plan', 'compact', 'verifier-loop', 'snapshot', 'undo'] as const;
    const validTiers = ['full-auto', 'ask', 'deny'] as const;
    if (!validOperations.includes(operation) || !validTiers.includes(tier)) {
      res.status(400).json({ error: 'operation must be one of ' + validOperations.join(', ') + ' and tier one of ' + validTiers.join(', ') });
      return;
    }
    const resolved = await setOperationTier(id, operation, tier);
    res.json({ ok: true, operation, tier: resolved });
  });

  // ── Quality ledger endpoints (OpenDesign conformance/ratchet) ──────────
  // GET /api/v1/sessions/:id/quality/:pipeline — verifier-round ledger +
  // drift summary for one pipeline (composite history, ratchet high-water
  // mark, average, shipped rounds).
  v1.get('/sessions/:id/quality/:pipeline', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    const pipeline = (req.params as { pipeline?: string }).pipeline;
    if (!isValidSessionId(id) || !pipeline) {
      res.status(400).json({ error: 'Invalid session id or pipeline name' });
      return;
    }
    const entries = await listLedger({ session: id, pipeline });
    res.json({ ok: true, pipeline, entries, summary: summarizeLedger(entries) });
  });

  // ── Run summary endpoints (Kilo Code kilo-telemetry pattern) ───────────
  // GET /api/v1/sessions/:id/runs — structured performance summary of every
  // run in the session (duration, tokens, estimated cost, verdict, drift).
  v1.get('/sessions/:id/runs', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    if (!isValidSessionId(id)) {
      res.status(400).json({ error: 'Invalid session id' });
      return;
    }
    const runs = await listRunSummaries(id);
    res.json({ ok: true, runs });
  });

  // ── Engine plugin endpoints (v2.3 — OpenDesign plugin platform parity) ─
  // POST /api/v1/plugins/doctor — validate an arbitrary manifest without
  // installing it (OpenDesign doctor step for untrusted sources).
  v1.post('/plugins/doctor', apiLimiter, (req, res): void => {
    const body = (req.body ?? {}) as { manifest?: unknown };
    if (!body.manifest || typeof body.manifest !== 'object') {
      res.status(400).json({ ok: false, error: 'A manifest object is required' });
      return;
    }
    const result = validateManifest(body.manifest);
    res.json({ ok: result.ok, errors: result.errors, warnings: result.warnings });
  });
  // POST /api/v1/plugins/install — validate + register an untrusted manifest
  // (trust remains restricted until grants are issued per-session).
  v1.post('/plugins/install', apiLimiter, (req, res): void => {
    const body = (req.body ?? {}) as { manifest?: unknown };
    if (!body.manifest || typeof body.manifest !== 'object') {
      res.status(400).json({ ok: false, error: 'A manifest object is required' });
      return;
    }
    const { entry, doctor } = installPlugin(body.manifest);
    if (!entry) {
      res.status(400).json({ ok: false, errors: doctor.errors, warnings: doctor.warnings });
      return;
    }
    res.json({ ok: true, plugin: { id: entry.manifest.id, digest: entry.digest, valid: doctor.ok, warnings: doctor.warnings } });
  });
  // DELETE /api/v1/plugins/:id — remove an installed plugin (built-ins protected).
  v1.delete('/plugins/:id', apiLimiter, (req, res): void => {
    const id = (req.params as { id: string }).id;
    const entry = getPlugin(id);
    if (!entry) { res.status(404).json({ error: 'Plugin not found' }); return; }
    if (!uninstallPlugin(id)) {
      res.status(400).json({ error: 'Cannot remove built-in plugins; unregister via the registry' });
      return;
    }
    res.json({ ok: true, removed: id });
  });
  // GET /api/v1/plugins — every engine plugin (built-ins + installed), with
  // digest provenance and doctor status. Prompt bodies are hidden.
  v1.get('/plugins', apiLimiter, (req, res): void => {
    res.json({ ok: true, plugins: listPlugins().map((p) => ({ id: p.manifest.id, manifest: getPublicPlugin(p.manifest.id)?.manifest, digest: p.digest, source: p.source, valid: p.doctor.ok, warnings: p.doctor.warnings })) });
  });
  // GET /api/v1/plugins/:id — one plugin (public view) + trust summary.
  v1.get('/plugins/:id', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    const entry = getPlugin(id);
    if (!entry) { res.status(404).json({ error: 'Plugin not found' }); return; }
    const session = (req.query as { session?: string }).session;
    const view = session && isValidSessionId(session) ? await trustView(session, id, entry.manifest) : undefined;
    res.json({ ok: true, manifest: publicManifest(entry.manifest), digest: entry.digest, source: entry.source, valid: entry.doctor.ok, warnings: entry.doctor.warnings, trust: view });
  });
  // GET /api/v1/plugins/:id/pack — installable skill pack (SKILL.md +
  // .claude-plugin/plugin.json + AGENTS.md) for Codex/Claude Code/OpenCode/Kilo Code.
  v1.get('/plugins/:id/pack', apiLimiter, (req, res): void => {
    const id = (req.params as { id: string }).id;
    const pack = generateSkillPack(id);
    if (!pack) { res.status(404).json({ error: 'Skill pack not found for this plugin' }); return; }
    res.json({ ok: true, pack_id: pack.id, files: pack.files });
  });
  // GET /api/v1/skill-packs — list of generated skill pack ids.
  v1.get('/skill-packs', apiLimiter, (req, res): void => {
    res.json({ ok: true, packs: listSkillPacks() });
  });
  // POST /api/v1/plugins/:id/run — run a plugin's pipeline in a session with
  // the operator's API key. Capability gates are enforced per stage via the
  // trust store (restricted plugins run, but never touch blueprint data).
  v1.post('/plugins/:id/run', apiLimiter, async (req, res): Promise<void> => {
    try {
      const id = (req.params as { id: string }).id;
      const entry = getPlugin(id);
      if (!entry) { res.status(404).json({ error: 'Plugin not found' }); return; }
      const body = (req.body ?? {}) as { session?: string; inputs?: Record<string, unknown> };
      const session = body.session;
      if (!session || !isValidSessionId(session)) {
        res.status(400).json({ error: 'A valid session id is required' });
        return;
      }
      const config = resolveConfig({});
      const blueprint = await loadCheckpoint<Blueprint>(session, 'blueprint');
      const outcome = await runPluginPipeline({
        sessionId: session,
        manifest: entry.manifest,
        config,
        inputs: body.inputs ?? {},
        blueprintText: blueprint ? (typeof blueprint === 'string' ? blueprint : JSON.stringify(blueprint).slice(0, 60_000)) : undefined,
      });
      res.json({ ok: true, run_id: `${id}:${session.slice(0, 8)}`, ...outcome });
    } catch (err: any) {
      log.error({ err }, '[plugin] run failed');
      res.status(500).json({ error: 'Plugin run failed' });
    }
  });
  // GET /api/v1/plugins/:id/trust — effective capability grants for a session.
  v1.get('/plugins/:id/trust', apiLimiter, async (req, res): Promise<void> => {
    const id = (req.params as { id: string }).id;
    const entry = getPlugin(id);
    if (!entry) { res.status(404).json({ error: 'Plugin not found' }); return; }
    const session = (req.query as { session?: string }).session;
    if (!session || !isValidSessionId(session)) {
      res.status(400).json({ error: 'A valid session id is required' });
      return;
    }
    res.json({ ok: true, plugin_id: id, ...await trustView(session, id, entry.manifest) });
  });
  // PATCH /api/v1/plugins/:id/trust — grant capabilities for a session
  // (digest-bound; re-grant required after manifest content changes).
  v1.patch('/plugins/:id/trust', apiLimiter, async (req, res): Promise<void> => {
    try {
      const id = (req.params as { id: string }).id;
      const entry = getPlugin(id);
      if (!entry) { res.status(404).json({ error: 'Plugin not found' }); return; }
      const body = (req.body ?? {}) as { session?: string; grant?: string[]; revoke?: boolean };
      const session = body.session;
      if (!session || !isValidSessionId(session)) {
        res.status(400).json({ error: 'A valid session id is required' });
        return;
      }
      if (body.revoke) {
        await revokeTrust(session, id);
        res.json({ ok: true, plugin_id: id, granted: [] });
        return;
      }
      if (!Array.isArray(body.grant) || body.grant.length === 0) {
        res.status(400).json({ error: 'grant must be a non-empty capability array, or set revoke=true' });
        return;
      }
      const granted = await grantTrust(session, id, body.grant as GrantableCapability[], entry.manifest);
      res.json({ ok: true, plugin_id: id, granted });
    } catch (err: any) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  // DELETE /api/v1/plugins/:id/trust — revoke all grants for a session.
  v1.delete('/plugins/:id/trust', apiLimiter, async (req, res): Promise<void> => {
    try {
      const id = (req.params as { id: string }).id;
      if (!getPlugin(id)) { res.status(404).json({ error: 'Plugin not found' }); return; }
      const session = (req.query as { session?: string }).session;
      if (!session || !isValidSessionId(session)) {
        res.status(400).json({ error: 'A valid session id is required' });
        return;
      }
      await revokeTrust(session, id);
      res.json({ ok: true, plugin_id: id, granted: [] });
    } catch (err: any) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  // GET /api/v1/pipelines/:name/config — current verdict/budget defaults for
  // a pipeline (OpenDesign composite verdict configuration).
  v1.get('/pipelines/:name/config', apiLimiter, async (req, res): Promise<void> => {
    const name = (req.params as { name: string }).name;
    const overrides = await loadCheckpoint<PipelineDefaults>(`pipelineConfig:${name}`, 'config');
    const config = overrides ?? resolvePipelineDefaults(name);
    res.json({ ok: true, name, config });
  });

  // PATCH /api/v1/pipelines/:name/config — override verdict/budget thresholds
  // at runtime. Overrides are stored per-pipeline in the checkpoint store so
  // tuned values survive across restarts while fresh defaults live in code.
  v1.patch('/pipelines/:name/config', apiLimiter, async (req, res): Promise<void> => {
    try {
      const name = (req.params as { name: string }).name;
      const body = req.body ?? {};
      if (typeof name !== 'string' || name.trim().length === 0) {
        res.status(400).json({ error: 'Pipeline name is required.' });
        return;
      }
      if (body.verdict !== undefined && (typeof body.verdict !== 'object' || !body.verdict || Array.isArray(body.verdict))) {
        res.status(400).json({ error: 'verdict must be an object.' });
        return;
      }
      if (body.budget !== undefined && (typeof body.budget !== 'object' || !body.budget || Array.isArray(body.budget))) {
        res.status(400).json({ error: 'budget must be an object.' });
        return;
      }
      // Normalise snake_case aliases and top-level convenience fields so clients
      // can PATCH either { verdict: { score_threshold: 90 } } or
      // { score_threshold: 90, max_steps: 40 }.
      const verdict: { [k: string]: unknown } = body.verdict ?? {};
      if (typeof verdict.score_threshold === 'number') verdict.scoreThreshold = verdict.score_threshold;
      if (typeof body.score_threshold === 'number') verdict.scoreThreshold = body.score_threshold;
      if (typeof body.max_must_fix === 'number') verdict.maxMustFix = body.max_must_fix;
      if (typeof body.max_rounds === 'number') verdict.maxRounds = body.max_rounds;
      delete verdict.score_threshold;
      const budget: { [k: string]: unknown } = body.budget ?? {};
      if (typeof budget.max_steps === 'number') budget.maxSteps = budget.max_steps;
      if (typeof budget.max_tokens === 'number') budget.maxTokens = budget.max_tokens;
      if (typeof body.max_steps === 'number') budget.maxSteps = body.max_steps;
      if (typeof body.max_tokens === 'number') budget.maxTokens = body.max_tokens;
      delete budget.max_steps;
      delete budget.max_tokens;
      const current = resolvePipelineDefaults(name);
      const override: PipelineDefaults = {
        name: current.name,
        verdict: { ...current.verdict, ...(verdict as object ?? {}) },
        budget: { ...current.budget, ...(budget as object ?? {}) },
      };
      await saveCheckpoint(`pipelineConfig:${name}`, 'config', override);
      res.json({ ok: true, name, config: override });
    } catch (err: any) {
      log.error({ err }, '[atomic] pipeline config patch failed');
      res.status(500).json({ error: 'Failed to update pipeline config' });
    }
  });

  // GET /api/v1/blueprints/:id — full blueprint + notes
  v1.get('/blueprints/:id', apiLimiter, (req, res): void => {
    try {
      const saved = getBlueprint(req.params.id!);
      if (!saved) { res.status(404).json({ error: 'Blueprint not found' }); return; }
      res.json(saved);
    } catch (err: any) {
      log.error({ err }, '[blueprints] get failed');
      res.status(500).json({ error: 'Failed to get blueprint' });
    }
  });

  // DELETE /api/v1/blueprints/:id
  v1.delete('/blueprints/:id', apiLimiter, (req, res): void => {
    try {
      const deleted = deleteBlueprintRecord(req.params.id!);
      if (!deleted) { res.status(404).json({ error: 'Blueprint not found' }); return; }
      res.json({ ok: true });
    } catch (err: any) {
      log.error({ err }, '[blueprints] delete failed');
      res.status(500).json({ error: 'Failed to delete blueprint' });
    }
  });

  // PATCH /api/v1/blueprints/:id/rating — { rating: 1-5 | null }
  v1.patch('/blueprints/:id/rating', apiLimiter, (req, res): void => {
    try {
      const { rating } = req.body ?? {};
      if (rating !== null && rating !== undefined) {
        const r = Number(rating);
        if (!Number.isInteger(r) || r < 1 || r > 5) {
          res.status(400).json({ error: 'rating must be an integer 1–5 or null' }); return;
        }
      }
      const ok = setRating(req.params.id!, rating ?? null);
      if (!ok) { res.status(404).json({ error: 'Blueprint not found' }); return; }
      res.json({ ok: true });
    } catch (err: any) {
      log.error({ err }, '[blueprints] rating update failed');
      res.status(400).json({ error: err.message ?? 'Failed to update rating' });
    }
  });

  // PATCH /api/v1/blueprints/:id/note — { sectionKey: string, note: string }
  v1.patch('/blueprints/:id/note', apiLimiter, (req, res): void => {
    try {
      const { sectionKey, note } = req.body ?? {};
      if (!sectionKey || typeof sectionKey !== 'string') {
        res.status(400).json({ error: 'sectionKey is required' }); return;
      }
      const ok = setNote(req.params.id!, sectionKey, typeof note === 'string' ? note : '');
      if (!ok) { res.status(404).json({ error: 'Blueprint not found' }); return; }
      res.json({ ok: true });
    } catch (err: any) {
      log.error({ err }, '[blueprints] note update failed');
      res.status(500).json({ error: 'Failed to update note' });
    }
  });

  // GET /api/v1/blueprints/:id/export?format=md|json|html
  v1.get('/blueprints/:id/export', apiLimiter, async (req, res): Promise<void> => {
    try {
      const saved  = getBlueprint(req.params.id!);
      if (!saved) { res.status(404).json({ error: 'Blueprint not found' }); return; }
      const format = String(req.query.format ?? 'md');
      const id     = saved.id;
      const name   = (saved.product_name ?? 'blueprint').toLowerCase().replace(/\s+/g, '-');

      if (format === 'json') {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}-${id.slice(0, 8)}.json"`);
        res.send(JSON.stringify(saved.blueprint, null, 2));
        return;
      }
      if (format === 'md') {
        let md = `# ${saved.product_name ?? 'Blueprint'}\n\n`;
        md += `**Generated:** ${new Date(saved.created_at).toLocaleString()}\n`;
        md += `**Quality Score:** ${saved.quality_score}/100\n\n`;
        md += `> ${saved.prompt}\n\n---\n\n`;
        Object.entries(saved.blueprint.sections).forEach(([key, content]) => {
          const title = key.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          md += `## ${title}\n\n${content}\n\n`;
          if (saved.notes[key]) md += `> **Note:** ${saved.notes[key]}\n\n`;
        });
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}-${id.slice(0, 8)}.md"`);
        res.send(md);
        return;
      }
      if (format === 'html') {
        const html = await renderBlueprintHtml(saved.blueprint, saved.notes);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}-${id.slice(0, 8)}.html"`);
        res.send(html);
        return;
      }
      res.status(400).json({ error: 'format must be md, json, or html' });
    } catch (err: any) {
      log.error({ err }, '[blueprints] export failed');
      res.status(500).json({ error: 'Export failed' });
    }
  });

  // ── Unified pipeline dispatch (used by the Landing page pipeline selector) ─
  // POST /api/v1/generate-pipeline
  // Body: { prompt, pipelineType, mode }
  // Streams SSE events for any non-blueprint pipeline selected on the landing page.
  v1.post('/generate-pipeline', generationLimiter, async (req, res): Promise<void> => {
    const { prompt, pipelineType, mode } = req.body as {
      prompt?: string;
      pipelineType?: string;
      mode?: string;
    };

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    if (!pipelineType || !['feature-creator', 'tool-builder', 'agent-builder'].includes(pipelineType)) {
      res.status(400).json({ error: 'pipelineType must be one of: feature-creator, tool-builder, agent-builder' });
      return;
    }

    const config = await extractConfig(req);
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);
    const send = (event: Record<string, unknown>) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    try {
      const trimmedPrompt = prompt.trim();

      if (pipelineType === 'feature-creator') {
        const { runFeatureCreatorPipeline } = await import('./src/pipelines/feature-creator/index');
        const blueprint = await runFeatureCreatorPipeline(
          {
            featureDescription: trimmedPrompt,
            codebaseContext: 'Not provided — infer from the feature description.',
            targetComplexity: 'medium',
          },
          config, send as (e: unknown) => void, abort.signal
        );
        send({ type: 'complete', blueprint });

      } else if (pipelineType === 'tool-builder') {
        const { runToolBuilderPipeline } = await import('./src/pipelines/tool-builder/index');
        const blueprint = await runToolBuilderPipeline(
          {
            toolConcept:  trimmedPrompt,
            targetAgent:  'Not specified — infer from the tool concept.',
            constraints:  mode === 'safe' ? 'Prioritise safety and minimal permissions.' : undefined,
          },
          config, send as (e: unknown) => void, abort.signal
        );
        send({ type: 'complete', blueprint });

      } else {
        // agent-builder
        const { runAgentBuilderPipeline } = await import('./src/pipelines/agent-builder/index');
        const blueprint = await runAgentBuilderPipeline(
          {
            agentRole:         trimmedPrompt,
            agentCapabilities: 'Infer from the agent role description.',
            agentConstraints:  mode === 'safe' ? 'Operate with minimal permissions and require human confirmation for irreversible actions.' : 'Infer from the agent role description.',
          },
          config, send as (e: unknown) => void, abort.signal
        );
        send({ type: 'complete', blueprint });
      }

    } catch (err: unknown) {
      const e = err as { message?: string };
      req.log.error({ err }, `[generate-pipeline:${pipelineType}] failed`);
      send({ type: 'error', message: e?.message ?? 'Pipeline failed' });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });

  // ── REST generation endpoints (for MCP and programmatic clients) ─────────

  // POST /api/v1/generate-start
  // Starts a blueprint generation in the background and returns { sessionId } immediately.
  // Unlike POST /api/v1/generate (SSE-streaming), this endpoint is suitable for REST clients
  // (MCP tools, CI pipelines) that cannot consume SSE.
  // Poll GET /api/v1/sessions/:id for status, then GET /api/v1/sessions/:id/blueprint for result.
  v1.post('/generate-start', generationLimiter, async (req, res): Promise<void> => {
    const body = req.body as {
      prompt?: string;
      mode?: string;
      apiKey?: string;
      provider?: string;
      fastModel?: string;
      proModel?: string;
    };
    const { prompt, mode = 'fast' } = body;

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      res.status(400).json({ error: 'prompt is required' });
      return;
    }
    if (prompt.trim().length > 8000) {
      res.status(400).json({ error: 'prompt must be ≤ 8000 characters' });
      return;
    }
    if (!['fast', 'safe'].includes(mode)) {
      res.status(400).json({ error: 'mode must be "fast" or "safe"' });
      return;
    }

    const newActive = await incrementActive();
    if (newActive > MAX_CONCURRENT) {
      await decrementActive();
      res.status(429).json({ error: 'Server busy — try again shortly.' });
      return;
    }

    const { generateSessionId: genSessId } = await import('./src/engine/checkpoint');
    const sessionId = genSessId();
    const config = await extractConfig(req);
    const abort = new AbortController();
    activeAbortControllers.add(abort);
    generationSessionMap.set(sessionId, abort);

    const silentEmit = (_event: EngineEvent) => { /* background mode — events not streamed */ };

    // Fire-and-forget — response is sent immediately, generation continues in background.
    generateBlueprint(
      prompt.trim(), config, silentEmit,
      mode as GenerationMode, undefined, abort.signal, req.log
    ).finally(async () => {
      generationSessionMap.delete(sessionId);
      activeAbortControllers.delete(abort);
      await decrementActive();
    });

    const host = `${req.protocol}://${req.get('host') ?? 'localhost:5000'}`;
    res.status(202).json({
      sessionId,
      statusUrl:  `${host}/api/v1/sessions/${sessionId}`,
      sseUrl:     `${host}/api/v1/sessions/${sessionId}/stream`,
      message:    `Blueprint generation started. Poll statusUrl for progress.`,
    });
  });

  // POST /api/v1/validate
  // Pre-validates a task description and returns a cost estimate without running the pipeline.
  // Use this before atomic_generate_blueprint to confirm the task is well-formed.
  v1.post('/validate', async (req, res): Promise<void> => {
    const body = req.body as { prompt?: string };
    const { prompt } = body;

    if (!prompt || typeof prompt !== 'string') {
      res.status(400).json({ valid: false, error: 'prompt is required' });
      return;
    }
    const trimmed = prompt.trim();
    if (trimmed.length < 10) {
      res.status(400).json({ valid: false, error: 'prompt is too short (minimum 10 characters)' });
      return;
    }
    if (trimmed.length > 8000) {
      res.status(400).json({ valid: false, error: 'prompt is too long (maximum 8000 characters)' });
      return;
    }

    const { estimatePipelineCost } = await import('./src/engine/costBudget');
    const { SERVER_DEFAULT_CONFIG } = await import('./src/engine/config');
    const estimate = estimatePipelineCost({
      fastModel:        SERVER_DEFAULT_CONFIG.fastModel,
      proModel:         SERVER_DEFAULT_CONFIG.proModel,
      mode:             'fast',
      pillarCount:      6,
      agentsPerPillar:  5,
      promptLengthChars: trimmed.length,
    });

    res.json({
      valid:             true,
      charCount:         trimmed.length,
      estimatedCostUsd:  estimate.estimatedTotalUsd,
      estimatedTokens:   estimate.estimatedInputTokens + estimate.estimatedOutputTokens,
      pillarCount:       7,
      message:           'Task description is valid and ready for pipeline execution.',
    });
  });

  // ── Pipeline endpoints — Feature Creator, Tool Builder, Agent Builder ──────
  // POST /api/v1/pipelines/feature-creator
  v1.post('/pipelines/feature-creator', generationLimiter, async (req, res): Promise<void> => {
    const body = req.body as {
      featureDescription?: string;
      codebaseContext?: string;
      existingApiContracts?: string;
      constraints?: string;
      targetComplexity?: 'small' | 'medium' | 'large';
    };
    if (!body.featureDescription || !body.codebaseContext) {
      res.status(400).json({ error: 'featureDescription and codebaseContext are required' });
      return;
    }
    if (body.featureDescription.length > 3000) {
      res.status(400).json({ error: 'featureDescription must be ≤ 3000 characters' });
      return;
    }
    const config = await extractConfig(req);
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);
    const send = (event: any) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    try {
      const { runFeatureCreatorPipeline } = await import('./src/pipelines/feature-creator/index');
      const blueprint = await runFeatureCreatorPipeline(body as any, config, send, abort.signal);
      send({ type: 'complete', blueprint });
    } catch (err: any) {
      req.log.error({ err }, '[feature-creator] pipeline failed');
      send({ type: 'error', message: err?.message ?? 'Pipeline failed' });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });

  // POST /api/v1/pipelines/tool-builder
  v1.post('/pipelines/tool-builder', generationLimiter, async (req, res): Promise<void> => {
    const body = req.body as {
      toolConcept?: string;
      targetAgent?: string;
      externalSystem?: string;
      authMechanism?: string;
      expectedCallFrequency?: string;
      constraints?: string;
    };
    if (!body.toolConcept || !body.targetAgent) {
      res.status(400).json({ error: 'toolConcept and targetAgent are required' });
      return;
    }
    const config = await extractConfig(req);
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);
    const send = (event: any) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    try {
      const { runToolBuilderPipeline } = await import('./src/pipelines/tool-builder/index');
      const blueprint = await runToolBuilderPipeline(body as any, config, send, abort.signal);
      send({ type: 'complete', blueprint });
    } catch (err: any) {
      req.log.error({ err }, '[tool-builder] pipeline failed');
      send({ type: 'error', message: err?.message ?? 'Pipeline failed' });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });

  // POST /api/v1/pipelines/agent-builder
  v1.post('/pipelines/agent-builder', generationLimiter, async (req, res): Promise<void> => {
    const body = req.body as {
      agentRole?: string;
      agentCapabilities?: string;
      agentConstraints?: string;
      targetOrchestrator?: string;
      existingTools?: string;
      modelPreference?: string;
      qualityThreshold?: number;
    };
    if (!body.agentRole || !body.agentCapabilities || !body.agentConstraints) {
      res.status(400).json({ error: 'agentRole, agentCapabilities, and agentConstraints are required' });
      return;
    }
    const config = await extractConfig(req);
    const abort = new AbortController();
    req.on('close', () => abort.abort());
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': ping\n\n'); }, 15_000);
    const send = (event: any) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`); };
    try {
      const { runAgentBuilderPipeline } = await import('./src/pipelines/agent-builder/index');
      const blueprint = await runAgentBuilderPipeline(body as any, config, send, abort.signal);
      send({ type: 'complete', blueprint });
    } catch (err: any) {
      req.log.error({ err }, '[agent-builder] pipeline failed');
      send({ type: 'error', message: err?.message ?? 'Pipeline failed' });
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });

  // GET /api/v1/pipelines/health — provider health status
  v1.get('/pipelines/health', apiLimiter, (_req, res): void => {
    res.json({ statuses: healthMonitor.getAllHealthStatuses() });
  });

  // GET /api/v1/pipelines/cost-estimate — pre-run cost estimate
  v1.get('/pipelines/cost-estimate', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { estimatePipelineCost } = await import('./src/engine/costBudget');
      const config = await extractConfig(req);
      const promptLength = parseInt(String(req.query.promptLength ?? '500'), 10);
      const pillarCount = parseInt(String(req.query.pillarCount ?? '6'), 10);
      const agentsPerPillar = parseInt(String(req.query.agentsPerPillar ?? '5'), 10);
      const estimate = estimatePipelineCost({
        fastModel: config.fastModel,
        proModel: config.proModel,
        mode: (req.query.mode as 'fast' | 'safe') ?? 'fast',
        pillarCount: Math.min(pillarCount, 10),
        agentsPerPillar: Math.min(agentsPerPillar, 10),
        promptLengthChars: Math.min(promptLength, 8000),
      });
      res.json(estimate);
    } catch (err: any) {
      res.status(500).json({ error: 'Cost estimate failed', details: err?.message });
    }
  });

  // ── Action export endpoints ───────────────────────────────────────────────
  // POST /api/v1/blueprints/:id/export-action — export to action formats
  v1.post('/blueprints/:id/export-action', apiLimiter, async (req, res): Promise<void> => {
    try {
      const saved = getBlueprint(req.params.id!);
      if (!saved) { res.status(404).json({ error: 'Blueprint not found' }); return; }
      const { format, ...opts } = req.body ?? {};
      const bp = saved.blueprint as any;
      const blueprintId = saved.id;

      switch (format) {
        case 'github': {
          const { exportToGitHubIssues } = await import('./src/exporters/github/index');
          const result = exportToGitHubIssues(bp, blueprintId, opts);
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Disposition', `attachment; filename="github-issues-${blueprintId.slice(0, 8)}.json"`);
          res.json(result);
          break;
        }
        case 'linear': {
          const { exportToLinearIssues } = await import('./src/exporters/linear/index');
          const result = exportToLinearIssues(bp, blueprintId, opts);
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Disposition', `attachment; filename="linear-issues-${blueprintId.slice(0, 8)}.json"`);
          res.json(result);
          break;
        }
        case 'jira': {
          const { exportToJiraCsv } = await import('./src/exporters/jira/index');
          const result = exportToJiraCsv(bp, blueprintId, opts);
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="jira-import-${blueprintId.slice(0, 8)}.csv"`);
          res.send(result.csv);
          break;
        }
        case 'notion': {
          const { exportToNotionPage } = await import('./src/exporters/notion/index');
          const result = exportToNotionPage(bp, blueprintId);
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Content-Disposition', `attachment; filename="notion-page-${blueprintId.slice(0, 8)}.json"`);
          res.json(result);
          break;
        }
        case 'claude-md': {
          const { exportToClaudeMd } = await import('./src/exporters/claude-md/index');
          const result = exportToClaudeMd(bp, blueprintId, opts);
          res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="CLAUDE-${blueprintId.slice(0, 8)}.md"`);
          res.send(result.markdown);
          break;
        }
        default:
          res.status(400).json({ error: 'format must be github, linear, jira, notion, or claude-md' });
      }
    } catch (err: any) {
      log.error({ err }, '[blueprints] action export failed');
      res.status(500).json({ error: 'Export failed', details: err?.message });
    }
  });

  // POST /api/v1/blueprints/export-inline — export an in-memory blueprint (not yet persisted)
  v1.post('/blueprints/export-inline', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { blueprint: bpRaw, format = 'html' } = req.body ?? {};
      if (!bpRaw) { res.status(400).json({ error: 'blueprint is required' }); return; }
      const parsed = BlueprintSchema.safeParse(bpRaw);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid blueprint', issues: parsed.error.issues }); return;
      }
      const bp   = parsed.data as Blueprint;
      const name = (bp.intent?.product_name ?? 'blueprint').toLowerCase().replace(/\s+/g, '-');
      const id   = bp.id.slice(0, 8);

      if (format === 'html') {
        const html = await renderBlueprintHtml(bp, {});
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}-${id}.html"`);
        res.send(html);
        return;
      }
      if (format === 'md') {
        let md = `# ${bp.intent?.product_name ?? 'Blueprint'}\n\n> ${bp.prompt}\n\n---\n\n`;
        Object.entries(bp.sections).forEach(([key, content]) => {
          const title = key.split('_').map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          md += `## ${title}\n\n${content}\n\n`;
        });
        res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${name}-${id}.md"`);
        res.send(md);
        return;
      }
      res.status(400).json({ error: 'format must be md or html' });
    } catch (err: any) {
      log.error({ err }, '[blueprints] inline export failed');
      res.status(500).json({ error: 'Export failed' });
    }
  });

  // ── Artemis routes ───────────────────────────────────────────────────────────

  // POST /api/v1/artemis/session — create a new Artemis scoping session
  v1.post('/artemis/session', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { createArtemisSession } = await import('./src/engine/artemis');
      const sessionId = randomUUID();
      const workspace = createArtemisSession(sessionId);
      res.json({ sessionId, workspace });
    } catch (err: any) {
      log.error({ err }, '[artemis] session creation failed');
      res.status(500).json({ error: err?.message ?? 'Failed to create Artemis session' });
    }
  });

  // GET /api/v1/artemis/:sessionId/workspace — get workspace state
  v1.get('/artemis/:sessionId/workspace', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { getArtemisWorkspace } = await import('./src/engine/artemis');
      const workspace = getArtemisWorkspace(req.params.sessionId!);
      if (!workspace) { res.status(404).json({ error: 'Session not found' }); return; }
      res.json({ workspace });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/v1/artemis/:sessionId/chat — send a message (streaming SSE)
  v1.post('/artemis/:sessionId/chat', apiLimiter, async (req, res): Promise<void> => {
    const { message, config: _configOverride } = req.body ?? {};
    if (!message || typeof message !== 'string') {
      res.status(400).json({ error: 'message is required' }); return;
    }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (chunk: string) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    };
    try {
      const baseConfig = await extractConfig(req);
      const config = {
        ...baseConfig,
        ...(_configOverride?.effort         ? { effort: _configOverride.effort }                     : {}),
        ...(_configOverride?.thinkingEnabled !== undefined ? { thinkingEnabled: _configOverride.thinkingEnabled } : {}),
        ...(_configOverride?.proModel ?? _configOverride?.model ? { proModel: _configOverride.proModel ?? _configOverride.model } : {}),
      };
      const { artemisChat } = await import('./src/engine/artemis');
      const { textStream, onComplete } = await artemisChat({
        sessionId: req.params.sessionId!,
        message,
        config,
        activeSkillIds: req.body.activeSkillIds ?? [],
        confidenceThreshold: req.body.confidenceThreshold ?? 0.75,
      });
      for await (const chunk of textStream) {
        send(chunk);
      }
      await onComplete;
      if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
    } catch (err: any) {
      log.error({ err }, '[artemis] chat failed');
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: err?.message ?? 'Chat failed' })}\n\n`);
        res.end();
      }
    }
  });

  // POST /api/v1/artemis/:sessionId/brief — force-generate project brief
  v1.post('/artemis/:sessionId/brief', apiLimiter, async (req, res): Promise<void> => {
    try {
      const config = await extractConfig(req);
      const { forceBriefGeneration } = await import('./src/engine/artemis');
      const brief = await forceBriefGeneration(req.params.sessionId!, config);
      res.json({ brief });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Brief generation failed' });
    }
  });

  // POST /api/v1/artemis/:sessionId/approve — approve the project brief
  v1.post('/artemis/:sessionId/approve', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { approveBrief } = await import('./src/engine/artemis');
      const brief = approveBrief(req.params.sessionId!);
      res.json({ brief, approved: true });
    } catch (err: any) {
      res.status(400).json({ error: err?.message });
    }
  });

  // ── Curator routes ────────────────────────────────────────────────────────────

  // POST /api/v1/curator/session — create curator session
  v1.post('/curator/session', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { blueprintId } = req.body ?? {};
      if (!blueprintId) { res.status(400).json({ error: 'blueprintId is required' }); return; }
      const { createCuratorSession } = await import('./src/engine/curator');
      const sessionId = randomUUID();
      const workspace = createCuratorSession(sessionId, blueprintId);
      res.json({ sessionId, workspace });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/v1/curator/:sessionId/analyze — run deep blueprint analysis
  v1.post('/curator/:sessionId/analyze', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { blueprint: bpRaw, config: _configOverride } = req.body ?? {};
      if (!bpRaw) { res.status(400).json({ error: 'blueprint is required' }); return; }
      const parsed = BlueprintSchema.safeParse(bpRaw);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid blueprint' }); return; }
      const config = await extractConfig(req);
      const { analyzeBlueprint } = await import('./src/engine/curator');
      const report = await analyzeBlueprint({
        sessionId: req.params.sessionId!,
        blueprint: parsed.data,
        config,
        activeSkillIds: req.body.activeSkillIds ?? [],
      });
      res.json({ report });
    } catch (err: any) {
      log.error({ err }, '[curator] analysis failed');
      res.status(500).json({ error: err?.message ?? 'Analysis failed' });
    }
  });

  // POST /api/v1/curator/:sessionId/chat — streaming curator chat
  v1.post('/curator/:sessionId/chat', apiLimiter, async (req, res): Promise<void> => {
    const { message, blueprint: bpRaw, config: _configOverride } = req.body ?? {};
    if (!message || !bpRaw) { res.status(400).json({ error: 'message and blueprint are required' }); return; }
    const parsed = BlueprintSchema.safeParse(bpRaw);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid blueprint' }); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (chunk: string) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    };
    try {
      const baseConfig = await extractConfig(req);
      const config = {
        ...baseConfig,
        ...(_configOverride?.effort         ? { effort: _configOverride.effort }                                 : {}),
        ...(_configOverride?.thinkingEnabled !== undefined ? { thinkingEnabled: _configOverride.thinkingEnabled } : {}),
        ...(_configOverride?.proModel ?? _configOverride?.model ? { proModel: _configOverride.proModel ?? _configOverride.model } : {}),
      };
      const { curatorChat } = await import('./src/engine/curator');
      const { textStream, onComplete } = await curatorChat({
        sessionId: req.params.sessionId!,
        message,
        blueprint: parsed.data,
        config,
        activeSkillIds: req.body.activeSkillIds ?? [],
      });
      for await (const chunk of textStream) { send(chunk); }
      await onComplete;
      if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
    } catch (err: any) {
      log.error({ err }, '[curator] chat failed');
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: err?.message ?? 'Chat failed' })}\n\n`);
        res.end();
      }
    }
  });

  // POST /api/v1/curator/:sessionId/propose-edit — propose edit for a finding
  v1.post('/curator/:sessionId/propose-edit', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { blueprint: bpRaw, findingId, config: _configOverride } = req.body ?? {};
      if (!bpRaw || !findingId) { res.status(400).json({ error: 'blueprint and findingId are required' }); return; }
      const parsed = BlueprintSchema.safeParse(bpRaw);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid blueprint' }); return; }
      const config = await extractConfig(req);
      const { proposeEdit } = await import('./src/engine/curator');
      const edit = await proposeEdit({ sessionId: req.params.sessionId!, blueprint: parsed.data, findingId, config });
      res.json({ edit });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/v1/curator/:sessionId/apply-edit — apply a proposed edit
  v1.post('/curator/:sessionId/apply-edit', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { editId, blueprint: bpRaw } = req.body ?? {};
      if (!editId || !bpRaw) { res.status(400).json({ error: 'editId and blueprint are required' }); return; }
      const parsed = BlueprintSchema.safeParse(bpRaw);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid blueprint' }); return; }
      const { applyEdit } = await import('./src/engine/curator');
      const updatedBlueprint = await applyEdit(req.params.sessionId!, editId, parsed.data);
      res.json({ blueprint: updatedBlueprint });
    } catch (err: any) {
      res.status(400).json({ error: err?.message });
    }
  });

  // GET /api/v1/curator/:sessionId/workspace — get curator workspace
  v1.get('/curator/:sessionId/workspace', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { getCuratorWorkspace } = await import('./src/engine/curator');
      const workspace = getCuratorWorkspace(req.params.sessionId!);
      if (!workspace) { res.status(404).json({ error: 'Session not found' }); return; }
      res.json({ workspace });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Blueprint version history routes ─────────────────────────────────────────

  // GET /api/v1/blueprints/:id/versions — list all versions
  v1.get('/blueprints/:id/versions', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { listVersions } = await import('./src/engine/blueprintVersions');
      const versions = listVersions(req.params.id!);
      res.json({ versions, count: versions.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to list versions' });
    }
  });

  // GET /api/v1/blueprints/:id/versions/:versionNumber — get specific version
  v1.get('/blueprints/:id/versions/:versionNumber', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { getVersion } = await import('./src/engine/blueprintVersions');
      const vn = parseInt(req.params.versionNumber!, 10);
      if (isNaN(vn)) { res.status(400).json({ error: 'Invalid version number' }); return; }
      const version = getVersion(req.params.id!, vn);
      if (!version) { res.status(404).json({ error: 'Version not found' }); return; }
      res.json({ version });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/v1/blueprints/:id/versions/:versionNumber/restore — restore a version
  v1.post('/blueprints/:id/versions/:versionNumber/restore', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { restoreVersion } = await import('./src/engine/blueprintVersions');
      const vn = parseInt(req.params.versionNumber!, 10);
      if (isNaN(vn)) { res.status(400).json({ error: 'Invalid version number' }); return; }
      const result = restoreVersion({
        blueprintId: req.params.id!,
        versionNumber: vn,
        sessionId: req.body.sessionId ?? randomUUID(),
      });
      if (!result) { res.status(404).json({ error: 'Version not found' }); return; }
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/v1/blueprints/:id/versions/:versionNumber/integrity — verify hash
  v1.get('/blueprints/:id/versions/:versionNumber/integrity', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { verifyIntegrity } = await import('./src/engine/blueprintVersions');
      const vn = parseInt(req.params.versionNumber!, 10);
      if (isNaN(vn)) { res.status(400).json({ error: 'Invalid version number' }); return; }
      const result = verifyIntegrity(req.params.id!, vn);
      res.json(result);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/v1/blueprints/:id/versions/checkpoint — manually save a checkpoint
  v1.post('/blueprints/:id/versions/checkpoint', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { blueprint: bpRaw } = req.body ?? {};
      if (!bpRaw) { res.status(400).json({ error: 'blueprint is required' }); return; }
      const parsed = BlueprintSchema.safeParse(bpRaw);
      if (!parsed.success) { res.status(400).json({ error: 'Invalid blueprint' }); return; }
      const { createVersion } = await import('./src/engine/blueprintVersions');
      const version = createVersion({
        blueprintId: req.params.id!,
        snapshot: parsed.data,
        author: 'user',
        authorDetail: 'Manual checkpoint',
        changeSummary: req.body.summary ?? 'User checkpoint',
        changeType: 'checkpoint',
        sessionId: req.body.sessionId ?? randomUUID(),
      });
      res.json({ version });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Skills routes ─────────────────────────────────────────────────────────────

  // GET /api/v1/skills — list all skills
  v1.get('/skills', apiLimiter, async (_req, res): Promise<void> => {
    try {
      const { getAllSkills } = await import('./src/engine/skills');
      res.json({ skills: getAllSkills() });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/v1/skills — create custom skill
  v1.post('/skills', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { registerCustomSkill, getAllSkills } = await import('./src/engine/skills');
      registerCustomSkill({ ...req.body, isBuiltIn: false, createdAt: new Date().toISOString() });
      res.status(201).json({ skills: getAllSkills() });
    } catch (err: any) {
      res.status(400).json({ error: err?.message });
    }
  });

  // PATCH /api/v1/skills/:id — update custom skill
  v1.patch('/skills/:id', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { updateCustomSkill } = await import('./src/engine/skills');
      const skill = updateCustomSkill(req.params.id!, req.body);
      res.json({ skill });
    } catch (err: any) {
      res.status(400).json({ error: err?.message });
    }
  });

  // DELETE /api/v1/skills/:id — delete custom skill
  v1.delete('/skills/:id', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { deleteCustomSkill } = await import('./src/engine/skills');
      deleteCustomSkill(req.params.id!);
      res.status(204).end();
    } catch (err: any) {
      res.status(400).json({ error: err?.message });
    }
  });

    // ── General chat route ────────────────────────────────────────────────────────
  // POST /api/v1/chat/general — general blueprint Q&A (read-only, streaming)
  // v2.8.0 — process-scoped per-session history for the general agent.
  const generalHistory = new Map<string, { role: 'user' | 'assistant'; content: string }[]>();
  v1.post('/chat/general', apiLimiter, async (req, res): Promise<void> => {
    const { message, blueprint: bpRaw, config: _configOverride } = req.body ?? {};
    if (!message) { res.status(400).json({ error: 'message is required' }); return; }
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();
    const send = (chunk: string) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
    };
    try {
      const baseConfig = await extractConfig(req);
      const config = {
        ...baseConfig,
        ...(_configOverride?.effort         ? { effort: _configOverride.effort }                                 : {}),
        ...(_configOverride?.thinkingEnabled !== undefined ? { thinkingEnabled: _configOverride.thinkingEnabled } : {}),
        ...(_configOverride?.proModel ?? _configOverride?.model ? { proModel: _configOverride.proModel ?? _configOverride.model } : {}),
      };
      // v2.8.0 — agentic tool loop for general Q&A: the agent grounds answers
      // in the real blueprint and long-term memory via tool calls, keeps
      // per-session conversation history, and emits tool side-effects to the
      // client through the SSE stream.
      const { runAgentTurn } = await import('./src/engine/chatAgentLoop');
      const { generalTools } = await import('./src/engine/chatTools');
      const { getBlueprint, listBlueprints } = await import('./src/engine/blueprintStore');
      const { createAgentBudget } = await import('./src/engine/agentBudget');
      let latestBp: Blueprint[] = [];
      if (bpRaw) {
        latestBp = [bpRaw as Blueprint];
      } else {
        const latest = listBlueprints({ limit: 1 }).items[0];
        if (latest) {
          const full = getBlueprint(latest.id);
          if (full?.blueprint) latestBp = [full.blueprint];
        }
      }
      const bpContext = latestBp[0]
        ? `\nBlueprint context:\n${JSON.stringify(latestBp[0]).slice(0, 4000)}`
        : '';
      const sessionId = (req.body.sessionId as string | undefined) ?? 'general';
      if (!generalHistory.has(sessionId)) generalHistory.set(sessionId, []);
      const history = generalHistory.get(sessionId)!;
      history.push({ role: 'user' as const, content: message });
      if (history.length > 50) history.splice(0, history.length - 50);

      const loop = await runAgentTurn({
        systemPrompt: `You are an expert technical advisor helping users understand and explore architecture blueprints.
CRITICAL RULE: You are in READ-ONLY mode. You CANNOT modify the blueprint in any way.
You can explain, analyze, compare, and answer questions. Never suggest direct edits — refer users to the Curator for changes.
${bpContext}`,
        history,
        tools: generalTools().map(t => ({ ...t, permission: 'full-auto' as const })),
        model: config.proModel,
        maxTurnSteps: 4,
        maxOutputTokens: 1024,
        temperature: 0.5,
        config,
        budget: createAgentBudget(),
        sessionId,
        agentId: 'general',
        state: { blueprints: latestBp },
      });
      history.push({ role: 'assistant' as const, content: await loop.finalText });
      if (history.length > 50) history.splice(0, history.length - 50);

      for await (const chunk of loop.textStream) { send(chunk); }
      if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); }
    } catch (err: any) {
      log.error({ err }, '[chat/general] failed');
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ error: err?.message ?? 'Chat failed' })}\n\n`);
        res.end();
      }
    }
  });

  // ── Observability route ───────────────────────────────────────────────────────

  // GET /api/v1/observability/traces — get observability traces (dev mode only)
  v1.get('/observability/traces', async (req, res): Promise<void> => {
    if (process.env.NODE_ENV === 'production') {
      res.status(403).json({ error: 'Observability endpoint disabled in production' }); return;
    }
    try {
      const { getTraces, getSessionMetrics } = await import('./src/engine/observability');
      const { sessionId, category, level, since, limit } = req.query as Record<string, string | undefined>;
      const traces = getTraces({
        sessionId,
        category: category as import('./src/engine/observability').ObservabilityCategory | undefined,
        level: level as import('./src/engine/observability').ObservabilityLevel | undefined,
        since,
        limit: limit ? parseInt(limit, 10) : 200,
      });
      const metrics = sessionId ? getSessionMetrics(sessionId as string) : null;
      res.json({ traces, metrics, count: traces.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/v1/event-bus/history — get event bus history (dev mode only)
  v1.get('/event-bus/history', async (req, res): Promise<void> => {
    if (process.env.NODE_ENV === 'production') {
      res.status(403).json({ error: 'Event bus endpoint disabled in production' }); return;
    }
    try {
      const { eventBus } = await import('./src/engine/eventBus');
      const { sessionId, since } = req.query;
      const history = eventBus.getHistory({
        sessionId: sessionId as string | undefined,
        since: since as string | undefined,
      });
      res.json({ events: history, count: history.length });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/v1/event-bus/stream — real-time SSE stream of all bus events
  // Optional ?sessionId= filter, ?types= comma-separated list of event types
  v1.get('/event-bus/stream', apiLimiter, async (req, res): Promise<void> => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const filterSessionId = req.query.sessionId as string | undefined;
    const filterTypes = req.query.types
      ? (req.query.types as string).split(',').map(t => t.trim())
      : null;

    // Send any recent history (last 50 events) as backfill on connect
    const { eventBus } = await import('./src/engine/eventBus');
    const backfill = eventBus.getHistory({
      sessionId: filterSessionId,
      since: new Date(Date.now() - 60_000).toISOString(), // last 60 seconds
    });

    for (const ev of backfill) {
      if (filterTypes && !filterTypes.includes(ev.type)) continue;
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      }
    }

    // Subscribe to live events
    const unsub = eventBus.subscribeAll((event) => {
      if (res.writableEnded) return;
      if (filterSessionId && event.sessionId !== filterSessionId) return;
      if (filterTypes && !filterTypes.includes(event.type)) return;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    });

    // Heartbeat every 20 seconds to keep connection alive through proxies
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(': heartbeat\n\n');
      else clearInterval(heartbeat);
    }, 20_000);

    req.on('close', () => {
      unsub();
      clearInterval(heartbeat);
    });
  });

  // ── Agent Long-term Memory ────────────────────────────────────────────────────

  // GET /api/v1/agent/memory/long-term — list all LTM entries
  v1.get('/agent/memory/long-term', apiLimiter, async (req, res): Promise<void> => {
    try {
      const limit  = Math.min(parseInt(req.query.limit as string || '200', 10), 500);
      const domain = req.query.domain as string | undefined;
      const memories = listAllMemories(limit);
      const filtered = domain ? memories.filter(m => m.domain === domain) : memories;
      const count = getMemoryCount();
      res.json({ memories: filtered, count, limit });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to list long-term memories' });
    }
  });

  // DELETE /api/v1/agent/memory/long-term/:domain — clear memories for a domain
  v1.delete('/agent/memory/long-term/:domain', apiLimiter, async (req, res): Promise<void> => {
    try {
      const domain = req.params.domain;
      if (!domain) { res.status(400).json({ error: 'domain is required' }); return; }
      const { getDb: _getDb } = await import('./src/engine/store.sqlite');
      _getDb().prepare('DELETE FROM agent_long_term_memory WHERE domain = ?').run(domain);
      res.json({ ok: true, domain });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to clear domain memories' });
    }
  });

  // ── Settings CRUD ─────────────────────────────────────────────────────────────

  // GET /api/v1/settings — load persisted atomic settings
  v1.get('/settings', apiLimiter, async (_req, res): Promise<void> => {
    try {
      const { settingsStore } = await import('./src/engine/settingsStore');
      const settings = settingsStore.load();
      res.json({ settings });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to load settings' });
    }
  });

  // PATCH /api/v1/settings — update a section of atomic settings
  v1.patch('/settings', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { settingsStore } = await import('./src/engine/settingsStore');
      const { section, updates } = req.body as { section: string; updates: Record<string, unknown> };
      if (!section || typeof section !== 'string') {
        res.status(400).json({ error: 'section is required' }); return;
      }
      const valid = ['artemis', 'curator', 'general', 'pipeline', 'system'];
      if (!valid.includes(section)) {
        res.status(400).json({ error: `Invalid section. Must be one of: ${valid.join(', ')}` }); return;
      }
      const updated = settingsStore.patch(section as any, updates ?? {});
      res.json({ settings: updated });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to save settings' });
    }
  });

  // POST /api/v1/settings/reset — reset to defaults
  v1.post('/settings/reset', apiLimiter, async (_req, res): Promise<void> => {
    try {
      const { settingsStore } = await import('./src/engine/settingsStore');
      const defaults = settingsStore.reset();
      res.json({ settings: defaults, reset: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? 'Failed to reset settings' });
    }
  });

  // ── Token Budget API ──────────────────────────────────────────────────────────

  // GET /api/v1/token-budget/:sessionId — get usage report for session
  v1.get('/token-budget/:sessionId', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { tokenBudgetManager } = await import('./src/engine/tokenBudgetManager');
      const report = tokenBudgetManager.getUsage(req.params.sessionId!);
      if (!report) { res.status(404).json({ error: 'Session not found' }); return; }
      res.json(report);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Workspace API ─────────────────────────────────────────────────────────────

  // GET /api/v1/workspaces/:sessionId — list all workspaces for session
  v1.get('/workspaces/:sessionId', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { workspaceManager } = await import('./src/engine/workspaceManager');
      const workspaces = workspaceManager.listForSession(req.params.sessionId!);
      res.json({ workspaces });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/v1/workspaces/:sessionId/:workspaceId — get workspace content
  v1.get('/workspaces/:sessionId/:workspaceId', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { workspaceManager } = await import('./src/engine/workspaceManager');
      const traceId = (req.headers['x-trace-id'] as string | undefined) ?? 'api';
      const ws = workspaceManager.read(req.params.sessionId!, req.params.workspaceId! as any, 'system', traceId);
      if (!ws) { res.status(404).json({ error: 'Workspace not found' }); return; }
      res.json({ content: ws });
    } catch (err: any) {
      if (err?.message?.includes('Permission denied')) {
        res.status(403).json({ error: err.message }); return;
      }
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/v1/workspaces/:sessionId/:workspaceId/snapshots — list snapshot history
  v1.get('/workspaces/:sessionId/:workspaceId/snapshots', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { workspaceManager } = await import('./src/engine/workspaceManager');
      const snapshots = workspaceManager.getSnapshots(req.params.sessionId!, req.params.workspaceId! as any);
      res.json({ snapshots });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // ── Projects API ──────────────────────────────────────────────────────────────

  // GET /api/v1/projects — list all projects
  v1.get('/projects', apiLimiter, async (_req, res): Promise<void> => {
    try {
      const { projectManager } = await import('./src/engine/projects');
      const projects = projectManager.listProjects();
      res.json({ projects });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // GET /api/v1/projects/active — get the active project
  v1.get('/projects/active', apiLimiter, async (_req, res): Promise<void> => {
    try {
      const { projectManager } = await import('./src/engine/projects');
      const project = projectManager.getActiveProject();
      res.json({ project });
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/v1/projects — create a new project
  v1.post('/projects', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { projectManager } = await import('./src/engine/projects');
      const { name, description } = req.body as { name?: string; description?: string };
      if (!name?.trim()) { res.status(400).json({ error: 'name is required' }); return; }
      const project = projectManager.createProject(name.trim(), description?.trim());
      res.status(201).json({ project });
    } catch (err: any) {
      res.status(400).json({ error: err?.message });
    }
  });

  // GET /api/v1/projects/:id — get a project
  v1.get('/projects/:id', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { projectManager } = await import('./src/engine/projects');
      const project = projectManager.getProject(req.params.id!);
      res.json({ project });
    } catch (err: any) {
      if (err?.message?.includes('not found')) { res.status(404).json({ error: err.message }); return; }
      res.status(500).json({ error: err?.message });
    }
  });

  // PATCH /api/v1/projects/:id — update project
  v1.patch('/projects/:id', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { projectManager } = await import('./src/engine/projects');
      const updates = req.body as { name?: string; description?: string; phase?: string };
      const project = projectManager.updateProject(req.params.id!, updates as any);
      res.json({ project });
    } catch (err: any) {
      if (err?.message?.includes('not found')) { res.status(404).json({ error: err.message }); return; }
      res.status(500).json({ error: err?.message });
    }
  });

  // DELETE /api/v1/projects/:id — delete project
  v1.delete('/projects/:id', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { projectManager } = await import('./src/engine/projects');
      projectManager.deleteProject(req.params.id!);
      res.json({ deleted: true });
    } catch (err: any) {
      if (err?.message?.includes('not found')) { res.status(404).json({ error: err.message }); return; }
      if (err?.message?.includes('Cannot delete')) { res.status(400).json({ error: err.message }); return; }
      res.status(500).json({ error: err?.message });
    }
  });

  // POST /api/v1/projects/:id/switch — switch active project
  v1.post('/projects/:id/switch', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { projectManager } = await import('./src/engine/projects');
      const project = projectManager.switchProject(req.params.id!);
      res.json({ project, switched: true });
    } catch (err: any) {
      if (err?.message?.includes('not found')) { res.status(404).json({ error: err.message }); return; }
      res.status(500).json({ error: err?.message });
    }
  });

  // ── System State Snapshot API ────────────────────────────────────────────────

  // GET /api/v1/system-state/:sessionId — get live system state snapshot
  v1.get('/system-state/:sessionId', apiLimiter, async (req, res): Promise<void> => {
    try {
      const { AtomicStateManager } = await import('./src/engine/systemState');
      const state = AtomicStateManager.snapshot(req.params.sessionId!);
      if (!state) { res.status(404).json({ error: 'Session not found' }); return; }
      res.json(state);
    } catch (err: any) {
      res.status(500).json({ error: err?.message });
    }
  });

  app.use('/api/v1', v1);

  // Health / readiness probes (load-balancer & container orchestration compatible)
  app.get('/api/health', (_req, res) => {
    res.json({
      status:    'ok',
      version:   '1.0.0',
      uptime:    Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
      instance:  INSTANCE_ID,
    });
  });
  app.get('/api/ready', (_req, res) => {
    try {
      // Quick DB ping — fails immediately if SQLite file is locked/corrupt
      getDb().prepare('SELECT 1').get();
      res.json({ ready: true, db: 'connected' });
    } catch {
      res.status(503).json({ ready: false, reason: 'database unavailable' });
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    // Dynamic import keeps Vite out of the production bundle (see top-of-file note).
    // The double await is deliberate: the outer resolves the import promise, the
    // inner resolves createServer(). CJS/ESM both support `await import()`.
    const { createServer: createViteServer } = await import('vite') as unknown as ViteModule;
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        allowedHosts: true,
        hmr: process.env.DISABLE_HMR === 'true' ? false : { clientPort: PORT },
      },
      appType: 'spa',
    });
    app.use(vite.middlewares as never);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    if (!fs.existsSync(distPath)) {
      log.fatal(`[atomic] FATAL: Production dist path missing at ${distPath}. Did you run build?`);
      process.exit(1);
    }
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // ── Global Express error handler ────────────────────────────────────────────
  // Must be registered AFTER all routes. Catches any error passed to next(err)
  // or thrown synchronously inside a non-async route handler.
  // Guarantees that X-Request-ID is always present even on unhandled errors.
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const reqId = req.reqId ?? 'unknown';
    const status = (err as any)?.status ?? (err as any)?.statusCode ?? 500;
    const message =
      status < 500
        ? String((err as any)?.message ?? 'Bad request')
        : 'An unexpected error occurred. Please try again.';

    (req.log ?? log).error(
      { err, reqId, method: req.method, path: req.path },
      'Unhandled route error',
    );

    if (!res.headersSent) {
      res.setHeader('X-Request-ID', reqId);
      res.status(status).json({ error: message, reqId });
    }
  });

  const server = app.listen(PORT, "0.0.0.0", () => {
    log.info(`[atomic-api] listening on http://0.0.0.0:${PORT}`);
  });
  server.on('error', (err: { code?: string; message?: string }) => {
    if (err.code === 'EADDRINUSE') {
      log.error(`Port ${PORT} is already in use. Please kill the process using it.`);
      process.exit(1);
    } else {
      log.error({ err }, 'Server error');
    }
  });
  function gracefulShutdown(signal: string) {
    log.info({ signal, active: activeAbortControllers.size }, 'Shutdown signal received');
    // Abort all in-flight generations so SSE clients receive an error event
    for (const ac of activeAbortControllers) {
      try { ac.abort(); } catch { /* ignore */ }
    }
    activeAbortControllers.clear();
    server.close(() => {
      log.info('Server closed — all connections drained');
      process.exit(0);
    });
    // Force-exit if connections don't drain within 10 seconds
    setTimeout(() => {
      log.warn('Forcing exit after timeout');
      process.exit(0);
    }, 10_000);
  }
  // NOTE: SIGKILL cannot be caught. If the process is hard-killed mid-generation,
  // active_gens will be stale until next startup, which resets it to 0.
  // This is acceptable for local single-process deployments.
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('uncaughtException', (err) => { log.fatal({ err }, 'uncaughtException'); gracefulShutdown('uncaughtException'); });
  process.on('unhandledRejection', (reason) => { log.fatal({ reason }, 'unhandledRejection'); gracefulShutdown('unhandledRejection'); });
  return { app, server, store };
}

async function startServer() {
  return createApp({ port: parseInt(process.env.PORT ?? '3000', 10) });
}

// Only boot the HTTP daemon when this module is executed directly. When imported
// by tests or another host (e.g. `npm run test:http`, AWS Lambda adapters, or
// programmatic embedding), the caller controls the lifecycle via `createApp()`
// instead.
//
// `require.main === module` is the canonical CommonJS check; the import.meta
// guard preserves it under native ESM too. esbuild inlines `import.meta.url` to
// the empty string in CJS output, which simply makes that branch never match —
// safe in both formats.
const isDirectRun =
  (typeof require !== 'undefined' && require.main === module) ||
  (import.meta.url &&
    !!process.argv[1] &&
    (process.argv[1] === import.meta.url ||
      path.resolve(process.argv[1]) === path.resolve(import.meta.url)));

if (isDirectRun) {
  startServer().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[atomic] Fatal startup error:', err);
    process.exit(1);
  });
}

export { createApp, startServer };
export type { EngineEvent } from './src/engine/types';
