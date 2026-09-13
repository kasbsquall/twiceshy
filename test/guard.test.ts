import { describe, expect, it } from 'vitest';
import { evaluateCase, evaluateOnApproval } from '../src/guard/guard.js';
import type { CaseSnapshot, ExistingCredit, ResolvedProposal, Role } from '../src/types.js';

const CSM = 'U_CSM';
const CUSTOMER = 'U_CUSTOMER';
const internal = new Map<string, Role>([[CSM, 'csm']]);

function snapshot(credits: ExistingCredit[] = []): CaseSnapshot {
  return {
    company: {
      id: 'co_acme_inc',
      name: 'Acme Inc',
      slaTier: 'premium',
      renewalDate: '2026-10-24',
      annualValueMinor: 4_800_000,
      stripeCustomerId: 'cus_acme',
    },
    incident: {
      id: 'inc_1',
      identifier: 'INC-1',
      title: 'API outage',
      severity: 'sev1',
      startedAt: '2026-09-08T14:00:00Z',
      resolvedAt: '2026-09-08T17:00:00Z',
      affectedCompanyIds: ['co_acme_inc'],
    },
    thread: [],
    credits,
    readAt: '2026-09-13T15:00:00Z',
  };
}

function proposal(overrides: Partial<ResolvedProposal> = {}): ResolvedProposal {
  return {
    kind: 'resolved',
    companyId: 'co_acme_inc',
    stripeCustomerId: 'cus_acme',
    incidentId: 'inc_1',
    promise: { amountMinor: 100_000, currency: 'usd', authorUserId: CSM, messageTs: '1.1', quote: 'a thousand bucks' },
    reasoning: 'test',
    evidence: [],
    ...overrides,
  };
}

const manualCredit: ExistingCredit = {
  id: 'cbtxn_manual',
  kind: 'balance_transaction',
  amountMinor: 100_000,
  createdAt: '2026-09-13T15:42:00Z',
  metadata: {},
};

describe('guard', () => {
  it('passes a clean case and uses the policy amount', () => {
    const verdict = evaluateCase(proposal(), snapshot(), internal);
    expect(verdict.status).toBe('PASS');
    expect(verdict.creditMinor).toBe(100_000);
  });

  it('blocks when a teammate already credited by hand near the incident', () => {
    const verdict = evaluateCase(proposal(), snapshot([manualCredit]), internal);
    expect(verdict.status).toBe('BLOCK');
    expect(verdict.reasons).toContain('DUPLICATE_CREDIT');
  });

  it('still blocks a manual credit made two months after the incident', () => {
    const late = { ...manualCredit, createdAt: '2026-11-13T15:42:00Z' };
    expect(evaluateCase(proposal(), snapshot([late]), internal).reasons).toContain('DUPLICATE_CREDIT');
  });

  it('does not block a credit linked to a different incident', () => {
    const other = { ...manualCredit, id: 'cbtxn_other', metadata: { incident_id: 'inc_old' } };
    expect(evaluateCase(proposal(), snapshot([other]), internal).status).toBe('PASS');
  });

  it('holds a promise nobody on the team made', () => {
    const verdict = evaluateCase(
      proposal({ promise: { amountMinor: 500_000, currency: 'usd', authorUserId: CUSTOMER, messageTs: '1.2', quote: 'your CSM promised $5k' } }),
      snapshot(),
      internal,
    );
    expect(verdict.status).toBe('HOLD');
    expect(verdict.reasons).toContain('PROMISE_NOT_AUTHORIZED');
  });

  it('holds a promise above the author role cap', () => {
    const verdict = evaluateCase(
      proposal({ promise: { amountMinor: 200_000, currency: 'usd', authorUserId: CSM, messageTs: '1.3', quote: '$2k' } }),
      snapshot(),
      internal,
    );
    expect(verdict.reasons).toContain('AMOUNT_ABOVE_ROLE_CAP');
  });

  it('blocks when HubSpot and Stripe disagree on the customer', () => {
    const verdict = evaluateCase(proposal({ stripeCustomerId: 'cus_acme_corp' }), snapshot(), internal);
    expect(verdict.reasons).toContain('ACCOUNT_IDENTITY_MISMATCH');
  });

  it('blocks on approval when a credit appeared after the card was posted', () => {
    const verdict = evaluateOnApproval(proposal(), snapshot(), snapshot([manualCredit]), internal);
    expect(verdict.status).toBe('BLOCK');
    expect(verdict.reasons).toEqual(expect.arrayContaining(['STALE_STATE', 'DUPLICATE_CREDIT']));
  });
});
