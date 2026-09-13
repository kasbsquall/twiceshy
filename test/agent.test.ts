import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { createMemoryApps, emptyState, type MemoryState } from '../src/adapters/fake/memory.js';
import { resolveThread, type ModelClient } from '../src/agent/resolve.js';
import { verifyProposal } from '../src/agent/verifyProposal.js';
import type { ResolvedProposal } from '../src/types.js';

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

const thread = { channelId: 'C_SHARED', threadTs: '1757700000.000100' };

function world(): MemoryState {
  const state = emptyState();
  state.companies.push(
    { id: 'co_corp', name: 'Acme Corp', slaTier: 'standard', renewalDate: '2027-03-01', annualValueMinor: 1_200_000, stripeCustomerId: 'cus_corp' },
    { id: 'co_inc', name: 'Acme Inc', slaTier: 'premium', renewalDate: '2026-10-24', annualValueMinor: 4_800_000, stripeCustomerId: 'cus_inc' },
  );
  state.incidents.push({
    id: 'inc_1', identifier: 'INC-1', title: 'API outage', severity: 'sev1',
    startedAt: '2026-09-08T14:00:00Z', resolvedAt: '2026-09-08T17:00:00Z', affectedCompanyIds: ['co_inc'],
  });
  state.threads[thread.threadTs] = [
    { ts: '1757700000.000100', threadTs: thread.threadTs, userId: 'U_CUSTOMER', text: 'Acme here, Tuesday outage killed our checkout' },
    { ts: '1757700100.000200', threadTs: thread.threadTs, userId: 'U_CSM', text: "So sorry. We'll send you a thousand bucks in credit." },
  ];
  return state;
}

function toolUse(id: string, name: string, input: unknown): Message {
  return {
    id: `msg_${id}`, type: 'message', role: 'assistant', model: 'test', stop_reason: 'tool_use', stop_sequence: null,
    content: [{ type: 'tool_use', id, name, input }],
    usage: { input_tokens: 10, output_tokens: 5 },
  } as unknown as Message;
}

function scripted(responses: Message[]): ModelClient & { calls: Params[] } {
  const calls: Params[] = [];
  return {
    calls,
    async create(params) {
      calls.push(structuredClone(params));
      const next = responses.shift();
      if (!next) throw new Error('script exhausted');
      return next;
    },
  };
}

const submission = {
  kind: 'resolved', company_id: 'co_inc', stripe_customer_id: 'cus_inc', incident_id: 'inc_1',
  promise: { amount_usd: 1000, author_user_id: 'U_CSM', message_ts: '1757700100.000200', quote: 'a thousand bucks' },
  reasoning: 'Acme Inc is the only Acme listed on INC-1.',
  evidence: [{ app: 'linear', id: 'inc_1', quote: null }], candidates: [], question: null,
};

describe('resolve agent', () => {
  it('reads through tools and returns a typed proposal in cents', async () => {
    const client = scripted([
      toolUse('t1', 'get_slack_thread', {}),
      toolUse('t2', 'submit_proposal', submission),
    ]);
    const result = await resolveThread(client, 'claude-sonnet-5', createMemoryApps(world()), thread);

    expect(result.proposal).toMatchObject({ kind: 'resolved', companyId: 'co_inc', promise: { amountMinor: 100_000 } });
    const secondTurn = client.calls[1]?.messages.at(-1);
    expect(secondTurn?.role).toBe('user');
    expect(JSON.stringify(secondTurn?.content)).toContain('a thousand bucks');
  });

  it('asks the model again when a submission is malformed', async () => {
    const client = scripted([
      toolUse('t1', 'submit_proposal', { ...submission, company_id: null }),
      toolUse('t2', 'submit_proposal', submission),
    ]);
    const result = await resolveThread(client, 'claude-sonnet-5', createMemoryApps(world()), thread);
    expect(result.proposal?.kind).toBe('resolved');
    expect(result.usage.toolCalls[0]?.error).toMatch(/company_id/);
  });
});

describe('proposal verifier', () => {
  const base: ResolvedProposal = {
    kind: 'resolved', companyId: 'co_inc', stripeCustomerId: 'cus_inc', incidentId: 'inc_1',
    promise: { amountMinor: 100_000, currency: 'usd', authorUserId: 'U_CSM', messageTs: '1757700100.000200', quote: 'a thousand bucks' },
    reasoning: 'x', evidence: [],
  };

  it('accepts a proposal whose ids and quote exist', async () => {
    expect((await verifyProposal(createMemoryApps(world()), thread, base)).ok).toBe(true);
  });

  it('rejects a quote that is not in the message', async () => {
    const forged = { ...base, promise: { ...base.promise!, quote: 'two thousand dollars' } };
    const result = await verifyProposal(createMemoryApps(world()), thread, forged);
    expect(result).toMatchObject({ ok: false, reason: 'PROPOSAL_UNVERIFIED' });
  });

  it('rejects a promise attributed to the wrong author', async () => {
    const wrong = { ...base, promise: { ...base.promise!, authorUserId: 'U_CUSTOMER' } };
    expect(await verifyProposal(createMemoryApps(world()), thread, wrong)).toMatchObject({ ok: false, reason: 'PROPOSAL_UNVERIFIED' });
  });

  it('rejects an id that does not exist', async () => {
    const invented = { ...base, incidentId: 'inc_404' };
    expect(await verifyProposal(createMemoryApps(world()), thread, invented)).toMatchObject({ ok: false, reason: 'PROPOSAL_UNVERIFIED' });
  });

  it('fails closed when an app cannot be read', async () => {
    const apps = createMemoryApps(world(), { failReads: new Set(['billing.listCredits']) });
    expect(await verifyProposal(apps, thread, base)).toMatchObject({ ok: false, reason: 'VERIFICATION_UNAVAILABLE' });
  });
});
