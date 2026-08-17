---
name: Model registry pattern
description: Where model IDs live and how to add new models
---

# Model Registry

## The Rule
`src/models/registry.ts` is the **single source of truth** for all model IDs. Any model string outside this file is a defect.

**Why:** Hardcoded model strings across multiple files become inconsistent as models are deprecated or renamed. The registry provides lookup helpers, capability flags, and pricing data used by the cost estimator and governor.

**How to apply:**
- To add a new model: add a `ModelEntry` to `MODEL_REGISTRY` in `src/models/registry.ts`, then reference it by its `id` in `src/lib/providers.ts`
- To look up a model: use `getModelById(id)` — returns `undefined` if not registered
- To check capabilities: use `getModelsByCapability('extendedThinking')`, etc.
- To estimate cost: use `estimateCost(modelId, inputTokens, outputTokens)`
- New models added: Claude Opus 4.8, Gemini 3.1 Pro Preview, Gemini 3.5 Flash, Nemotron 3 Ultra 550B, Qwen 3.7 Plus (both paid and :free tiers)
