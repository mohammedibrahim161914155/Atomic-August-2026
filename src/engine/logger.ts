import pino from 'pino';
import { AsyncLocalStorage } from 'async_hooks';

function makePino() {
  return pino({
    name: 'atomic-engine',
    level: process.env.LOG_LEVEL ?? 'info',
    transport:
      process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  });
}

const defaultLogger = makePino();

export const engineLoggerStorage = new AsyncLocalStorage<pino.Logger>();

// Default logger used by engine files that don't receive one externally
// Uses AsyncLocalStorage to automatically pick up the request-scoped logger if available
export const log = new Proxy(defaultLogger, {
  get(target, prop) {
    const store = engineLoggerStorage.getStore();
    const activeLogger = store || target;
    const value = Reflect.get(activeLogger, prop);
    return typeof value === 'function' ? value.bind(activeLogger) : value;
  }
}) as pino.Logger;

// Factory — call this from server.ts to create a child logger per request
export function createEngineLogger(context: Record<string, unknown>) {
  return defaultLogger.child(context);
}
