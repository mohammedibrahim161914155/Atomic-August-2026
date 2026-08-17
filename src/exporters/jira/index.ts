/**
 * src/exporters/jira/index.ts
 *
 * Export Adapter — JIRA Bulk Import CSV (Part 8.2 — Addition 8)
 *
 * Usage: POST /api/v1/blueprints/:id/export-action with { format: "jira" }
 */

import type { Blueprint } from '../../engine/types';

export interface JiraCsvRow {
  'Issue Type': string;
  Summary: string;
  Description: string;
  Priority: string;
  Labels: string;
  'Story Points': string;
  'Epic Name': string;
  'Epic Link': string;
  'Acceptance Criteria': string;
  'Custom field (Blueprint ID)': string;
}

export interface JiraExportResult {
  csv: string;
  rows: JiraCsvRow[];
  totalRows: number;
  exportedAt: string;
}

const PRIORITY_MAP: Record<string, string> = {
  security_model:    'Highest',
  architecture:      'High',
  data_model:        'High',
  api_contracts:     'High',
  deployment:        'High',
  edge_cases:        'Medium',
  testing_strategy:  'Medium',
  launch_checklist:  'Medium',
  executive_summary: 'Low',
  technical_debt:    'Low',
};

function escapeCsv(value: string): string {
  if (!value) return '';
  const escaped = value.replace(/"/g, '""');
  if (escaped.includes(',') || escaped.includes('\n') || escaped.includes('"')) {
    return `"${escaped}"`;
  }
  return escaped;
}

function toCsvLine(row: string[]): string {
  return row.map(escapeCsv).join(',');
}

function extractTasks(content: string, limit = 10): string[] {
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

/**
 * Export a Blueprint as a JIRA bulk import CSV string.
 */
export function exportToJiraCsv(
  blueprint: Blueprint,
  blueprintId: string,
  opts: { projectKey?: string; labelPrefix?: string } = {},
): JiraExportResult {
  const rows: JiraCsvRow[] = [];
  const labelPrefix = opts.labelPrefix ?? 'atomic';
  const appName = blueprint.intent?.product_name ?? 'Blueprint';
  const epicName = `${appName} Implementation`;

  // Epic
  rows.push({
    'Issue Type': 'Epic',
    Summary: epicName,
    Description: `Atomic blueprint implementation epic.\n\nBlueprint ID: ${blueprintId}\nQuality Score: ${blueprint.quality_score ?? 'N/A'}/100`,
    Priority: 'High',
    Labels: `${labelPrefix},blueprint-generated`,
    'Story Points': '',
    'Epic Name': epicName,
    'Epic Link': '',
    'Acceptance Criteria': '',
    'Custom field (Blueprint ID)': blueprintId,
  });

  for (const [key, content] of Object.entries(blueprint.sections)) {
    if (!content || typeof content !== 'string') continue;

    const sectionTitle = key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const priority = PRIORITY_MAP[key] ?? 'Medium';
    const tasks = extractTasks(content);

    if (tasks.length === 0) {
      rows.push({
        'Issue Type': 'Story',
        Summary: `Implement ${sectionTitle}`,
        Description: content.slice(0, 1000),
        Priority: priority,
        Labels: `${labelPrefix},${key.replace(/_/g, '-')},blueprint-generated`,
        'Story Points': '3',
        'Epic Name': '',
        'Epic Link': epicName,
        'Acceptance Criteria': `Feature works according to blueprint specification for ${sectionTitle}`,
        'Custom field (Blueprint ID)': blueprintId,
      });
    } else {
      for (const task of tasks) {
        rows.push({
          'Issue Type': 'Task',
          Summary: task.length > 200 ? task.slice(0, 197) + '...' : task,
          Description: `${task}\n\nContext:\n${content.slice(0, 500)}\n\nBlueprint ID: ${blueprintId}`,
          Priority: priority,
          Labels: `${labelPrefix},${key.replace(/_/g, '-')},blueprint-generated`,
          'Story Points': '2',
          'Epic Name': '',
          'Epic Link': epicName,
          'Acceptance Criteria': `Implementation matches blueprint specification for ${sectionTitle}`,
          'Custom field (Blueprint ID)': blueprintId,
        });
      }
    }
  }

  const headers = Object.keys(rows[0] ?? {}) as (keyof JiraCsvRow)[];
  const csvLines = [
    toCsvLine(headers),
    ...rows.map(row => toCsvLine(headers.map(h => row[h] ?? ''))),
  ];

  return {
    csv: csvLines.join('\n'),
    rows,
    totalRows: rows.length,
    exportedAt: new Date().toISOString(),
  };
}
