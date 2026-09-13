import { randomBytes } from 'node:crypto';
import type { ThreadLocation } from './agent/tools.js';
import { readSnapshot, verifyProposal } from './agent/verifyProposal.js';
import { buildCard, customerReply, receiptText, shortDate } from './approval/card.js';
import { evaluateCase, evaluateOnApproval, statusFor, unavailableVerdict } from './guard/guard.js';
import { formatUsd } from './policy.js';
import type { Apps } from './ports.js';
import type { CaseRecord, CaseStore } from './runtime/caseStore.js';
import type { Ledger } from './runtime/ledger.js';
import { runSteps, SimulatedCrash, type RunOptions, type StepSpec } from './runtime/runner.js';
import type { CaseSnapshot, Proposal, ResolvedProposal, Role, Verdict } from './types.js';

export interface WorkflowDeps {
  apps: Apps;
  ledger: Ledger;
  cases: CaseStore;
  internalUsers: ReadonlyMap<string, Role>;
  approverUserIds: ReadonlySet<string>;
  approvalChannelId: string;
  /** Post and update Slack cards. Off in eval runs that do not need them. */
  postCards: boolean;
  now?: () => Date;
}

export interface ResolverOutput {
  proposal: Proposal | null;
  failure?: string;
  usage?: { inputTokens: number; outputTokens: number; turns?: number; toolCalls?: Array<{ name: string; input: unknown }> };
}

export type Resolver = (apps: Apps, thread: ThreadLocation) => Promise<ResolverOutput>;

export class GuardBlocked extends Error {
  constructor(readonly verdict: Verdict) {
    super(verdict.checks.filter((c) => !c.ok).map((c) => c.detail).join(' ') || verdict.reasons.join(', '));
  }
}

export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
}

export function idempotencyKey(proposal: ResolvedProposal): string {
  return `twiceshy:${proposal.incidentId}:${proposal.stripeCustomerId}:sla_credit`;
}

async function codeRunSearches(apps: Apps, output: ResolverOutput): Promise<CaseRecord['searches']> {
  const queries = (output.usage?.toolCalls ?? [])
    .filter((c) => c.name === 'search_hubspot_companies')
    .map((c) => String((c.input as { query?: unknown }).query ?? ''))
    .filter(Boolean);
  const searches: CaseRecord['searches'] = [];
  for (const query of [...new Set(queries)]) {
    try {
      searches.push({ query, matches: (await apps.crm.searchCompanies(query)).map((c) => c.name) });
    } catch {
      // The card simply omits a search it cannot re-run.
    }
  }
  return searches;
}

async function syncCard(deps: WorkflowDeps, record: CaseRecord): Promise<void> {
  if (!deps.postCards) return;
  const card = buildCard(record, deps.now?.() ?? new Date());
  if (record.cardTs) {
    await deps.apps.chat.updateMessage(deps.approvalChannelId, record.cardTs, card.text, card.blocks);
  } else {
    record.cardTs = (await deps.apps.chat.postMessage(deps.approvalChannelId, card.text, { blocks: card.blocks })).ts;
  }
}

/** Resolve, verify, guard and post the card. Writes nothing to Stripe or HubSpot. */
export async function prepareCase(deps: WorkflowDeps, thread: ThreadLocation, resolver: Resolver, runId = newRunId()): Promise<CaseRecord> {
  const started = Date.now();
  const output = await resolver(deps.apps, thread);
  const verification = await verifyProposal(deps.apps, thread, output.proposal);

  let verdict: Verdict;
  let snapshot: CaseSnapshot | null = null;
  let verificationDetail: string | undefined;
  if (verification.ok) {
    snapshot = verification.snapshot;
    verdict = evaluateCase(verification.proposal, snapshot, deps.internalUsers);
  } else if (verification.reason === 'VERIFICATION_UNAVAILABLE') {
    verdict = unavailableVerdict(verification.detail);
    verificationDetail = verification.detail;
  } else {
    verificationDetail = output.failure ?? verification.detail;
    verdict = { status: statusFor([verification.reason]), reasons: [verification.reason], checks: [], creditMinor: null };
  }

  const record: CaseRecord = {
    runId,
    thread,
    createdAt: new Date().toISOString(),
    proposal: output.proposal,
    ...(verificationDetail ? { verificationDetail } : {}),
    verdict,
    snapshot,
    searches: await codeRunSearches(deps.apps, output),
    usage: {
      inputTokens: output.usage?.inputTokens ?? 0,
      outputTokens: output.usage?.outputTokens ?? 0,
      turns: output.usage?.turns ?? 0,
      latencyMs: Date.now() - started,
    },
  };
  await syncCard(deps, record);
  deps.cases.save(record);
  return record;
}

export type ApproveResult =
  | { status: 'forbidden' | 'not_approvable' | 'already_done' }
  | { status: 'blocked' | 'done' | 'failed'; record: CaseRecord };

/** Approve: re-read every app, re-run all checks plus the stale-state diff, then execute. */
export async function approveCase(deps: WorkflowDeps, runId: string, approverUserId: string, options: RunOptions = {}): Promise<ApproveResult> {
  const record = deps.cases.load(runId);
  if (!deps.approverUserIds.has(approverUserId)) return { status: 'forbidden' };
  if (!record || record.verdict.status !== 'PASS' || record.proposal?.kind !== 'resolved' || !record.snapshot) {
    return { status: 'not_approvable' };
  }
  if (record.outcome || deps.ledger.hasStatus(runId, 'run', 'intent')) return { status: 'already_done' };
  // Claim the run before any await: two clicks on the same card cannot both pass this line.
  deps.ledger.append({ runId, step: 'run', status: 'intent', detail: `approval started by ${approverUserId}` });

  let verdict: Verdict;
  let fresh: CaseSnapshot | null = null;
  try {
    const read = await readSnapshot(deps.apps, record.thread, record.proposal);
    if (typeof read === 'string') verdict = unavailableVerdict(read);
    else {
      fresh = read;
      verdict = evaluateOnApproval(record.proposal, record.snapshot, read, deps.internalUsers);
    }
  } catch (error) {
    verdict = unavailableVerdict(`Could not re-read the apps: ${error instanceof Error ? error.message : String(error)}`);
  }

  record.approval = { userId: approverUserId, at: new Date().toISOString(), snapshot: fresh ?? record.snapshot, verdict };
  if (verdict.status !== 'PASS' || !fresh) {
    record.outcome = { status: 'blocked', objects: {}, resumed: [], creditMinor: verdict.creditMinor, reasons: verdict.reasons, detail: new GuardBlocked(verdict).message };
    deps.ledger.append({ runId, step: 'run', status: 'failed', detail: `blocked on approval: ${verdict.reasons.join(', ')}` });
    deps.cases.save(record);
    await syncCard(deps, record);
    return { status: 'blocked', record };
  }

  deps.cases.save(record);
  return executeCase(deps, record, options);
}

function steps(deps: WorkflowDeps, record: CaseRecord): StepSpec[] {
  const proposal = record.proposal as ResolvedProposal;
  const snapshot = record.approval?.snapshot ?? (record.snapshot as CaseSnapshot);
  const creditMinor = record.approval?.verdict.creditMinor ?? (record.verdict.creditMinor as number);
  const { apps, ledger } = deps;
  const runId = record.runId;

  return [
    {
      name: 'stripe_credit',
      find: async () => (await apps.billing.listCredits(proposal.stripeCustomerId)).find((c) => c.metadata['run_id'] === runId)?.id ?? null,
      execute: () =>
        apps.billing.createCredit(proposal.stripeCustomerId, creditMinor, 'usd', {
          idempotencyKey: idempotencyKey(proposal),
          description: `SLA credit for ${snapshot.incident.identifier}`,
          metadata: { run_id: runId, incident_id: proposal.incidentId, hubspot_company_id: proposal.companyId, source: 'twiceshy' },
        }),
    },
    {
      name: 'hubspot_note',
      find: () => apps.crm.findNote(proposal.companyId, runId),
      execute: () => {
        const creditId = ledger.entries(runId).find((e) => e.step === 'stripe_credit' && e.status === 'done')?.objectId ?? 'unknown';
        const body = [
          `<p><strong>TwiceShy SLA credit:</strong> ${formatUsd(creditMinor)} for ${snapshot.incident.identifier} (${snapshot.incident.title}, ${shortDate(snapshot.incident.startedAt)}).</p>`,
          `<p>Stripe balance transaction ${creditId}. Approved in Slack by ${record.approval?.userId ?? 'unknown'}. Customer reply posted in the shared thread.</p>`,
          `<p>run_id: ${runId}</p>`,
        ].join('');
        return apps.crm.addNote(proposal.companyId, body);
      },
    },
    {
      name: 'slack_reply',
      find: () => apps.chat.findPostedMessage(record.thread.channelId, record.thread.threadTs, runId, 'slack_reply'),
      execute: async () => {
        const { ts } = await apps.chat.postMessage(record.thread.channelId, customerReply(snapshot, creditMinor), {
          threadTs: record.thread.threadTs,
          runId,
          step: 'slack_reply',
        });
        return { id: ts };
      },
    },
  ];
}

/** Money is re-checked before a retried credit: a teammate may have paid while we were down. */
function beforeRetry(deps: WorkflowDeps, record: CaseRecord) {
  return async (step: string) => {
    if (step !== 'stripe_credit' || record.proposal?.kind !== 'resolved') return;
    const baseline = record.approval?.snapshot ?? (record.snapshot as CaseSnapshot);
    const fresh = await readSnapshot(deps.apps, record.thread, record.proposal);
    if (typeof fresh === 'string') throw new GuardBlocked(unavailableVerdict(fresh));
    const verdict = evaluateOnApproval(record.proposal, baseline, fresh, deps.internalUsers);
    if (verdict.status !== 'PASS') throw new GuardBlocked(verdict);
  };
}

export async function executeCase(deps: WorkflowDeps, record: CaseRecord, options: RunOptions = {}, interrupted = false): Promise<ApproveResult> {
  const creditMinor = record.approval?.verdict.creditMinor ?? record.verdict.creditMinor;
  const doneBefore = new Set(deps.ledger.entries(record.runId).filter((e) => e.status === 'done').map((e) => e.step));
  try {
    const outcome = await runSteps(deps.ledger, record.runId, steps(deps, record), { ...options, beforeRetry: beforeRetry(deps, record) });
    // After an interruption, every step finished in this pass counts as resumed, found or re-run.
    const resumed = interrupted ? steps(deps, record).map((s) => s.name).filter((name) => !doneBefore.has(name)) : outcome.resumed;
    record.outcome = { status: 'done', objects: outcome.objects, resumed, creditMinor, reasons: [] };
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    const blocked = error instanceof GuardBlocked;
    deps.ledger.append({ runId: record.runId, step: 'run', status: 'failed', detail: error instanceof Error ? error.message : String(error) });
    record.outcome = {
      status: blocked ? 'blocked' : 'failed',
      objects: Object.fromEntries(
        deps.ledger.entries(record.runId).filter((e) => e.status === 'done' && e.objectId && e.step !== 'run').map((e) => [e.step, e.objectId]),
      ),
      resumed: [],
      creditMinor,
      reasons: blocked ? error.verdict.reasons : [],
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  deps.cases.save(record);
  await syncCard(deps, record);
  if (deps.postCards && record.cardTs) {
    await deps.apps.chat.postMessage(deps.approvalChannelId, receiptText(record), { threadTs: record.cardTs });
  }
  return { status: record.outcome.status, record };
}

/** On startup: finish every approved run that was interrupted, reconciling each step by run id. */
export async function resumeUnfinished(deps: WorkflowDeps, options: RunOptions = {}): Promise<ApproveResult[]> {
  const results: ApproveResult[] = [];
  for (const runId of deps.ledger.unfinishedRuns()) {
    const record = deps.cases.load(runId);
    if (!record || record.proposal?.kind !== 'resolved') continue;
    results.push(await executeCase(deps, record, options, true));
  }
  return results;
}
