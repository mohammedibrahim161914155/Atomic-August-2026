---
name: MCP server transport
description: How the atomic-mcp server works and which transports it supports
---

# Atomic MCP Server

## The Rule
The MCP server at `src/mcp/index.ts` supports two transports. The correct default for `npx` / coding agent use is **stdio**. Use HTTP only for debugging.

**Why:** MCP spec requires stdio for CLI tools distributed via npx. HTTP is useful for testing the JSON-RPC protocol interactively.

**How to apply:**
- `npm run mcp` → stdio transport (default)
- `MCP_TRANSPORT=http npm run mcp:http` → HTTP on port 3100
- `ATOMIC_API_URL` env var controls which Atomic server the MCP connects to (default: `http://localhost:5000`)

The MCP server exposes 7 tools: `atomic_generate_blueprint`, `atomic_get_status`, `atomic_get_result`, `atomic_list_blueprints`, `atomic_rerun_pillar`, `atomic_export_bundle`, `atomic_validate_task`.
