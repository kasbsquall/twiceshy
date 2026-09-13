import { ROLE_CAPS, formatUsd } from '../policy.js';
import type { CaseSnapshot, Cents, CheckResult, ResolvedProposal, Role } from '../types.js';

const ROLE_LABEL: Record<Role, string> = { csm: 'CSM', cs_manager: 'CS manager' };

function timeOf(iso: string): string {
  return new Date(iso).toISOString().slice(11, 16);
}

/** A credit for this incident exists already, by metadata or as a manual credit made after the incident started. */
export function checkDuplicateCredit(snapshot: CaseSnapshot): CheckResult {
  const { incident, credits, company } = snapshot;
  const started = Date.parse(incident.startedAt);
  const duplicates = credits.filter((credit) => {
    const linkedIncident = credit.metadata['incident_id'];
    if (linkedIncident) return linkedIncident === incident.id;
    // No upper bound: a teammate may credit weeks later, and a false block costs a look, not money.
    return Date.parse(credit.createdAt) >= started;
  });
  const first = duplicates[0];
  if (!first) {
    return { check: 'duplicate_credit', ok: true, detail: 'No credit issued yet for this incident', evidence: [] };
  }
  return {
    check: 'duplicate_credit',
    ok: false,
    reason: 'DUPLICATE_CREDIT',
    detail: `${company.name} already received a ${formatUsd(first.amountMinor)} credit in Stripe at ${timeOf(first.createdAt)} UTC. Approving would pay them twice.`,
    evidence: duplicates.map((d) => ({ app: 'stripe' as const, id: d.id })),
  };
}

/** The credit comes from policy; an internal promise must match it and fit the author's role cap. */
export function checkAmountVsPolicy(
  proposal: ResolvedProposal,
  policyMinor: Cents,
  internalUsers: ReadonlyMap<string, Role>,
): CheckResult {
  const promise = proposal.promise;
  const role = promise ? internalUsers.get(promise.authorUserId) : undefined;
  if (!promise || !role) {
    return { check: 'amount_vs_policy', ok: true, detail: `Policy credit ${formatUsd(policyMinor)}`, evidence: [] };
  }
  const evidence = [{ app: 'slack' as const, id: promise.messageTs, quote: promise.quote }];
  const cap = ROLE_CAPS[role];
  if (promise.amountMinor > cap) {
    return {
      check: 'amount_vs_policy',
      ok: false,
      reason: 'AMOUNT_ABOVE_ROLE_CAP',
      detail: `The ${ROLE_LABEL[role]} promised ${formatUsd(promise.amountMinor)}. ${ROLE_LABEL[role]}s can offer up to ${formatUsd(cap)}.`,
      evidence,
    };
  }
  if (promise.amountMinor !== policyMinor) {
    return {
      check: 'amount_vs_policy',
      ok: false,
      reason: 'AMOUNT_VS_POLICY',
      detail: `Promised ${formatUsd(promise.amountMinor)} but the SLA policy gives ${formatUsd(policyMinor)}.`,
      evidence,
    };
  }
  return { check: 'amount_vs_policy', ok: true, detail: `Promise matches policy: ${formatUsd(policyMinor)}`, evidence };
}

/** Only promises written by internal team members count. */
export function checkPromiseAuthority(
  proposal: ResolvedProposal,
  internalUsers: ReadonlyMap<string, Role>,
): CheckResult {
  const promise = proposal.promise;
  if (!promise) return { check: 'promise_authority', ok: true, detail: 'No promise claimed', evidence: [] };
  if (internalUsers.has(promise.authorUserId)) {
    return {
      check: 'promise_authority',
      ok: true,
      detail: 'Promise written by an internal team member',
      evidence: [{ app: 'slack', id: promise.messageTs }],
    };
  }
  return {
    check: 'promise_authority',
    ok: false,
    reason: 'PROMISE_NOT_AUTHORIZED',
    detail: 'This promise was not made by someone allowed to offer credits (a CSM or CS manager).',
    evidence: [{ app: 'slack', id: promise.messageTs, quote: promise.quote }],
  };
}

/** HubSpot company, Stripe customer and Linear incident must point at the same account by ID. */
export function checkAccountIdentity(proposal: ResolvedProposal, snapshot: CaseSnapshot): CheckResult {
  const { company, incident } = snapshot;
  const problems: string[] = [];
  if (company.stripeCustomerId !== proposal.stripeCustomerId) {
    problems.push(`HubSpot links ${company.name} to a different Stripe customer`);
  }
  if (!incident.affectedCompanyIds.includes(company.id)) {
    problems.push(`${incident.identifier} does not list ${company.name} as affected`);
  }
  if (problems.length === 0) {
    return {
      check: 'account_identity',
      ok: true,
      detail: `${company.name} matches across HubSpot, Stripe and ${incident.identifier}`,
      evidence: [
        { app: 'hubspot', id: company.id },
        { app: 'stripe', id: company.stripeCustomerId },
        { app: 'linear', id: incident.id },
      ],
    };
  }
  return {
    check: 'account_identity',
    ok: false,
    reason: 'ACCOUNT_IDENTITY_MISMATCH',
    detail: `${problems.join('; ')}.`,
    evidence: [
      { app: 'hubspot', id: company.id },
      { app: 'linear', id: incident.id },
    ],
  };
}

/** Anything that changed between posting the card and pressing Approve blocks the run. */
export function checkStaleState(before: CaseSnapshot, after: CaseSnapshot): CheckResult {
  const changes: string[] = [];
  const beforeIds = new Set(before.credits.map((c) => c.id));
  const newCredits = after.credits.filter((c) => !beforeIds.has(c.id));
  for (const credit of newCredits) {
    changes.push(`a ${formatUsd(credit.amountMinor)} credit was added in Stripe at ${timeOf(credit.createdAt)} UTC`);
  }
  if (before.company.slaTier !== after.company.slaTier) changes.push('the contract tier changed in HubSpot');
  if (before.company.stripeCustomerId !== after.company.stripeCustomerId) changes.push('the Stripe customer changed in HubSpot');
  if (before.incident.severity !== after.incident.severity) changes.push('the incident severity changed in Linear');
  if (before.incident.affectedCompanyIds.join() !== after.incident.affectedCompanyIds.join()) {
    changes.push('the affected accounts changed in Linear');
  }
  if (changes.length === 0) {
    return { check: 'stale_state', ok: true, detail: 'Nothing changed since the card was posted', evidence: [] };
  }
  return {
    check: 'stale_state',
    ok: false,
    reason: 'STALE_STATE',
    detail: `Since the card was posted, ${changes.join(', ')}.`,
    evidence: newCredits.map((c) => ({ app: 'stripe' as const, id: c.id })),
  };
}
