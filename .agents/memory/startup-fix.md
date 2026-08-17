---
name: Startup fix
description: Why the app fails to start and how to fix it
---

# Startup Fix

## The Rule
When `tsx: command not found` appears, `node_modules` is missing or corrupt.

**Why:** The Replit environment can have corrupt/incomplete `node_modules` (ENOTEMPTY rename errors on existing dirs). `npm install` alone may fail.

**How to apply:** Run `npm install --prefer-offline` from the workspace root. This uses the npm cache and succeeds even when some module dirs are partially populated. Verify with `ls node_modules/.bin/tsx`.
