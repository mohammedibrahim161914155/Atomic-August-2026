#!/usr/bin/env node
/**
 * src/mcp/index.ts
 *
 * Entry point for the Atomic MCP server.
 * Supports two transports:
 *   - stdio: default (for npx atomic-mcp / Claude Code / Cursor / Kilo Code)
 *   - http:  set MCP_TRANSPORT=http (for debugging / HTTP-based integrations)
 *
 * Usage:
 *   npx atomic-mcp                          # stdio transport (default)
 *   MCP_TRANSPORT=http npx atomic-mcp       # HTTP transport on port 3100
 *   MCP_PORT=3200 MCP_TRANSPORT=http npx atomic-mcp  # custom port
 *
 * Environment variables:
 *   ATOMIC_API_URL   URL of the running Atomic server (default: http://localhost:5000)
 *   MCP_TRANSPORT    "stdio" or "http" (default: "stdio")
 *   MCP_PORT         Port for HTTP transport (default: 3100)
 */

import { createMcpServer, startStdioTransport } from './server';

const transport = process.env['MCP_TRANSPORT'] ?? 'stdio';
const port = parseInt(process.env['MCP_PORT'] ?? '3100', 10);

if (transport === 'http') {
  const server = createMcpServer(port);
  server.listen(port, () => {
    process.stderr.write(
      `[atomic-mcp] HTTP transport listening on http://localhost:${port}\n` +
      `[atomic-mcp] Atomic API: ${process.env['ATOMIC_API_URL'] ?? 'http://localhost:5000'}\n`
    );
  });

  server.on('error', (err: Error) => {
    process.stderr.write(`[atomic-mcp] Server error: ${err.message}\n`);
    process.exit(1);
  });
} else {
  // Default: stdio transport (required by MCP spec for CLI tools)
  startStdioTransport();
}
