import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryApps, emptyState, type MemoryState } from '../src/adapters/fake/memory.js';
import { buildCard } from '../src/approval/card.js';
import { CaseStore } from '../src/runtime/caseStore.js';
import { Ledger } from '../src/runtime/ledger.js';
import { SimulatedCrash } from '../src/runtime/runner.js';
import type { ResolvedProposal } from '../src/types.js';
import { approveCase, prepareCase, resumeUnfinished, type WorkflowDeps } from '../src/workflow.js';

const thread = { channelId: 'C_SHARED', threadTs: '1757700000.000100' };
const CSM = 'U_CSM';

function world(): MemoryState {
  const state = emptyState();
  state.companies.push(
    { id: 'co_corp', name: 'Acme Corp', slaTier: 'standard', renewalDate: '2027-03-01', annualValueMinor: 1_200_000, stripeCustomerId: 'cus_corp' },
    { id: 'co_inc', name: 'Acme Inc', slaTier: 'premium', renewalDate: '2026-10-24', annualValueMinor: 4_800_000, stripeCustomerId: 'cus_inc' },
  );
  state.incidents.push({
    id: 'inc_1', identifier: 'AVA-1', title: 'API outage', severity: 'sev1',
    startedAt: '2026-09-08T14:00:00Z', resolvedAt: '2026-09-08T17:00:00Z', affectedCompanyIds: ['co_inc'],
  });
  state.threads[thread.threadTs] = [
    { ts: '1757700000.000100', threadTs: thread.threadTs, userId: 'bot:B1', authorName: 'Dana (Acme)', text: 'Acme here, Tuesday outage killed our checkout' },
    { ts: '1757700100.000200', threadTs: thread.threadTs, userId: CSM, text: "So sorry. We'll send you a thousand bucks in credit." },
  ];
  return state;
}

const proposal: ResolvedProposal = {
  kind: 'resolved', companyId: 'co_inc', stripeCustomerId: 'cus_inc', incidentId: 'inc_1',
  promise: { amountMinor: 100_000, currency: 'usd', authorUserId: CSM, messageTs: '1757700100.000200', quote: 'a thousand bucks' },
  reasoning: 'x', evidence: [],
};

function setup(state = world(), dir = mkdtempSync(join(tmpdir(), 'twiceshy-wf-'))) {
  const deps: WorkflowDeps = {
    apps: createMemoryApps(state),
    ledger: new Ledger(join(dir, 'ledger')),
    cases: new CaseStore(join(dir, 'cases')),
    internalUsers: new Map([[CSM, 'csm']]),
    approverUserIds: new Set(['U_MANAGER']),
    approvalChannelId: 'C_APPROVALS',
    postCards: true,
    now: () => new Date('2026-09-13T15:00:00Z'),
  };
  const resolver = async () => ({ proposal, usage: { inputTokens: 0, outputTokens: 0, toolCalls: [{ name: 'search_hubspot_companies', input: { query: 'acme' } }] } });
  return { state, deps, resolver, dir };
}

const ours = (state: MemoryState) => (state.credits['cus_inc'] ?? []).filter((c) => c.metadata['run_id']);
const replies = (state: MemoryState) => state.posted.filter((p) => p.channelId === thread.channelId && p.step === 'slack_reply');

describe('workflow', () => {
  it('pays, notes and replies exactly once after approval', async () => {
    const { state, deps, resolver } = setup();
    const record = await prepareCase(deps, thread, resolver);
    expect(record.verdict.status).toBe('PASS');
    expect(buildCard(record, new Date('2026-09-13T15:00:00Z')).text).toBe(
      'Approve a $1,000 credit to Acme Inc for the Sep 8 outage (AVA-1). Acme Inc renews in 41 days ($48,000 a year).',
    );

    const result = await approveCase(deps, record.runId, 'U_MANAGER');
    expect(result.status).toBe('done');
    expect(ours(state)).toHaveLength(1);
    expect(state.notes['co_inc']).toHaveLength(1);
    expect(replies(state)).toHaveLength(1);
    expect(await approveCase(deps, record.runId, 'U_MANAGER')).toEqual({ status: 'already_done' });
  });

  it('refuses approval from someone outside the allowlist', async () => {
    const { deps, resolver } = setup();
    const record = await prepareCase(deps, thread, resolver);
    expect(await approveCase(deps, record.runId, CSM)).toEqual({ status: 'forbidden' });
  });

  it('blocks on approve when a teammate credited by hand after the card was posted', async () => {
    const { state, deps, resolver } = setup();
    const record = await prepareCase(deps, thread, resolver);
    state.credits['cus_inc'] = [{ id: 'cbtxn_manual', kind: 'balance_transaction', amountMinor: 100_000, createdAt: '2026-09-13T15:42:00Z', metadata: {} }];

    const result = await approveCase(deps, record.runId, 'U_MANAGER');
    expect(result.status).toBe('blocked');
    expect(ours(state)).toHaveLength(0);
    expect(replies(state)).toHaveLength(0);
    if (result.status === 'blocked') {
      const card = buildCard(result.record);
      expect(card.text.startsWith('Blocked:')).toBe(true);
      expect(card.blocks.map((b) => JSON.stringify(b)).join()).toContain('pay them twice');
      expect(card.blocks.map((b) => JSON.stringify(b)).join()).not.toContain('Reply the customer will get');
    }
  });

  it('resumes after a crash mid-run without paying or replying twice', async () => {
    const { state, deps, resolver, dir } = setup();
    const record = await prepareCase(deps, thread, resolver);
    await expect(approveCase(deps, record.runId, 'U_MANAGER', { crashAt: 'after:hubspot_note' })).rejects.toBeInstanceOf(SimulatedCrash);

    const restarted = setup(state, dir).deps;
    const [result] = await resumeUnfinished(restarted);
    expect(result?.status).toBe('done');
    expect(ours(state)).toHaveLength(1);
    expect(state.notes['co_inc']).toHaveLength(1);
    expect(replies(state)).toHaveLength(1);
    if (result && 'record' in result) expect(result.record.outcome?.resumed).toContain('slack_reply');
  });
});
