import type { TrackerPort } from '../../ports.js';
import type { Incident, Severity } from '../../types.js';

const ENDPOINT = 'https://api.linear.app/graphql';
export const INCIDENT_LABEL = 'incident';

const PRIORITY_BY_SEVERITY: Record<Severity, number> = { sev1: 1, sev2: 2, sev3: 3 };
const SEVERITY_BY_PRIORITY: Record<number, Severity> = { 1: 'sev1', 2: 'sev2', 3: 'sev3' };

interface RawIssue {
  id: string;
  identifier: string;
  title: string;
  priority: number;
  description: string | null;
}

/**
 * Incident records live as Linear issues labeled "incident". Severity is the issue priority
 * (Urgent = sev1). The window and affected accounts are two structured lines in the description.
 */
export function formatIncidentDescription(summary: string, startedAt: string, resolvedAt: string | null, affectedCompanyIds: string[]): string {
  return [
    summary,
    '',
    `Started (UTC): ${startedAt}`,
    `Resolved (UTC): ${resolvedAt ?? 'ongoing'}`,
    `Affected HubSpot company IDs: ${affectedCompanyIds.join(', ')}`,
  ].join('\n');
}

export function parseIncident(issue: RawIssue): Incident | null {
  const text = issue.description ?? '';
  const started = /Started \(UTC\):\s*(\S+)/.exec(text)?.[1];
  const resolved = /Resolved \(UTC\):\s*(\S+)/.exec(text)?.[1];
  const affected = /Affected HubSpot company IDs:\s*([^\n]*)/.exec(text)?.[1];
  const severity = SEVERITY_BY_PRIORITY[issue.priority];
  if (!started || !severity || affected === undefined) return null;
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    severity,
    startedAt: started,
    resolvedAt: !resolved || resolved === 'ongoing' ? null : resolved,
    affectedCompanyIds: affected.split(',').map((s) => s.replace(/\\/g, '').trim()).filter(Boolean),
  };
}

export class LinearTracker implements TrackerPort {
  constructor(private readonly apiKey: string, private readonly teamKey: string) {}

  async graphql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: this.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      });
      if (response.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      const json = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
      if (!response.ok || json.errors?.length) {
        throw new Error(`Linear request failed: ${response.status} ${json.errors?.map((e) => e.message).join('; ') ?? ''}`);
      }
      return json.data as T;
    }
  }

  async listIncidents(): Promise<Incident[]> {
    const data = await this.graphql<{ issues: { nodes: RawIssue[] } }>(
      `query Incidents($team: String!, $label: String!) {
        issues(first: 100, filter: { team: { key: { eq: $team } }, labels: { name: { eq: $label } } }) {
          nodes { id identifier title priority description }
        }
      }`,
      { team: this.teamKey, label: INCIDENT_LABEL },
    );
    return data.issues.nodes.map(parseIncident).filter((i): i is Incident => i !== null);
  }

  async getIncident(incidentId: string): Promise<Incident | null> {
    try {
      const data = await this.graphql<{ issue: RawIssue | null }>(
        'query Incident($id: String!) { issue(id: $id) { id identifier title priority description } }',
        { id: incidentId },
      );
      return data.issue ? parseIncident(data.issue) : null;
    } catch (error) {
      if (error instanceof Error && /not found|Entity not found/i.test(error.message)) return null;
      throw error;
    }
  }

  /** Seeder: creates the incident label and an incident issue if one with the same title does not exist. */
  async upsertIncident(input: {
    title: string;
    summary: string;
    severity: Severity;
    startedAt: string;
    resolvedAt: string | null;
    affectedCompanyIds: string[];
  }): Promise<string> {
    const team = await this.graphql<{ teams: { nodes: Array<{ id: string; labels: { nodes: Array<{ id: string; name: string }> } }> } }>(
      'query Team($key: String!) { teams(filter: { key: { eq: $key } }) { nodes { id labels { nodes { id name } } } } }',
      { key: this.teamKey },
    );
    const teamNode = team.teams.nodes[0];
    if (!teamNode) throw new Error(`Linear team ${this.teamKey} not found`);
    let labelId = teamNode.labels.nodes.find((l) => l.name === INCIDENT_LABEL)?.id;
    if (!labelId) {
      const created = await this.graphql<{ issueLabelCreate: { issueLabel: { id: string } } }>(
        'mutation Label($teamId: String!, $name: String!) { issueLabelCreate(input: { teamId: $teamId, name: $name, color: "#B4452F" }) { issueLabel { id } } }',
        { teamId: teamNode.id, name: INCIDENT_LABEL },
      );
      labelId = created.issueLabelCreate.issueLabel.id;
    }
    const description = formatIncidentDescription(input.summary, input.startedAt, input.resolvedAt, input.affectedCompanyIds);
    const existing = (
      await this.graphql<{ issues: { nodes: RawIssue[] } }>(
        `query Existing($team: String!, $title: String!) {
          issues(first: 5, filter: { team: { key: { eq: $team } }, title: { eq: $title } }) { nodes { id identifier title priority description } }
        }`,
        { team: this.teamKey, title: input.title },
      )
    ).issues.nodes[0];
    if (existing) {
      await this.graphql(
        'mutation Update($id: String!, $description: String!, $priority: Int!, $labelIds: [String!]) { issueUpdate(id: $id, input: { description: $description, priority: $priority, labelIds: $labelIds }) { success } }',
        { id: existing.id, description, priority: PRIORITY_BY_SEVERITY[input.severity], labelIds: [labelId] },
      );
      return existing.id;
    }
    const created = await this.graphql<{ issueCreate: { issue: { id: string } } }>(
      'mutation Create($teamId: String!, $title: String!, $description: String!, $priority: Int!, $labelIds: [String!]) { issueCreate(input: { teamId: $teamId, title: $title, description: $description, priority: $priority, labelIds: $labelIds }) { issue { id } } }',
      { teamId: teamNode.id, title: input.title, description, priority: PRIORITY_BY_SEVERITY[input.severity], labelIds: [labelId] },
    );
    return created.issueCreate.issue.id;
  }
}
