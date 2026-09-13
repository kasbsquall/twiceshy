import { emptyState, type MemoryState } from '../../src/adapters/fake/memory.js';
import type { ResolvedProposal } from '../../src/types.js';

export const CSM = 'U_CSM';
export const THREAD = { channelId: 'C_SHARED', threadTs: '1757700000.000100' };

export function world(): MemoryState {
  const state = emptyState();
  state.companies.push({ id: 'co_inc', name: 'Acme Inc', slaTier: 'premium', renewalDate: '2026-10-24', annualValueMinor: 4_800_000, stripeCustomerId: 'cus_inc' });
  state.incidents.push({
    id: 'inc_1', identifier: 'AVA-1', title: 'API outage', severity: 'sev1',
    startedAt: '2026-09-08T14:00:00Z', resolvedAt: '2026-09-08T17:00:00Z', affectedCompanyIds: ['co_inc'],
  });
  state.threads[THREAD.threadTs] = [
    { ts: '1757700000.000100', threadTs: THREAD.threadTs, userId: 'bot:B1', text: 'Tuesday outage killed our checkout' },
    { ts: '1757700100.000200', threadTs: THREAD.threadTs, userId: CSM, text: "We'll send you a thousand bucks in credit." },
  ];
  return state;
}

export const proposal: ResolvedProposal = {
  kind: 'resolved', companyId: 'co_inc', stripeCustomerId: 'cus_inc', incidentId: 'inc_1',
  promise: { amountMinor: 100_000, currency: 'usd', authorUserId: CSM, messageTs: '1757700100.000200', quote: 'a thousand bucks' },
  reasoning: 'fixture', evidence: [],
};
