import { customerReply } from '../approval/card.js';
import { policyCredit } from '../policy.js';
import type { Apps } from '../ports.js';
import type { ThreadLocation } from '../agent/tools.js';
import type { ResolvedProposal, StepName } from '../types.js';

/**
 * Execution baseline: what a competent engineer ships without TwiceShy's guard and ledger.
 * Policy amount, a stable Stripe idempotency key, SDK retries, and on a crash the job is
 * simply restarted from the top. No duplicate check, no re-read, no run ledger.
 */
export async function baselineExecute(
  apps: Apps,
  proposal: ResolvedProposal,
  thread: ThreadLocation,
  runId: string,
  crashAfter?: StepName,
): Promise<{ objects: Partial<Record<StepName, string>>; restarted: boolean }> {
  const attempt = async (crash: boolean) => {
    const [company, incident, messages] = await Promise.all([
      apps.crm.getCompany(proposal.companyId),
      apps.tracker.getIncident(proposal.incidentId),
      apps.chat.getThread(thread.channelId, thread.threadTs),
    ]);
    if (!company || !incident) throw new Error('Baseline could not load the company or incident');
    const amount = policyCredit(company.slaTier, incident.severity);
    const objects: Partial<Record<StepName, string>> = {};

    objects.stripe_credit = (
      await apps.billing.createCredit(proposal.stripeCustomerId, amount, 'usd', {
        idempotencyKey: `baseline:${proposal.incidentId}:${proposal.stripeCustomerId}:sla_credit`,
        description: `SLA credit for ${incident.identifier}`,
        metadata: { run_id: runId, incident_id: incident.id },
      })
    ).id;
    if (crash && crashAfter === 'stripe_credit') throw new Error('crash');

    objects.hubspot_note = (await apps.crm.addNote(company.id, `<p>SLA credit ${objects.stripe_credit} for ${incident.identifier}. run_id: ${runId}</p>`)).id;
    if (crash && crashAfter === 'hubspot_note') throw new Error('crash');

    const snapshot = { company, incident, thread: messages, credits: [], readAt: new Date().toISOString() };
    objects.slack_reply = (
      await apps.chat.postMessage(thread.channelId, customerReply(snapshot, amount), { threadTs: thread.threadTs, runId, step: 'slack_reply' })
    ).ts;
    if (crash && crashAfter === 'slack_reply') throw new Error('crash');
    return objects;
  };

  if (!crashAfter) return { objects: await attempt(false), restarted: false };
  try {
    await attempt(true);
  } catch {
    // The process died; the job queue retries the whole job.
  }
  return { objects: await attempt(false), restarted: true };
}
