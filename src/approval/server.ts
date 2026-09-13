import bolt from '@slack/bolt';
import { loadLiveConfig } from '../config.js';
import { liveDeps } from '../liveDeps.js';
import type { CrashPoint } from '../runtime/runner.js';
import { approveCase, resumeUnfinished } from '../workflow.js';
import { APPROVE_ACTION } from './card.js';

const log = (message: string) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${message}\n`);

function crashPoint(): CrashPoint | undefined {
  const i = process.argv.indexOf('--crash-after');
  const step = i >= 0 ? process.argv[i + 1] : undefined;
  if (!step) return undefined;
  // Accepts a step (after it) or a full point such as lost-response:stripe_credit.
  return (step.includes(':') ? step : `after:${step}`) as CrashPoint;
}

/**
 * Listens for Approve clicks over Socket Mode. On start it first finishes any approved run that
 * was interrupted. With --crash-after <step> it kills its own process mid-run, for the demo.
 */
async function main(): Promise<void> {
  const config = loadLiveConfig();
  const deps = liveDeps(config);
  const crashAt = crashPoint();
  const runOptions = { onEvent: log, ...(crashAt ? { crashAt, crashMode: 'exit' as const } : {}) };

  const unfinished = deps.ledger.unfinishedRuns();
  if (unfinished.length > 0) {
    log(`Resuming ${unfinished.length} interrupted run(s): ${unfinished.join(', ')}`);
    for (const result of await resumeUnfinished(deps, { onEvent: log })) {
      log(`Resume finished: ${result.status}`);
    }
  }

  const app = new bolt.App({ token: config.slackBotToken, appToken: config.slackAppToken, socketMode: true });

  app.action(APPROVE_ACTION, async ({ ack, body, action, client }) => {
    await ack();
    const runId = 'value' in action && typeof action.value === 'string' ? action.value : '';
    const userId = body.user.id;
    log(`Approve pressed by ${userId} on ${runId}`);
    const result = await approveCase(deps, runId, userId, runOptions);
    log(`Run ${runId}: ${result.status}`);
    if (result.status === 'forbidden' && body.channel?.id) {
      await client.chat.postEphemeral({ channel: body.channel.id, user: userId, text: 'Only approvers listed in APPROVER_SLACK_USER_IDS can approve credits.' });
    }
  });

  await app.start();
  log(`TwiceShy approvals listening${crashAt ? `, will crash at ${crashAt}` : ''}`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
