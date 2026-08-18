/**
 * src/mcp/id.ts
 *
 * Secure random ID generation for MCP session and request correlation IDs.
 */

import { randomBytes } from 'crypto';

export function generateId(): string {
  return randomBytes(8).toString('hex');
}
