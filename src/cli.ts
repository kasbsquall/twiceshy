import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { runOffline } from './offline.js';
import { formatUsd } from './policy.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);
const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

async function demo(): Promise<void> {
  const scenarioId = arg('scenario') ?? 's1-lookalike';
  if (flag('offline')) return runOffline(scenarioId, out);

  const [{ loadLiveConfig }, { liveDeps }, { SCENARIOS }, { loadDataset }, harness, { anthropicClient, resolveThread }, { prepareCase, newRunId }, { baselineResolve }, { baselineExecute }] =
    await Promise.all([
      import('./config.js'),
      import('./liveDeps.js'),
      import('./eval/scenarios.js'),
      import('./eval/seed.js'),
      import('./eval/harness.js'),
      import('./agent/resolve.js'),
      import('./workflow.js'),
      import('./agent/baselineResolve.js'),
      import('./eval/baselineExecute.js'),
    ]);
  const config = loadLiveConfig();
  const scenario = SCENARIOS.find((s) => s.id === scenarioId);
  if (!scenario) throw new Error(`Unknown scenario ${scenarioId}. Options: ${SCENARIOS.map((s) => s.id).join(', ')}`);
  if (!config.slackUserToken) throw new Error('SLACK_USER_TOKEN is required to post the CSM side of the demo thread');
  const deps = liveDeps(config);
  const dataset = loadDataset();
  const runId = newRunId();

  const universe = await harness.freshUniverse(deps.apps, dataset, scenario, `demo:${runId}`);
  const thread = await harness.postThread(deps.apps, config.slackUserToken, config.slackDemoChannelId, scenario);
  out(`Posted the customer thread in Slack (${thread.threadTs}). Stripe customers: ${Object.values(universe).join(', ')}`);
  const prior = scenario.setup?.priorCredit;
  if (prior && !prior.incident) {
    const id = await deps.apps.billing.createManualCredit(universe[prior.company]!, prior.amountMinor, 'usd');
    out(`A teammate already credited ${formatUsd(prior.amountMinor)} by hand in Stripe: ${id}`);
  }

  const client = anthropicClient(config.anthropicApiKey);
  if (flag('baseline')) {
    const crashAfter = arg('crash-after') as 'stripe_credit' | 'hubspot_note' | 'slack_reply' | undefined;
    const resolved = await baselineResolve(client, config.anthropicModel, deps.apps, thread);
    if (!resolved.proposal) return out(`Baseline produced no proposal: ${resolved.failure}`);
    if (scenario.beforeApprove) await deps.apps.billing.createManualCredit(universe[scenario.beforeApprove.manualCredit.company]!, scenario.beforeApprove.manualCredit.amountMinor, 'usd');
    const result = await baselineExecute(deps.apps, resolved.proposal, thread, runId, crashAfter);
    out(`Baseline executed${result.restarted ? ' after a crash and a restart' : ''}: ${JSON.stringify(result.objects)}`);
    return;
  }

  out('Claude is reading Slack, HubSpot, Linear and Stripe...');
  const record = await prepareCase(deps, thread, (apps, t) => resolveThread(client, config.anthropicModel, apps, t), runId);
  out(`Verdict ${record.verdict.status} [${record.verdict.reasons.join(', ')}]. Card posted in the approvals channel.`);
  out(`Run id: ${record.runId}`);
  out('Start `npm run approvals` (add `-- --crash-after hubspot_note` to kill it mid-run) and press Approve in Slack.');
}

/** Prints what the agent read, decided and wrote for one run, from the case file and the ledger. */
async function replay(): Promise<void> {
  const runId = process.argv[3];
  if (!runId) throw new Error('Usage: npm run replay -- <run_id>');
  const { Ledger } = await import('./runtime/ledger.js');
  const { CaseStore } = await import('./runtime/caseStore.js');
  const dirs = ['ledger', ...(existsSync(join('eval', 'results')) ? (await import('node:fs')).readdirSync(join('eval', 'results')).map((d) => join('eval', 'results', d, 'runs')) : [])];
  for (const base of dirs) {
    const ledgerDir = base === 'ledger' ? base : join(base, 'ledger');
    const record = new CaseStore(join(base, 'cases')).load(runId);
    const entries = existsSync(ledgerDir) ? new Ledger(ledgerDir).entries(runId) : [];
    if (!record && entries.length === 0) continue;
    if (record) {
      out(`Run ${runId}, thread ${record.thread.threadTs}`);
      if (record.proposal?.kind === 'resolved' && record.snapshot) {
        out(`  READ     HubSpot ${record.snapshot.company.name} (${record.snapshot.company.id}), Linear ${record.snapshot.incident.identifier}, Stripe ${record.snapshot.credits.length} prior credit(s)`);
      }
      for (const s of record.searches) out(`  SEARCH   HubSpot "${s.query}": ${s.matches.join(', ') || 'no matches'}`);
      out(`  DECIDED  ${record.verdict.status} [${record.verdict.reasons.join(', ')}]`);
      if (record.approval) out(`  APPROVE  by ${record.approval.userId} at ${record.approval.at}, re-check ${record.approval.verdict.status}`);
    }
    let previous = '';
    for (const e of entries) {
      if (previous && e.at > previous && e.step !== 'run' && e.status === 'done' && e.detail?.includes('reconciled')) out('  ...      process restarted');
      out(`  ${e.at.slice(11, 23)} ${e.step.padEnd(13)} ${e.status.padEnd(6)} ${e.objectId ?? ''} ${e.detail ?? ''}`);
      previous = e.at;
    }
    return;
  }
  throw new Error(`No run ${runId} found in ledger/ or eval/results/`);
}

const command = process.argv[2];
(command === 'replay' ? replay() : demo()).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
