import type { Apps } from '../ports.js';
import type { CaseSnapshot, Proposal, ReasonCode, ResolvedProposal } from '../types.js';
import type { ThreadLocation } from './tools.js';

export type Verification =
  | { ok: true; proposal: ResolvedProposal; snapshot: CaseSnapshot }
  | { ok: false; reason: Extract<ReasonCode, 'AMBIGUOUS' | 'PROPOSAL_UNVERIFIED' | 'VERIFICATION_UNAVAILABLE'>; detail: string };

const normalize = (text: string) => text.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

/**
 * Reads everything the guard needs, straight from the apps. Used before the card and again on
 * Approve. Any read failure throws, and callers turn it into VERIFICATION_UNAVAILABLE.
 */
export async function readSnapshot(apps: Apps, thread: ThreadLocation, proposal: ResolvedProposal): Promise<CaseSnapshot | string> {
  const [company, incident, messages, customerExists] = await Promise.all([
    apps.crm.getCompany(proposal.companyId),
    apps.tracker.getIncident(proposal.incidentId),
    apps.chat.getThread(thread.channelId, thread.threadTs),
    apps.billing.customerExists(proposal.stripeCustomerId),
  ]);
  if (!company) return `HubSpot has no company ${proposal.companyId}`;
  if (!incident) return `Linear has no incident ${proposal.incidentId}`;
  if (!customerExists) return `Stripe has no customer ${proposal.stripeCustomerId}`;
  const credits = await apps.billing.listCredits(proposal.stripeCustomerId);
  return { company, incident, thread: messages, credits, readAt: new Date().toISOString() };
}

function checkPromiseEvidence(proposal: ResolvedProposal, snapshot: CaseSnapshot): string | null {
  const promise = proposal.promise;
  if (!promise) return null;
  const message = snapshot.thread.find((m) => m.ts === promise.messageTs);
  if (!message) return `The quoted message ${promise.messageTs} is not in the thread`;
  if (message.userId !== promise.authorUserId) {
    return `The quoted message was written by ${message.userId}, not ${promise.authorUserId}`;
  }
  if (!normalize(message.text).includes(normalize(promise.quote))) {
    return `The quote "${promise.quote}" does not appear in message ${promise.messageTs}`;
  }
  if (!Number.isInteger(promise.amountMinor) || promise.amountMinor <= 0) return 'The promised amount is not a positive amount';
  return null;
}

/**
 * Deterministic check of Claude's proposal: every id must exist in its app, and the promise must
 * be a verbatim quote from the stated author at the stated message. Nothing Claude says is trusted
 * without a matching record.
 */
export async function verifyProposal(apps: Apps, thread: ThreadLocation, proposal: Proposal | null): Promise<Verification> {
  if (!proposal) return { ok: false, reason: 'PROPOSAL_UNVERIFIED', detail: 'The agent did not return a proposal' };
  if (proposal.kind === 'ambiguous') return { ok: false, reason: 'AMBIGUOUS', detail: proposal.question };

  let snapshot: CaseSnapshot | string;
  try {
    snapshot = await readSnapshot(apps, thread, proposal);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: 'VERIFICATION_UNAVAILABLE', detail: `Could not read the apps to verify: ${message}` };
  }
  if (typeof snapshot === 'string') return { ok: false, reason: 'PROPOSAL_UNVERIFIED', detail: snapshot };

  const promiseProblem = checkPromiseEvidence(proposal, snapshot);
  if (promiseProblem) return { ok: false, reason: 'PROPOSAL_UNVERIFIED', detail: promiseProblem };
  return { ok: true, proposal, snapshot };
}
