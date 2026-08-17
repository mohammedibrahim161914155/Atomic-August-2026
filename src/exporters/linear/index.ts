/**
 * src/exporters/linear/index.ts
 *
 * Export Adapter — Linear Issues JSON (Part 8.2 — Addition 8)
 *
 * Converts a Blueprint into Linear's issue format for bulk creation via API.
 *
 * Usage: POST /api/v1/blueprints/:id/export-action with { format: "linear" }
 */

import type { Blueprint } from '../../engine/types';

type LinearPriority = 0 | 1 | 2 | 3 | 4;

export interface LinearIssue {
  title: string;
  description: string;
  priority: LinearPriority;
  labelNames: string[];
  estimate?: number;
}

export interface LinearProject {
  name: string;
  description: string;
  color?: string;
  issues: LinearIssue[];
}

export interface LinearExportResult {
  teamKey?: string;
  projects: LinearProject[];
  totalIssues: number;
  exportedAt: string;
  importInstructions: string;
}

const SECTION_PRIORITY: Record<string, LinearPriority> = {
  security_model:   1,
  architecture:     2,
  data_model:       2,
  api_contracts:    2,
  deployment:       2,
  edge_cases:       3,
  testing_strategy: 3,
  executive_summary: 4,
  launch_checklist: 3,
  technical_debt:   4,
};

const SECTION_ESTIMATE: Record<string, number> = {
  architecture:      8,
  data_model:        5,
  api_contracts:     5,
  security_model:    5,
  edge_cases:        3,
  testing_strategy:  3,
  deployment:        5,
  executive_summary: 1,
  launch_checklist:  2,
  technical_debt:    3,
};

function extractTasks(content: string, limit = 15): string[] {
  const tasks: string[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (/^(-\s*\[[ x]\]|[\d]+\.|[•*-])\s+/.test(trimmed)) {
      const task = trimmed.replace(/^(-\s*\[[ x]\]|[\d]+\.|[•*-])\s+/, '').trim();
      if (task.length > 10 && task.length < 200) tasks.push(task);
    }
  }
  return tasks.slice(0, limit);
}

function buildDesc(task: string, context: string, blueprintId: string): string {
  return `${context.slice(0, 500)}${context.length > 500 ? '...' : ''}

---

**Blueprint ID**: \`${blueprintId}\`

### Acceptance Criteria
- [ ] Meets blueprint specification
- [ ] Tests written and passing
- [ ] Security review passed`;
}

/**
 * Export a Blueprint as Linear issues.
 */
export function exportToLinearIssues(
  blueprint: Blueprint,
  blueprintId: string,
  opts: { teamKey?: string; labelPrefix?: string } = {},
): LinearExportResult {
  const projects: LinearProject[] = [];
  const labelPrefix = opts.labelPrefix ?? 'atomic';
  const appName = blueprint.intent?.product_name ?? 'Blueprint';

  for (const [key, content] of Object.entries(blueprint.sections)) {
    if (!content || typeof content !== 'string') continue;

    const sectionTitle = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const priority: LinearPriority = SECTION_PRIORITY[key] ?? 3;
    const estimate = SECTION_ESTIMATE[key] ?? 2;
    const tasks = extractTasks(content);

    const issueList: LinearIssue[] = (tasks.length > 0 ? tasks : [`Implement ${sectionTitle}`]).map(task => ({
      title: task.length > 120 ? task.slice(0, 117) + '...' : task,
      description: buildDesc(task, content, blueprintId),
      priority,
      estimate,
      labelNames: [labelPrefix, key.replace(/_/g, '-'), `blueprint-${blueprintId.slice(0, 8)}`],
    }));

    projects.push({
      name: `${appName} — ${sectionTitle}`,
      description: `Blueprint ID: \`${blueprintId}\``,
      color: priority === 1 ? '#e5484d' : priority === 2 ? '#ff8800' : '#0ea5e9',
      issues: issueList,
    });
  }

  const totalIssues = projects.reduce((sum, p) => sum + p.issues.length, 0);

  return {
    teamKey: opts.teamKey,
    projects,
    totalIssues,
    exportedAt: new Date().toISOString(),
    importInstructions: `Use the Linear GraphQL API (issueCreate mutation) to import ${totalIssues} issues across ${projects.length} projects. Blueprint ID: ${blueprintId}`,
  };
}
