import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryApps, emptyState, type MemoryState } from './adapters/fake/memory.js';
import { buildCard, receiptText } from './approval/card.js';
import { COMPANIES, INCIDENTS, SCENARIOS } from './eval/scenarios.js';
import { CaseStore } from './runtime/caseStore.js';
import { Ledger } from './runtime/ledger.js';
import { SimulatedCrash } from './runtime/runner.js';
import type { Proposal } from './types.js';
import { approveCase, prepareCase, resumeUnfinished, type WorkflowDeps } from './workflow.js';

const CSM = 'U_CSM_OFFLINE';
const APPROVER = 'U_MANAGER_OFFLINE';
const THREAD = { channelId: 'C_SHARED', threadTs: '1789300000.000100' };

/** Proposals recorded from live runs of the resolver, so offline mode needs no API key. */
const RECORDED: Record<string, { company: string; incident: string; amountMinor: number; quote: string; line: number }> = {
  's1-lookalike': { company: 'acme_inc', incident: 'checkout_outage', amountMinor: 100_000, quote: 'a thousand bucks', line: 1 },
  's4-already-credited': { company: 'umbrella', incident: 'checkout_outage', amountMinor: 100_000, quote: '$1,000', line: 1 },
  's6-credit-before-approve': { company: 'stark', incident: 'webhook_delay', amountMinor: 100_000, quote: '$1,000', line: 1 },
  's7-crash': { company: 'wayne', incident: 'checkout_outage', amountMinor: 100_000, quote: 'A grand', line: 1 },
};

function world(scenarioId: string): { state: MemoryState; proposal: Proposal } {
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const recorded = RECORDED[scenarioId]!;
  const state = emptyState();
  for (const c of COMPANIES) state.companies.push({ id: `co_${c.key}`, name: c.name, slaTier: c.slaTier, renewalDate: c.renewalDate, annualValueMinor: c.annualValueMinor, stripeCustomerId: `cus_${c.key}` });
  for (const i of INCIDENTS) {
    state.incidents.push({ id: `inc_${i.key}`, identifier: `AVA-${6 + INCIDENTS.indexOf(i)}`, title: i.title, severity: i.severity, startedAt: i.startedAt, resolvedAt: i.resolvedAt, affectedCompanyIds: i.affected.map((k) => `co_${k}`) });
  }
  state.threads[THREAD.threadTs] = scenario.thread.map((line, n) => ({
    ts: `17893000${n}0.000100`,
    threadTs: THREAD.threadTs,
    userId: line.speaker === 'csm' ? CSM : 'bot:B_OFFLINE',
    ...(line.speaker === 'customer' ? { authorName: scenario.customerName } : {}),
    text: line.text,
  }));
  state.threads[THREAD.threadTs]![0]!.ts = THREAD.threadTs;
  const prior = scenario.setup?.priorCredit;
  if (prior && !prior.incident) state.credits[`cus_${prior.company}`] = [{ id: 'cbtxn_by_hand', kind: 'balance_transaction', amountMinor: prior.amountMinor, createdAt: '2026-09-13T15:42:00Z', metadata: {} }];
  const promiseMessage = state.threads[THREAD.threadTs]![recorded.line]!;
  return {
    state,
    proposal: {
      kind: 'resolved',
      companyId: `co_${recorded.company}`,
      stripeCustomerId: `cus_${recorded.company}`,
      incidentId: `inc_${recorded.incident}`,
      promise: { amountMinor: recorded.amountMinor, currency: 'usd', authorUserId: CSM, messageTs: promiseMessage.ts, quote: recorded.quote },
      reasoning: 'recorded',
      evidence: [],
    },
  };
}

/** Full workflow on in-memory apps with a recorded proposal. Labeled offline; never used for metrics. */
export async function runOffline(scenarioId: string, out: (line?: string) => void): Promise<void> {
  if (!RECORDED[scenarioId]) throw new Error(`Offline mode supports: ${Object.keys(RECORDED).join(', ')}`);
  const scenario = SCENARIOS.find((s) => s.id === scenarioId)!;
  const { state, proposal } = world(scenarioId);
  const dir = mkdtempSync(join(tmpdir(), 'twiceshy-offline-'));
  const deps = (): WorkflowDeps => ({
    apps: createMemoryApps(state),
    ledger: new Ledger(join(dir, 'ledger')),
    cases: new CaseStore(join(dir, 'cases')),
    internalUsers: new Map([[CSM, 'csm']]),
    approverUserIds: new Set([APPROVER]),
    approvalChannelId: 'C_APPROVALS',
    postCards: true,
    now: () => new Date('2026-09-13T15:00:00Z'),
  });

  out(`OFFLINE MODE: in-memory apps and a recorded Claude proposal. Not used for any reported metric.`);
  out(`Scenario ${scenario.id}: ${scenario.title}`);
  out();
  const record = await prepareCase(deps(), THREAD, async () => ({ proposal, usage: { inputTokens: 0, outputTokens: 0, toolCalls: [{ name: 'search_hubspot_companies', input: { query: scenario.customerName.split('(')[1]?.replace(')', '') ?? '' } }] } }));
  out(`CARD  ${buildCard(record, new Date('2026-09-13T15:00:00Z')).text}`);
  if (record.verdict.status !== 'PASS') {
    out(`      ${record.verdict.checks.filter((c) => !c.ok).map((c) => c.detail).join(' ')}`);
    return;
  }

  const m = scenario.beforeApprove?.manualCredit;
  if (m) {
    state.credits[`cus_${m.company}`] = [...(state.credits[`cus_${m.company}`] ?? []), { id: 'cbtxn_teammate', kind: 'balance_transaction', amountMinor: m.amountMinor, createdAt: new Date().toISOString(), metadata: {} }];
    out(`TEAMMATE  credits ${m.amountMinor / 100} USD by hand in Stripe before Approve`);
  }
  out('APPROVE  pressed');
  try {
    const result = await approveCase(deps(), record.runId, APPROVER, scenario.crash ? { crashAt: 'after:hubspot_note', onEvent: (e) => out(`  ${e}`) } : { onEvent: (e) => out(`  ${e}`) });
    if ('record' in result) out(receiptText(result.record) || `Result: ${result.status}`);
  } catch (error) {
    if (!(error instanceof SimulatedCrash)) throw error;
    out('PROCESS  restarted');
    const [resumed] = await resumeUnfinished(deps(), { onEvent: (e) => out(`  ${e}`) });
    if (resumed && 'record' in resumed) out(receiptText(resumed.record));
  }
  const credits = (state.credits[proposal.kind === 'resolved' ? proposal.stripeCustomerId : ''] ?? []).filter((c) => c.metadata['run_id']);
  const replies = state.posted.filter((p) => p.step === 'slack_reply');
  out();
  out(`FINAL STATE  Stripe credits by TwiceShy: ${credits.length}. HubSpot notes: ${Object.values(state.notes).flat().length}. Replies to the customer: ${replies.length}.`);
}
