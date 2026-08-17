import { defineConfig } from '@trigger.dev/sdk/v3';

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_ID ?? 'proj_atomic',
  runtime: 'node',
  dirs: ['./src/trigger'],
  maxDuration: 600, // 10 minutes — enough for full blueprint generation
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 2,
      minTimeoutInMs: 2000,
      maxTimeoutInMs: 30000,
      factor: 2,
    },
  },
});
