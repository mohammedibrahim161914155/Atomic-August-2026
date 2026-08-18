/**
 * src/plugins/built-in/export-notion.ts
 *
 * Built-in integration plugin — push blueprint to Notion as a structured page.
 *
 * Configuration (stored in plugin storage):
 *   - notion_api_key:   string  (required, Integration Token)
 *   - notion_parent_id: string  (required, parent page or database ID)
 */

import type { PluginDefinition, IntegrationPlugin, PluginContext } from '../types';
import type { Blueprint } from '../../sdk/types';
import { requestWithRetry } from '../http';

const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

/**
 * Retryable Notion REST call. Uses the shared `requestWithRetry` pipeline:
 * exponential backoff + jitter on transient statuses (429/500/502/503/504)
 * with explicit `Retry-After` honoring for 429 rate-limit responses, and a
 * 15-second per-attempt timeout. POSTs to pages/blocks are not strictly
 * idempotent, so retries are limited to transient server/rate-limit codes.
 */
async function notionPost<T>(
  apiKey: string,
  path:   string,
  body:   unknown,
  method: 'POST' | 'PATCH' | 'GET' = 'POST',
): Promise<T> {
  const retryable = await requestWithRetry<unknown>(`${NOTION_API}${path}`, {
    method,
    headers: {
      'Authorization':  `Bearer ${apiKey}`,
      'Content-Type':   'application/json',
      'Notion-Version': NOTION_VERSION,
    },
    body:      method !== 'GET' ? JSON.stringify(body) : undefined,
    timeout:   15_000,
    maxRetries: 3,
    retrySafe:  false, // POST creates pages/blocks; only transient codes retry
  });
  return retryable.data as T;
}

function textToRichText(text: string, maxLength = 1990): { type: 'text'; text: { content: string } }[] {
  const chunks: { type: 'text'; text: { content: string } }[] = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push({ type: 'text', text: { content: text.slice(i, i + maxLength) } });
  }
  return chunks;
}

function makeHeading(text: string, level: 1 | 2 | 3) {
  const types = { 1: 'heading_1', 2: 'heading_2', 3: 'heading_3' } as const;
  return {
    object:  'block',
    type:    types[level],
    [types[level]]: { rich_text: textToRichText(text) },
  };
}

function makeParagraph(text: string) {
  if (!text.trim()) return null;
  return {
    object:    'block',
    type:      'paragraph',
    paragraph: { rich_text: textToRichText(text.slice(0, 1990)) },
  };
}

const SECTION_LABELS: Record<string, string> = {
  executive_summary: 'Executive Summary',
  architecture:      'System Architecture',
  data_model:        'Data Model',
  api_contracts:     'API Contracts',
  security_model:    'Security Model',
  edge_cases:        'Edge Cases',
  testing_strategy:  'Testing Strategy',
  deployment:        'Deployment',
  launch_checklist:  'Launch Checklist',
  technical_debt:    'Technical Debt',
};

const plugin: IntegrationPlugin = {
  type: 'integration',

  async onLoad(ctx: PluginContext) {
    ctx.log('info', 'Notion integration loaded');
  },

  async healthCheck(ctx: PluginContext) {
    const apiKey = ctx.storage.get<string>('notion_api_key');
    if (!apiKey) return { healthy: false, message: 'No API key configured' };
    try {
      await notionPost(apiKey, '/users/me', undefined, 'GET');
      return { healthy: true, message: 'Connected to Notion' };
    } catch (e) {
      return { healthy: false, message: String(e) };
    }
  },

  async push(blueprint: Blueprint, ctx: PluginContext) {
    const apiKey   = ctx.storage.get<string>('notion_api_key');
    const parentId = ctx.storage.get<string>('notion_parent_id');

    if (!apiKey || !parentId) {
      ctx.notify('Notion: configure API key and parent page ID in plugin settings', 'error');
      throw new Error('Notion plugin not configured');
    }

    const name = blueprint.intent?.product_name ?? 'Blueprint';
    const date = new Date(blueprint.created_at).toISOString().split('T')[0];

    // Build blocks
    const blocks: unknown[] = [
      makeHeading(`${name} — Architecture Blueprint`, 1),
      makeParagraph(`Quality Score: ${blueprint.quality_score}/100 · Mode: ${blueprint.mode} · Generated: ${date}`),
      { object: 'block', type: 'divider', divider: {} },
    ].filter(Boolean);

    for (const [key, label] of Object.entries(SECTION_LABELS)) {
      const content = blueprint.sections[key];
      if (!content) continue;
      blocks.push(makeHeading(label, 2));
      const paragraphs = content.split('\n\n').filter(p => p.trim());
      for (const p of paragraphs.slice(0, 8)) {
        const block = makeParagraph(p);
        if (block) blocks.push(block);
      }
      blocks.push({ object: 'block', type: 'divider', divider: {} });
    }

    // Create page (Notion limit: 100 blocks per call)
    const chunk1 = blocks.slice(0, 100);
    interface NotionPage { id: string; url: string }
    const page = await notionPost<NotionPage>(apiKey, '/pages', {
      parent:     { page_id: parentId },
      properties: {
        title: { title: [{ type: 'text', text: { content: `${name} — Atomic Blueprint` } }] },
      },
      children: chunk1,
    });

    // Append remaining blocks if needed
    if (blocks.length > 100) {
      for (let i = 100; i < blocks.length; i += 100) {
        await notionPost(apiKey, `/blocks/${page.id}/children`, { children: blocks.slice(i, i + 100) });
      }
    }

    ctx.notify(`Blueprint exported to Notion`, 'success');
    return { url: page.url, id: page.id };
  },
};

export const exportNotionPlugin: PluginDefinition<IntegrationPlugin> = {
  manifest: {
    id:          'built-in/export-notion',
    name:        'Notion Integration',
    description: 'Export the blueprint to Notion as a structured page',
    version:     '1.0.0',
    author:      'Atomic',
    category:    'integration',
    icon:        'BookOpen',
    permissions: ['blueprint:read', 'network:outbound'],
  },
  plugin,
};
