/**
 * src/sdk/resources/versions.ts
 *
 * Versions resource — blueprint version history management.
 *
 * Every blueprint modification creates a new immutable version.
 * V1 is permanently preserved — restoring always creates a new version.
 */

import type { AtomicHTTP } from '../client';
import type {
  BlueprintVersion, RestoreVersionResult, IntegrityResult, BlueprintDiff,
} from '../types';

export class VersionsResource {
  constructor(private readonly http: AtomicHTTP) {}

  /**
   * List all versions of a blueprint, newest first.
   *
   * @example
   * ```ts
   * const versions = await client.versions.list(blueprint.id);
   * console.log(`${versions.length} versions, latest: v${versions[0].versionNumber}`);
   * ```
   */
  async list(blueprintId: string): Promise<BlueprintVersion[]> {
    const res = await this.http.request<{ versions: BlueprintVersion[] }>(
      `/blueprints/${blueprintId}/versions`,
    );
    return res.versions;
  }

  /** Get a specific version by version number */
  async get(blueprintId: string, versionNumber: number): Promise<BlueprintVersion> {
    return this.http.request<BlueprintVersion>(
      `/blueprints/${blueprintId}/versions/${versionNumber}`,
    );
  }

  /**
   * Restore a blueprint to a previous version.
   * This creates a new version (restore always appends — never destructive).
   *
   * @example
   * ```ts
   * const result = await client.versions.restore(blueprint.id, 3);
   * console.log(`Restored to v3, new version is v${result.newVersionNumber}`);
   * ```
   */
  async restore(blueprintId: string, versionNumber: number): Promise<RestoreVersionResult> {
    return this.http.request<RestoreVersionResult>(
      `/blueprints/${blueprintId}/versions/${versionNumber}/restore`,
      { method: 'POST' },
    );
  }

  /**
   * Get the diff between two versions.
   *
   * @param blueprintId  The blueprint ID
   * @param fromVersion  Base version number
   * @param toVersion    Target version number (defaults to latest)
   */
  async diff(blueprintId: string, fromVersion: number, toVersion?: number): Promise<BlueprintDiff> {
    const qs = toVersion != null ? `?to=${toVersion}` : '';
    return this.http.request<BlueprintDiff>(
      `/blueprints/${blueprintId}/versions/${fromVersion}/diff${qs}`,
    );
  }

  /**
   * Verify the integrity hash of a specific version.
   * Use this to detect corruption.
   */
  async verifyIntegrity(blueprintId: string, versionNumber: number): Promise<IntegrityResult> {
    return this.http.request<IntegrityResult>(
      `/blueprints/${blueprintId}/versions/${versionNumber}/integrity`,
    );
  }

  /**
   * Create a manual checkpoint version.
   * @param message Optional checkpoint message shown in version history
   */
  async checkpoint(blueprintId: string, message?: string): Promise<BlueprintVersion> {
    return this.http.request<BlueprintVersion>(`/blueprints/${blueprintId}/versions/checkpoint`, {
      method: 'POST',
      body:   { message },
    });
  }
}
