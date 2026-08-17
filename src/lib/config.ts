import { ModelConfig } from '../engine/config';
import { PROVIDERS } from './providers';

/**
 * Intentionally returns null. Configuration lives server-side in an HTTP-only
 * cookie or environment variables for security.
 */
export function getClientConfig(): ModelConfig | null {
  return null;
}

export async function saveClientConfig(config: ModelConfig) {
  const res = await fetch('/api/v1/configure-key', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(config)
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Failed to save config');
  }
}

export async function loadClientConfig(): Promise<Partial<ModelConfig> | null> {
  try {
    const res = await fetch('/api/v1/my-config');
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function getDefaultConfigForProvider(slug: string): ModelConfig {
  const provider = PROVIDERS.find(p => p.slug === slug) || PROVIDERS[0];
  return {
    provider: provider?.slug as any,
    apiKey: '',
    fastModel: provider?.defaultFast as any,
    proModel: provider?.defaultPro as any
  };
}
