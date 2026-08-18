/**
 * src/sdk/resources/plugins.ts
 *
 * Engine plugins resource — server-side plugin lifecycle:
 * install / list / get / pack / run / trust / doctor.
 * Mirrors the server's /api/v1/plugins endpoints exactly.
 */

import type { AtomicHTTP } from '../client';
import type {
  DoctorReport, InstalledPlugin, PluginInstallInput, PluginRunOptions,
  PluginRunResult, PluginTrustInfo,
} from '../types';

export class PluginsResource {
  constructor(private readonly http: AtomicHTTP) {}

  /** Validate a plugin manifest with the doctor without installing it. */
  async doctor(manifest: Record<string, unknown>): Promise<DoctorReport> {
    return this.http.request<DoctorReport>('/plugins/doctor', {
      method: 'POST',
      body:   { manifest },
    });
  }

  /** Install a plugin (source, pack id, or inline manifest). */
  async install(input: PluginInstallInput): Promise<InstalledPlugin> {
    return this.http.request<InstalledPlugin>('/plugins/install', {
      method: 'POST',
      body:   input,
    });
  }

  /** List all installed plugins. */
  async list(): Promise<{ plugins: InstalledPlugin[] }> {
    return this.http.request<{ plugins: InstalledPlugin[] }>('/plugins');
  }

  /** Get a single installed plugin by id. */
  async get(id: string): Promise<InstalledPlugin> {
    return this.http.request<InstalledPlugin>(`/plugins/${id}`);
  }

  /** Download the plugin's distributable pack (tarball/zip). */
  async pack(id: string): Promise<string> {
    return this.http.request<string>(`/plugins/${id}/pack`);
  }

  /** Uninstall a plugin. */
  async uninstall(id: string): Promise<{ deleted: boolean }> {
    return this.http.request<{ deleted: boolean }>(`/plugins/${id}`, { method: 'DELETE' });
  }

  /** Run a plugin hook (e.g. transform, export) with a payload. */
  async run(id: string, opts: PluginRunOptions = {}): Promise<PluginRunResult> {
    return this.http.request<PluginRunResult>(`/plugins/${id}/run`, {
      method: 'POST',
      body:   { hook: opts.hook ?? 'transform', payload: opts.payload ?? {} },
    });
  }

  /** Get the trust state for a plugin. */
  async getTrust(id: string): Promise<PluginTrustInfo> {
    return this.http.request<PluginTrustInfo>(`/plugins/${id}/trust`);
  }

  /** Set the trust state for a plugin (trust or distrust). */
  async setTrust(id: string, trusted: boolean, source?: string): Promise<PluginTrustInfo> {
    return this.http.request<PluginTrustInfo>(`/plugins/${id}/trust`, {
      method: 'PATCH',
      body:   { trusted, source },
    });
  }

  /** Revoke the trust state for a plugin. */
  async revokeTrust(id: string): Promise<{ revoked: boolean }> {
    return this.http.request<{ revoked: boolean }>(`/plugins/${id}/trust`, { method: 'DELETE' });
  }

  /** List available skill packs. */
  async listSkillPacks(): Promise<{ packs: unknown[] }> {
    return this.http.request<{ packs: unknown[] }>('/skill-packs');
  }
}
