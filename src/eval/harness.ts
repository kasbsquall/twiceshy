import { WebClient } from '@slack/web-api';
import type { LiveApps } from '../adapters/live/index.js';
import type { ThreadLocation } from '../agent/tools.js';
import type { Dataset } from './seed.js';
import type { Scenario } from './scenarios.js';

/** Stripe customer per company key, created fresh for one run so earlier runs never leak in. */
export type Universe = Record<string, string>;

export async function freshUniverse(apps: LiveApps, dataset: Dataset, scenario: Scenario, label: string): Promise<Universe> {
  const universe: Universe = {};
  for (const key of scenario.companies) {
    const company = dataset.companies[key]!;
    const customerId = await apps.billing.createTestCustomer(company.name, { twiceshy_eval: label });
    await apps.crm.setStripeCustomer(company.id, customerId);
    universe[key] = customerId;
  }
  return universe;
}

/** Customer lines are posted by the app with the customer's display name; CSM lines by the real CSM user. */
export async function postThread(apps: LiveApps, userToken: string, channelId: string, scenario: Scenario): Promise<ThreadLocation> {
  const asCsm = new WebClient(userToken, { retryConfig: { retries: 3 } });
  let threadTs: string | undefined;
  for (const line of scenario.thread) {
    let ts: string;
    if (line.speaker === 'customer') {
      ts = (await apps.chat.postMessage(channelId, line.text, { username: scenario.customerName, ...(threadTs ? { threadTs } : {}) })).ts;
    } else {
      const result = await asCsm.chat.postMessage({ channel: channelId, text: line.text, ...(threadTs ? { thread_ts: threadTs } : {}) });
      if (!result.ts) throw new Error('Slack did not return ts for the CSM message');
      ts = result.ts;
    }
    threadTs ??= ts;
  }
  return { channelId, threadTs: threadTs! };
}

export interface FinalState {
  stripeCredits: number;
  /** Credited by this run only. */
  runCreditedMinor: number;
  hubspotNotes: number;
  slackReplies: number;
  objectIds: { stripe: string[]; hubspot: string[]; slack: string[] };
}

/**
 * Reads the outcome back from the real apps, independent of what the runner reports.
 * Counts only objects created for this run id, plus any credit a teammate made by hand.
 */
export async function readFinalState(apps: LiveApps, customerId: string, companyId: string, thread: ThreadLocation, runId: string, countThread: boolean): Promise<FinalState> {
  const credits = await apps.billing.listCredits(customerId);
  const runCredits = credits.filter((c) => c.metadata['run_id'] === runId);

  const links = await apps.crm.request<{ results: Array<{ toObjectId: number | string }> } | null>(
    'GET',
    `/crm/v4/objects/companies/${companyId}/associations/notes?limit=500`,
  );
  const noteIds = (links?.results ?? []).map((r) => String(r.toObjectId));
  const notes = noteIds.length
    ? (
        await apps.crm.request<{ results: Array<{ id: string; properties: { hs_note_body?: string | null } }> }>(
          'POST',
          '/crm/v3/objects/notes/batch/read',
          { properties: ['hs_note_body'], inputs: noteIds.map((id) => ({ id })) },
        )
      ).results.filter((n) => (n.properties.hs_note_body ?? '').includes(runId))
    : [];

  const replies = countThread ? await apps.chat.listRunMessages(thread.channelId, thread.threadTs, runId) : [];
  return {
    stripeCredits: runCredits.length,
    runCreditedMinor: runCredits.reduce((sum, c) => sum + c.amountMinor, 0),
    hubspotNotes: notes.length,
    slackReplies: replies.length,
    objectIds: { stripe: runCredits.map((c) => c.id), hubspot: notes.map((n) => n.id), slack: replies },
  };
}
