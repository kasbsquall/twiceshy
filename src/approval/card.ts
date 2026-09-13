import { formatUsd, RENEWAL_WINDOW_DAYS } from '../policy.js';
import type { CaseRecord } from '../runtime/caseStore.js';
import type { CaseSnapshot, Cents, CheckResult } from '../types.js';

export const APPROVE_ACTION = 'twiceshy_approve';
const DAY_MS = 24 * 60 * 60 * 1000;

// Slack Block Kit limits.
const HEADER_MAX = 150;
const BUTTON_MAX = 75;
const CONFIRM_TITLE_MAX = 100;
const FIELD_MAX = 2000;
const SECTION_MAX = 3000;

const CONFIRM_TEXT = 'TwiceShy re-reads Stripe, HubSpot and Linear first. If anything changed since this card was posted, nothing is credited.';
const HOLD_NOTE = 'A CS manager should confirm the amount in the thread before anyone credits this.';

export function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function timeOf(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 3)}...`);
/** Slack mrkdwn control characters, so record text can never become a mention or a link. */
const esc = (text: string): string => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renewalLine(snapshot: CaseSnapshot, now: Date): string {
  const { company } = snapshot;
  if (!company.renewalDate) return '';
  const days = Math.ceil((Date.parse(company.renewalDate) - now.getTime()) / DAY_MS);
  const value = company.annualValueMinor > 0 ? ` (${formatUsd(company.annualValueMinor)} a year)` : '';
  if (days < 0) return `${company.name} renewal date has passed${value}.`;
  const soon = days <= RENEWAL_WINDOW_DAYS ? `renews in ${days} days` : `renews on ${shortDate(company.renewalDate)}`;
  return `${company.name} ${soon}${value}.`;
}

function renewalField(snapshot: CaseSnapshot, now: Date): string {
  const { company } = snapshot;
  const days = Math.ceil((Date.parse(company.renewalDate) - now.getTime()) / DAY_MS);
  let when = `On ${shortDate(company.renewalDate)}`;
  if (days < 0) when = `Passed on ${shortDate(company.renewalDate)}`;
  else if (days === 0) when = 'Today';
  else if (days <= RENEWAL_WINDOW_DAYS) when = `In ${days} ${days === 1 ? 'day' : 'days'}`;
  return company.annualValueMinor > 0 ? `${when}, ${formatUsd(company.annualValueMinor)} a year` : when;
}

/** The message the customer will read. Fixed template: no model text reaches the customer. */
export function customerReply(snapshot: CaseSnapshot, creditMinor: Cents): string {
  return `Thanks for your patience during the outage on ${shortDate(snapshot.incident.startedAt)}. We have added a ${formatUsd(creditMinor)} credit to your account, and it will apply to your next invoice. Sorry for the disruption.`;
}

/** Only when the HubSpot search was ambiguous: which match was picked, from code-run searches and Linear. */
export function decisionLine(record: CaseRecord): string {
  const snapshot = record.snapshot;
  const search = record.searches.at(-1);
  if (!snapshot || !search || search.matches.length <= 1) return '';
  const { company, incident } = snapshot;
  const n = search.matches.length;
  const names = search.matches.join(', ');
  const picked = search.matches.includes(company.name)
    ? `${company.name} is 1 of ${n} HubSpot matches for "${search.query}" (${names}).`
    : `${company.name} is not among the ${n} HubSpot matches for "${search.query}" (${names}).`;
  const listed = incident.affectedCompanyIds.includes(company.id) ? 'lists it as affected' : 'does not list it';
  return `${picked} ${incident.identifier} in Linear ${listed}.`;
}

type State = 'needs_person' | 'pending' | 'hold' | 'blocked' | 'done' | 'stopped' | 'failed';

function stateOf(record: CaseRecord, amount: Cents | null): State {
  const outcome = record.outcome;
  if (!record.snapshot) return 'needs_person';
  if (outcome?.status === 'done') return 'done';
  if (outcome?.status === 'blocked' && Object.keys(outcome.objects).length === 0) return 'stopped';
  if (outcome) return 'failed';
  if (amount === null) return 'needs_person';
  if (record.verdict.status === 'PASS') return 'pending';
  return record.verdict.status === 'HOLD' ? 'hold' : 'blocked';
}

/** A duplicate that is also the only change since posting is one fact: the credit arrived late. */
function lateDuplicate(record: CaseRecord): boolean {
  const checks = record.verdict.checks;
  const duplicate = checks.find((c) => c.check === 'duplicate_credit' && !c.ok);
  const stale = checks.find((c) => c.check === 'stale_state' && !c.ok);
  const before = record.snapshot;
  const after = record.approval?.snapshot;
  if (!duplicate || !stale || stale.reason !== 'STALE_STATE' || stale.evidence.length === 0 || !before || !after) return false;
  const duplicateIds = new Set(duplicate.evidence.map((e) => e.id));
  return (
    stale.evidence.every((e) => duplicateIds.has(e.id)) &&
    before.company.slaTier === after.company.slaTier &&
    before.company.stripeCustomerId === after.company.stripeCustomerId &&
    before.incident.severity === after.incident.severity &&
    before.incident.affectedCompanyIds.join() === after.incident.affectedCompanyIds.join()
  );
}

function existingCredit(check: CheckResult | undefined, snapshot: CaseSnapshot) {
  const id = check?.evidence[0]?.id;
  return id ? snapshot.credits.find((c) => c.id === id) : undefined;
}

function duplicateText(check: CheckResult, snapshot: CaseSnapshot, lateInline: boolean, past: boolean): string {
  const credit = existingCredit(check, snapshot);
  if (!credit) return check.detail;
  const late = lateInline ? ', after this card was posted' : '';
  return `${snapshot.company.name} already received a ${formatUsd(credit.amountMinor)} credit in Stripe at ${timeOf(credit.createdAt)} UTC${late}. Approving would ${past ? 'have credited' : 'credit'} them twice.`;
}

interface CheckItem {
  ok: boolean;
  text: string;
}

function checkItems(record: CaseRecord, snapshot: CaseSnapshot, past: boolean): CheckItem[] {
  const late = lateDuplicate(record);
  return record.verdict.checks
    .filter((c) => !(late && c.check === 'stale_state'))
    .map((c) => {
      if (c.check !== 'duplicate_credit' || c.ok) return { ok: c.ok, text: c.detail };
      // The summary above already tells the story; the check line stays a short fact.
      const credit = existingCredit(c, snapshot);
      if (!credit) return { ok: false, text: duplicateText(c, snapshot, late, past) };
      return { ok: false, text: `Already credited ${formatUsd(credit.amountMinor)} in Stripe at ${timeOf(credit.createdAt)} UTC${late ? ', after this card was posted' : ''}` };
    });
}

/** Why the credit must not go ahead, from failing checks first, then verification and policy facts. */
function failingText(record: CaseRecord, snapshot: CaseSnapshot | null, past: boolean): string {
  const late = lateDuplicate(record);
  const texts = record.verdict.checks
    .filter((c) => !c.ok && !(late && c.check === 'stale_state'))
    .map((c) => (c.check === 'duplicate_credit' && snapshot ? duplicateText(c, snapshot, late, past) : c.detail));
  if (record.verdict.reasons.includes('INCIDENT_NOT_ELIGIBLE')) texts.push('This incident does not qualify for an SLA credit under the policy.');
  if (texts.length > 0) return texts.join(' ');
  if (record.outcome?.detail) return record.outcome.detail;
  if (record.verificationDetail) return record.verificationDetail;
  return record.verdict.reasons.join(', ');
}

export interface Card {
  text: string;
  blocks: unknown[];
}

const plain = (text: string) => ({ type: 'plain_text', text });
const header = (text: string) => ({ type: 'header', text: plain(clip(text, HEADER_MAX)) });
const section = (text: string) => ({ type: 'section', text: { type: 'mrkdwn', text: clip(text, SECTION_MAX) } });
const context = (text: string) => ({ type: 'context', elements: [{ type: 'mrkdwn', text: clip(text, SECTION_MAX) }] });

function promiseField(record: CaseRecord, snapshot: CaseSnapshot): string | null {
  const promise = record.proposal?.kind === 'resolved' ? record.proposal.promise : null;
  if (!promise) return null;
  const author = snapshot.thread.find((m) => m.ts === promise.messageTs)?.authorName;
  const isUser = !promise.authorUserId.startsWith('bot:') && /^\w+$/.test(promise.authorUserId);
  const who = author ? esc(author) : isUser ? `<@${promise.authorUserId}>` : 'An app user';
  return `*Promised by*\n${who} in the thread: "${esc(promise.quote)}"`;
}

function fieldsBlock(record: CaseRecord, snapshot: CaseSnapshot, now: Date, showRenewal: boolean) {
  const { incident, company } = snapshot;
  const fields = [`*Incident*\n${esc(`${incident.identifier}, ${incident.title} on ${shortDate(incident.startedAt)}`)}`];
  const promise = promiseField(record, snapshot);
  if (promise) fields.push(promise);
  if (showRenewal && company.renewalDate) fields.push(`*Renewal*\n${esc(renewalField(snapshot, now))}`);
  return { type: 'section', fields: fields.map((text) => ({ type: 'mrkdwn', text: clip(text, FIELD_MAX) })) };
}

function checksBlock(items: CheckItem[], collapse: boolean): unknown | null {
  if (items.length === 0) return null;
  const failed = items.filter((i) => !i.ok);
  if (collapse && failed.length === 0) return context(`All ${items.length} checks passed, including a re-check right before crediting.`);
  const summary = failed.length === 0 ? `*All ${items.length} checks passed*` : `*${failed.length} ${failed.length === 1 ? 'check' : 'checks'} failed*`;
  const lines = [...failed.map((i) => `*FAILED*  ${esc(i.text)}`), ...items.filter((i) => i.ok).map((i) => `Passed  ${esc(i.text)}`)];
  return section([summary, ...lines].join('\n'));
}

function approveButton(record: CaseRecord, snapshot: CaseSnapshot, amount: Cents) {
  const money = formatUsd(amount);
  return {
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: plain(clip(`Approve ${money} credit`, BUTTON_MAX)),
        style: 'primary',
        action_id: APPROVE_ACTION,
        value: record.runId,
        confirm: {
          title: plain(clip(`Credit ${money} to ${snapshot.company.name}?`, CONFIRM_TITLE_MAX)),
          text: plain(CONFIRM_TEXT),
          confirm: plain('Approve'),
          deny: plain('Cancel'),
        },
      },
    ],
  };
}

function headlines(record: CaseRecord, state: State, snapshot: CaseSnapshot | null, amount: Cents | null, now: Date): { title: string; text: string } {
  if (!snapshot || state === 'needs_person') {
    return { title: 'This request needs a person', text: 'This request needs a person: TwiceShy could not settle the thread from the records.' };
  }
  const name = snapshot.company.name;
  const money = amount === null ? '' : `${formatUsd(amount)} `;
  const { incident } = snapshot;
  const forIncident = `for ${incident.identifier} (${incident.title}, ${shortDate(incident.startedAt)})`;
  const renewal = renewalLine(snapshot, now);
  const withRenewal = (sentence: string) => `${sentence} ${renewal}`.trim();
  switch (state) {
    case 'pending':
      return { title: `Approve ${money}credit to ${name}`, text: withRenewal(`Approve a ${money}credit to ${name} ${forIncident}.`) };
    case 'hold':
      return { title: `On hold: ${money}credit to ${name}`, text: withRenewal(`On hold: a ${money}credit to ${name} ${forIncident}.`) };
    case 'blocked':
      return { title: `Blocked: ${money}credit to ${name}`, text: withRenewal(`Blocked: a ${money}credit to ${name} ${forIncident}.`) };
    case 'done':
      return { title: `Credited ${money}to ${name}`, text: withRenewal(`Credited ${money}to ${name} ${forIncident}.`) };
    case 'failed':
      return { title: `Needs a person: ${money}credit to ${name}`, text: `Needs a person: the ${money}credit to ${name} ${forIncident} stopped partway.` };
    case 'stopped': {
      const duplicate = record.verdict.checks.find((c) => c.check === 'duplicate_credit' && !c.ok);
      const credit = existingCredit(duplicate, snapshot);
      if (credit) {
        const already = `${name} was already credited ${formatUsd(credit.amountMinor)}`;
        return { title: `Stopped: ${already}`, text: `Stopped: ${already}, so nothing was credited ${forIncident}.` };
      }
      return { title: `Stopped: nothing was credited to ${name}`, text: `Stopped: nothing was credited to ${name} ${forIncident}.` };
    }
  }
}

export function buildCard(original: CaseRecord, now: Date = new Date()): Card {
  // After Approve, the card shows the re-check, not the verdict from when it was posted.
  const record: CaseRecord = original.approval ? { ...original, verdict: original.approval.verdict } : original;
  const snapshot = record.approval?.snapshot ?? record.snapshot;
  const amount = record.outcome?.creditMinor ?? record.verdict.creditMinor ?? original.verdict.creditMinor;
  const state = stateOf(record, amount);
  const { title, text } = headlines(record, state, snapshot, amount, now);
  const blocks: unknown[] = [header(title)];
  const past = state === 'stopped' || state === 'failed';

  if (snapshot && state !== 'needs_person') blocks.push(fieldsBlock(record, snapshot, now, state !== 'stopped'));

  if (state === 'stopped') {
    blocks.push(section(`*Nothing was credited and no reply was sent.* ${esc(failingText(record, snapshot, true))}`));
  } else if (state === 'done' || state === 'failed') {
    blocks.push(section(outcomeLine(record)));
  } else if (record.verdict.status !== 'PASS') {
    const prefix = record.verdict.status === 'BLOCK' ? '*Do not approve:*' : '*Why it is on hold:*';
    blocks.push(section(`${prefix} ${esc(failingText(record, snapshot, false))}`));
    if (state === 'hold') blocks.push(context(HOLD_NOTE));
  }

  if (record.proposal?.kind === 'ambiguous') {
    const candidates = record.proposal.candidates.map((c) => `${c.companyId}: ${c.why}`).join('\n');
    blocks.push(section(`*Question for the CSM:* ${esc(record.proposal.question)}\n${esc(candidates)}`));
  }

  if (state !== 'stopped') {
    const decision = decisionLine(record);
    if (decision) blocks.push(context(esc(decision)));
  }

  const items = snapshot ? checkItems(record, snapshot, past) : [];
  // A stop raised after the re-check (on a retried credit) is explained above; old passing checks would contradict it.
  const checks = state === 'stopped' && items.every((i) => i.ok) ? null : checksBlock(items, state === 'done');
  if (checks) blocks.push(checks);

  if (snapshot && amount !== null && (state === 'pending' || state === 'hold' || state === 'done')) {
    const label = state === 'done' ? 'Reply sent to the customer' : 'Reply the customer will get';
    blocks.push(section(`*${label}:*\n>${esc(customerReply(snapshot, amount))}`));
  }

  if (state === 'stopped') {
    const who = record.approval ? `<@${record.approval.userId}>` : 'Someone';
    blocks.push(context(`${who} pressed Approve. TwiceShy re-read Stripe, HubSpot and Linear first and stopped.`));
  }
  if (state === 'pending' && snapshot && amount !== null) blocks.push(approveButton(record, snapshot, amount));

  blocks.push(context(`Run ID: ${record.runId}`));
  return { text, blocks };
}

export function outcomeLine(record: CaseRecord): string {
  const outcome = record.outcome;
  if (!outcome) return '';
  const who = record.approval ? `<@${record.approval.userId}>` : 'Someone';
  if (outcome.status === 'blocked' && Object.keys(outcome.objects).length === 0) {
    return `${who} pressed Approve. TwiceShy re-read Stripe, HubSpot and Linear first and stopped. Nothing was credited and no reply was sent.`;
  }
  if (outcome.status !== 'done') {
    const detail = esc((outcome.detail ?? 'unknown error').replace(/\.+$/, ''));
    const stripe = outcome.objects.stripe_credit;
    const next = stripe ? `The Stripe credit ${stripe} exists; a person needs to finish the rest.` : 'Check Stripe before retrying: the credit may already exist.';
    return `Approved by ${who}, but execution stopped: ${detail}. ${next}`;
  }
  const credit = outcome.creditMinor === null ? 'the credit' : `the ${formatUsd(outcome.creditMinor)} credit`;
  const resumed = outcome.resumed.length > 0 ? ' Resumed after an interruption; nothing was done twice.' : '';
  return `Approved by ${who}. Added ${credit} in Stripe, logged a HubSpot note and posted the reply.${resumed}`;
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
  if (o.resumed.length > 0) lines.push(`Resumed after an interruption at: ${o.resumed.join(', ')}`);
  return lines.join('\n');
}
