import { formatUsd, RENEWAL_WINDOW_DAYS } from '../policy.js';
import type { CaseRecord } from '../runtime/caseStore.js';
import type { CaseSnapshot, Cents, CheckResult } from '../types.js';

export const APPROVE_ACTION = 'twiceshy_approve';
const DAY_MS = 24 * 60 * 60 * 1000;

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function renewalLine(snapshot: CaseSnapshot, now: Date): string {
  const { company } = snapshot;
  if (!company.renewalDate) return '';
  const days = Math.ceil((Date.parse(company.renewalDate) - now.getTime()) / DAY_MS);
  const value = company.annualValueMinor > 0 ? ` (${formatUsd(company.annualValueMinor)} a year)` : '';
  if (days < 0) return `${company.name} renewal date has passed${value}.`;
  const soon = days <= RENEWAL_WINDOW_DAYS ? `renews in ${days} days` : `renews on ${shortDate(company.renewalDate)}`;
  return `${company.name} ${soon}${value}.`;
}

/** The message the customer will read. Fixed template: no model text reaches the customer. */
export function customerReply(snapshot: CaseSnapshot, creditMinor: Cents): string {
  const { company, incident } = snapshot;
  return `Thanks for your patience with the ${incident.title.toLowerCase()} on ${shortDate(incident.startedAt)}. We have added a ${formatUsd(creditMinor)} credit to the ${company.name} account, and it will apply to your next invoice. Sorry again for the disruption.`;
}

/** One sentence built from verified records and code-run searches, never from model prose. */
export function decisionLine(record: CaseRecord): string {
  const snapshot = record.snapshot;
  if (!snapshot) return '';
  const search = record.searches.at(-1);
  const searched = search
    ? `Searched HubSpot for "${search.query}": ${search.matches.length} ${search.matches.length === 1 ? 'match' : 'matches'}${search.matches.length > 1 ? ` (${search.matches.join(', ')})` : ''}. `
    : '';
  const why = snapshot.incident.affectedCompanyIds.includes(snapshot.company.id)
    ? `because ${snapshot.incident.identifier} in Linear (${shortDate(snapshot.incident.startedAt)}) lists it as affected`
    : `although ${snapshot.incident.identifier} in Linear does not list it`;
  const promise = record.proposal?.kind === 'resolved' ? record.proposal.promise : null;
  const quoted = promise ? ` Promise in the thread: "${promise.quote}" from <@${promise.authorUserId}>.` : '';
  return `${searched}Picked ${snapshot.company.name} ${why}.${quoted}`;
}

function headline(record: CaseRecord, now: Date): string {
  const { verdict, snapshot } = record;
  if (!snapshot || verdict.creditMinor === null) return 'The agent could not settle this thread. It needs a person.';
  const action = `a ${formatUsd(verdict.creditMinor)} credit to ${snapshot.company.name} for the ${shortDate(snapshot.incident.startedAt)} outage (${snapshot.incident.identifier})`;
  const renewal = renewalLine(snapshot, now);
  if (verdict.status === 'PASS') return `Approve ${action}. ${renewal}`.trim();
  if (verdict.status === 'HOLD') return `Needs a manager: ${action}. ${renewal}`.trim();
  return `Blocked: ${action}. ${renewal}`.trim();
}

function riskLine(record: CaseRecord): string {
  const failing = record.verdict.checks.filter((c) => !c.ok);
  if (record.verdict.status === 'PASS') return '';
  const prefix = record.verdict.status === 'BLOCK' ? 'Do not approve: ' : 'Why it is on hold: ';
  if (failing.length > 0) return prefix + failing.map((c) => c.detail).join(' ');
  if (record.verificationDetail) return prefix + record.verificationDetail;
  if (record.verdict.reasons.includes('INCIDENT_NOT_ELIGIBLE')) return `${prefix}this incident does not qualify for an SLA credit under the policy.`;
  return prefix + record.verdict.reasons.join(', ');
}

function checksLine(checks: CheckResult[]): string {
  if (checks.length === 0) return '';
  const passed = checks.filter((c) => c.ok).length;
  return `Checks: ${passed} of ${checks.length} passed`;
}

export interface Card {
  text: string;
  blocks: unknown[];
}

const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text } });
const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text }] });

export function buildCard(record: CaseRecord, now: Date = new Date()): Card {
  const top = headline(record, now);
  const blocks: unknown[] = [section(`*${top}*`)];
  const risk = riskLine(record);
  if (risk) blocks.push(section(risk));
  const decision = decisionLine(record);
  if (decision) blocks.push(context(decision));

  if (record.proposal?.kind === 'ambiguous') {
    const candidates = record.proposal.candidates.map((c) => `${c.companyId}: ${c.why}`).join('\n');
    blocks.push(section(`*Question for the CSM:* ${record.proposal.question}\n${candidates}`));
  }

  if (record.snapshot && record.verdict.creditMinor !== null && record.verdict.status !== 'BLOCK') {
    blocks.push(section(`*Reply the customer will get:*\n>${customerReply(record.snapshot, record.verdict.creditMinor)}`));
  }

  const checks = checksLine(record.verdict.checks);
  const support = record.verdict.checks.map((c) => `${c.ok ? 'OK' : 'FAILED'}  ${c.detail}`).join('\n');
  if (checks) blocks.push(context(`*${checks}*\n${support}`));

  if (record.outcome) {
    blocks.push(section(outcomeLine(record)));
  } else if (record.verdict.status === 'PASS') {
    blocks.push({
      type: 'actions',
      elements: [{ type: 'button', text: { type: 'plain_text', text: 'Approve' }, style: 'primary', action_id: APPROVE_ACTION, value: record.runId }],
    });
  }
  blocks.push(context(`Run ${record.runId}`));
  return { text: top, blocks };
}

export function outcomeLine(record: CaseRecord): string {
  const outcome = record.outcome;
  if (!outcome) return '';
  const who = record.approval ? `<@${record.approval.userId}>` : 'Someone';
  if (outcome.status === 'blocked') return `${who} pressed Approve. TwiceShy re-checked the apps and stopped: ${outcome.detail ?? outcome.reasons.join(', ')}`;
  if (outcome.status === 'failed') return `Approved by ${who}, but execution stopped: ${outcome.detail ?? 'unknown error'}. A person needs to look.`;
  const resumed = outcome.resumed.length > 0 ? ' Resumed after interruption, nothing was done twice.' : '';
  return `Approved by ${who}. Paid ${outcome.creditMinor === null ? '' : formatUsd(outcome.creditMinor)} once.${resumed}`;
}

export function receiptText(record: CaseRecord): string {
  const o = record.outcome;
  if (!o) return '';
  const lines = [
    outcomeLine(record),
    `Stripe balance credit: ${o.objects.stripe_credit ?? 'not created'}`,
    `HubSpot note: ${o.objects.hubspot_note ?? 'not created'}`,
    `Slack reply to the customer: ${o.objects.slack_reply ?? 'not sent'}`,
  ];
  if (o.resumed.length > 0) lines.push(`Resumed after interruption at: ${o.resumed.join(', ')}`);
  return lines.join('\n');
}
