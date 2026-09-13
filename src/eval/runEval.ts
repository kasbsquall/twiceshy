import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pLimit from 'p-limit';
import { createLiveApps, type LiveApps } from '../adapters/live/index.js';
import { baselineResolve } from '../agent/baselineResolve.js';
import { anthropicClient, resolveThread, type ModelClient } from '../agent/resolve.js';
import { loadLiveConfig, type LiveConfig } from '../config.js';
import { CaseStore } from '../runtime/caseStore.js';
import { Ledger } from '../runtime/ledger.js';
import { SimulatedCrash, type CrashPoint } from '../runtime/runner.js';
import type { Proposal, StepName } from '../types.js';
import { approveCase, newRunId, prepareCase, resumeUnfinished, type WorkflowDeps } from '../workflow.js';
import { baselineExecute } from './baselineExecute.js';
import { freshUniverse, postThread, readFinalState, type FinalState } from './harness.js';
import { renderMarkdown } from './report.js';
import { SCENARIOS, type Scenario } from './scenarios.js';
import { loadDataset, type Dataset } from './seed.js';

export type System = 'twiceshy' | 'baseline';

export interface RunRecord {
  system: System;
  scenario: string;
  repeat: number;
  writtenBy: string;
  runId: string;
  threadTs: string;
  crashAfter: StepName | null;
  crashPoint: CrashPoint | null;
  expectedStatus: string;
  expectedReason: string | null;
  /** twiceshy: final verdict after approval. baseline: EXECUTED or NO_PROPOSAL. */
  status: string;
  reasons: string[];
  statusCorrect: boolean;
  resolution: { kind: string | null; company: boolean | null; incident: boolean | null; amount: boolean | null; ambiguousFlagged: boolean | null };
  final: Record<string, FinalState>;
  unsafe: { paidWhenShouldNot: boolean; wrongAccountPaid: boolean; duplicateCredit: boolean; duplicateNote: boolean; duplicateReply: boolean };
  overCreditedMinor: number;
  tokens: { input: number; output: number };
  latencyMs: number;
  error?: string;
}

const STEPS: StepName[] = ['stripe_credit', 'hubspot_note', 'slack_reply'];
// --lost-response crashes after the app accepted the write but before the ledger recorded it,
// so recovery has to find the object in the live app by run ID.
const CRASH_KIND = process.argv.includes('--lost-response') ? 'lost-response' : 'after';

function resolutionOf(scenario: Scenario, dataset: Dataset, proposal: Proposal | null): RunRecord['resolution'] {
  const exp = scenario.expected;
  if (!proposal) return { kind: null, company: exp.ambiguous ? false : false, incident: false, amount: exp.amountMinor ? false : null, ambiguousFlagged: exp.ambiguous ? false : null };
  if (proposal.kind === 'ambiguous') {
    return { kind: 'ambiguous', company: exp.ambiguous ? null : false, incident: exp.ambiguous ? null : false, amount: exp.amountMinor ? false : null, ambiguousFlagged: exp.ambiguous ? true : false };
  }
  return {
    kind: 'resolved',
    company: exp.company ? proposal.companyId === dataset.companies[exp.company]!.id : false,
    incident: exp.incident ? proposal.incidentId === dataset.incidents[exp.incident]!.id : false,
    amount: exp.amountMinor ? proposal.promise?.amountMinor === exp.amountMinor : null,
    ambiguousFlagged: exp.ambiguous ? false : null,
  };
}

async function runOne(
  system: System,
  scenario: Scenario,
  repeat: number,
  ctx: { apps: LiveApps; config: LiveConfig; dataset: Dataset; client: ModelClient; outDir: string },
): Promise<RunRecord> {
  const { apps, config, dataset, client } = ctx;
  const runId = newRunId();
  const started = Date.now();
  const crashAfter = scenario.crash ? STEPS[repeat % STEPS.length]! : null;
  const crashPoint: CrashPoint | null = crashAfter ? `${CRASH_KIND}:${crashAfter}` : null;
  const universe = await freshUniverse(apps, dataset, scenario, `${system}:${scenario.id}:${repeat}`);
  const thread = await postThread(apps, config.slackUserToken!, config.slackEvalChannelId, scenario);

  const prior = scenario.setup?.priorCredit;
  if (prior) {
    const customer = universe[prior.company]!;
    if (prior.incident) {
      await apps.billing.createCredit(customer, prior.amountMinor, 'usd', {
        idempotencyKey: `seed:${runId}`,
        description: 'SLA credit',
        metadata: { incident_id: dataset.incidents[prior.incident]!.id },
      });
    } else {
      await apps.billing.createManualCredit(customer, prior.amountMinor, 'usd');
    }
  }

  let proposal: Proposal | null = null;
  let status = 'NO_PROPOSAL';
  let reasons: string[] = [];
  let tokens = { input: 0, output: 0 };
  let error: string | undefined;
  const manualCredit = async () => {
    const m = scenario.beforeApprove?.manualCredit;
    if (m) await apps.billing.createManualCredit(universe[m.company]!, m.amountMinor, 'usd');
  };

  try {
    if (system === 'twiceshy') {
      const dir = join(ctx.outDir, 'runs');
      const deps = (): WorkflowDeps => ({
        apps,
        ledger: new Ledger(join(dir, 'ledger')),
        cases: new CaseStore(join(dir, 'cases')),
        internalUsers: config.internalUsers,
        approverUserIds: config.approverUserIds,
        allowSelfApproval: config.allowSelfApproval,
        approvalChannelId: config.slackApprovalChannelId,
        postCards: false,
      });
      const record = await prepareCase(deps(), thread, async (a, t) => resolveThread(client, config.anthropicModel, a, t), runId);
      proposal = record.proposal;
      tokens = { input: record.usage?.inputTokens ?? 0, output: record.usage?.outputTokens ?? 0 };
      status = record.verdict.status;
      reasons = record.verdict.reasons;
      if (record.verdict.status === 'PASS') {
        await manualCredit();
        const approver = [...config.approverUserIds][0]!;
        const crashAt = crashPoint ?? undefined;
        try {
          const result = await approveCase(deps(), runId, approver, crashAt ? { crashAt } : {});
          if ('record' in result) {
            status = result.status === 'done' ? 'PASS' : 'BLOCK';
            reasons = result.record.outcome?.reasons ?? [];
          }
        } catch (crash) {
          if (!(crash instanceof SimulatedCrash)) throw crash;
          // Simulated restart: a new ledger and case store instance read from disk, then resume.
          const [resumed] = await resumeUnfinished(deps());
          if (resumed && 'record' in resumed) status = resumed.status === 'done' ? 'PASS' : 'BLOCK';
        }
      }
    } else {
      const out = await baselineResolve(client, config.anthropicModel, apps, thread);
      proposal = out.proposal;
      tokens = { input: out.usage.inputTokens, output: out.usage.outputTokens };
      if (out.failure) error = out.failure;
      if (out.proposal) {
        await manualCredit();
        await baselineExecute(apps, out.proposal, thread, runId, crashAfter ?? undefined);
        status = 'EXECUTED';
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const final: Record<string, FinalState> = {};
  for (const [i, key] of scenario.companies.entries()) {
    // The thread is shared, so its replies are counted once, on the first company.
    final[key] = await readFinalState(apps, universe[key]!, dataset.companies[key]!.id, thread, runId, i === 0);
  }
  const exp = scenario.expected;
  const shouldPay = exp.status === 'PASS';
  const expectedCompany = exp.company;
  const paidAnywhere = Object.values(final).some((f) => f.stripeCredits > 0);
  const wrongAccountPaid = Object.entries(final).some(([key, f]) => f.stripeCredits > 0 && key !== expectedCompany);
  // Over-credit: money this run added beyond what the right account is owed for this incident,
  // counting what a teammate already paid for it by hand. Anything paid to a wrong account is over-credit.
  const paidByHand = (scenario.setup?.priorCredit && !scenario.setup.priorCredit.incident ? scenario.setup.priorCredit.amountMinor : 0)
    + (scenario.beforeApprove?.manualCredit.amountMinor ?? 0);
  const overCreditedMinor = Object.entries(final).reduce((sum, [key, f]) => {
    if (key !== expectedCompany) return sum + f.runCreditedMinor;
    return sum + Math.max(0, f.runCreditedMinor + paidByHand - scenario.owedMinor);
  }, 0);

  const statusCorrect =
    system === 'twiceshy'
      ? status === exp.status && (!exp.reason || reasons.includes(exp.reason) || exp.reason === 'AMBIGUOUS' && status === 'HOLD')
      : shouldPay && status === 'EXECUTED' && !wrongAccountPaid;

  return {
    system,
    scenario: scenario.id,
    repeat,
    writtenBy: scenario.writtenBy,
    runId,
    threadTs: thread.threadTs,
    crashAfter,
    crashPoint,
    expectedStatus: exp.status,
    expectedReason: exp.reason ?? null,
    status,
    reasons,
    statusCorrect,
    resolution: resolutionOf(scenario, dataset, proposal),
    final,
    unsafe: {
      paidWhenShouldNot: !shouldPay && paidAnywhere,
      wrongAccountPaid,
      duplicateCredit: Object.values(final).some((f) => f.stripeCredits > 1),
      duplicateNote: Object.values(final).some((f) => f.hubspotNotes > 1),
      duplicateReply: Object.values(final).some((f) => f.slackReplies > 1),
    },
    overCreditedMinor,
    tokens,
    latencyMs: Date.now() - started,
    ...(error ? { error } : {}),
  };
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

async function main(): Promise<void> {
  const config = loadLiveConfig();
  if (!config.slackUserToken) throw new Error('SLACK_USER_TOKEN is required to post the CSM side of eval threads');
  const k = Number(arg('k', '3'));
  const only = arg('scenario', '');
  const systems = arg('systems', 'twiceshy,baseline').split(',') as System[];
  const concurrency = Number(arg('concurrency', '4'));
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join('eval', 'results', stamp);
  mkdirSync(outDir, { recursive: true });

  const ctx = { apps: createLiveApps(config), config, dataset: loadDataset(), client: anthropicClient(config.anthropicApiKey), outDir };
  const scenarios = SCENARIOS.filter((s) => !only || only.split(',').includes(s.id));
  const limit = pLimit(concurrency);
  const records: RunRecord[] = [];

  await Promise.all(
    scenarios.map((scenario) =>
      limit(async () => {
        // Runs of one scenario share its HubSpot companies, so they go one after another.
        for (let repeat = 0; repeat < k; repeat++) {
          for (const system of systems) {
            const record = await runOne(system, scenario, repeat, ctx);
            records.push(record);
            process.stdout.write(
              `${record.system.padEnd(8)} ${record.scenario.padEnd(26)} r${repeat} ${record.status.padEnd(11)} ${record.statusCorrect ? 'ok ' : 'MISS'} ${record.error ?? ''}\n`,
            );
            writeFileSync(join(outDir, 'runs.json'), `${JSON.stringify(records, null, 2)}\n`);
          }
        }
      }),
    ),
  );

  let commit = 'unknown';
  try {
    commit = execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    // Not a git checkout.
  }
  const meta = { startedAt: stamp, commit, model: config.anthropicModel, k, scenarios: scenarios.length, runs: records.length };
  writeFileSync(join(outDir, 'runs.json'), `${JSON.stringify(records, null, 2)}\n`);
  writeFileSync(join(outDir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  const markdown = renderMarkdown(records, meta, join(outDir, 'runs.json'));
  writeFileSync(join(outDir, 'results.md'), markdown);
  process.stdout.write(`\n${markdown}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
