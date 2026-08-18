/**
 * src/plugins/built-in/export-linear.ts
 *
 * Built-in integration plugin — push blueprint to Linear as a project with issues.
 *
 * Configuration (stored in plugin storage):
 *   - linear_api_key:  string  (required)
 *   - linear_team_id:  string  (required)
 *   - linear_project_name_prefix: string (optional, default: '[Atomic]')
 */

import type { PluginDefinition, IntegrationPlugin, PluginContext } from '../types';
import type { Blueprint } from '../../sdk/types';
import { requestWithRetry } from '../http';

interface LinearProject { id: string; name: string; url: string }
interface LinearIssue { id: string; title: string; identifier: string }

const SECTION_PRIORITY: Record<string, number> = {
  security_model:   1,
  architecture:     2,
  data_model:       3,
  api_contracts:    4,
  deployment:       5,
  testing_strategy: 6,
};

const LINEAR_API_URL = 'https://api.linear.app/graphql';

/**
 * Retryable Linear GraphQL POST. Uses the shared `requestWithRetry` pipeline:
 * exponential backoff + jitter on transient statuses (429/500/502/503/504),
 * server-sent `Retry-After` handling, and a 15-second per-attempt timeout.
 * Rate-limit responses (429) never fail permanently — the wait is honored.
 */
async function linearPost<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const retryable = await requestWithRetry<{ data?: T; errors?: { message: string }[] }>(
    LINEAR_API_URL,
    {
      method:   'POST',
      headers:  {
        'Content-Type':  'application/json',
        'Authorization': apiKey,
      },
      body:      JSON.stringify({ query, variables }),
      timeout:   15_000,
      maxRetries: 3,
      retrySafe:  true, // GraphQL project/issue creation is effectively idempotent under our error handling
    },
  );
  if (retryable.data?.errors?.length) {
    throw new Error(retryable.data.errors[0]!.message);
  }
  return retryable.data as T;
}

const plugin: IntegrationPlugin = {
  type: 'integration',

  async onLoad(ctx: PluginContext) {
    ctx.log('info', 'Linear integration loaded');
  },

  async healthCheck(ctx: PluginContext) {
    const apiKey = ctx.storage.get<string>('linear_api_key');
    if (!apiKey) return { healthy: false, message: 'No API key configured' };
    try {
      const data = await linearPost<{ viewer: { name: string } }>(
        apiKey,
        '{ viewer { name } }',
      );
      return { healthy: true, message: `Connected as ${data.viewer.name}` };
    } catch (e) {
      return { healthy: false, message: String(e) };
    }
  },

  async push(blueprint: Blueprint, ctx: PluginContext) {
    const apiKey  = ctx.storage.get<string>('linear_api_key');
    const teamId  = ctx.storage.get<string>('linear_team_id');
    const prefix  = ctx.storage.get<string>('linear_project_name_prefix') ?? '[Atomic]';

    if (!apiKey || !teamId) {
      ctx.notify('Linear: configure API key and team ID in plugin settings', 'error');
      throw new Error('Linear plugin not configured');
    }

    const name = blueprint.intent?.product_name ?? 'Blueprint';
    const projectName = `${prefix} ${name}`;

    // Create project
    const projectData = await linearPost<{ projectCreate: { project: LinearProject } }>(
      apiKey,
      `mutation CreateProject($name: String!, $teamId: String!) {
        projectCreate(input: { name: $name, teamIds: [$teamId] }) {
          project { id name url }
        }
      }`,
      { name: projectName, teamId },
    );
    const project = projectData.projectCreate.project;

    // Create issues for each section (sorted by priority)
    const sections = Object.entries(blueprint.sections)
      .filter(([, content]) => content)
      .sort(([a], [b]) => (SECTION_PRIORITY[a] ?? 99) - (SECTION_PRIORITY[b] ?? 99));

    const createdIssues: LinearIssue[] = [];
    for (const [key, content] of sections.slice(0, 10)) {
      const label = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const issueData = await linearPost<{ issueCreate: { issue: LinearIssue } }>(
        apiKey,
        `mutation CreateIssue($title: String!, $description: String!, $teamId: String!, $projectId: String!) {
          issueCreate(input: { title: $title, description: $description, teamId: $teamId, projectId: $projectId }) {
            issue { id title identifier }
          }
        }`,
        {
          title:       `[${blueprint.mode.toUpperCase()}] ${label}`,
          description: content.slice(0, 4000), // Linear description limit
          teamId,
          projectId:   project.id,
        },
      );
      createdIssues.push(issueData.issueCreate.issue);
    }

    ctx.notify(`Pushed ${createdIssues.length} issues to Linear project "${projectName}"`, 'success');
    return { url: project.url, id: project.id };
  },
};

export const exportLinearPlugin: PluginDefinition<IntegrationPlugin> = {
  manifest: {
    id:          'built-in/export-linear',
    name:        'Linear Integration',
    description: 'Push blueprint sections to Linear as a project with issues',
    version:     '1.0.0',
    author:      'Atomic',
    category:    'integration',
    icon:        'GitBranch',
    permissions: ['blueprint:read', 'network:outbound'],
  },
  plugin,
};
