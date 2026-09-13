import { join } from 'node:path';
import { createLiveApps, type LiveApps } from './adapters/live/index.js';
import type { LiveConfig } from './config.js';
import { CaseStore } from './runtime/caseStore.js';
import { Ledger } from './runtime/ledger.js';
import type { WorkflowDeps } from './workflow.js';

export const DEMO_DIR = 'ledger';

/** Workflow wiring for the demo and the approval server: live apps, cards on, ledger on disk. */
export function liveDeps(config: LiveConfig, apps: LiveApps = createLiveApps(config)): WorkflowDeps & { apps: LiveApps } {
  return {
    apps,
    ledger: new Ledger(DEMO_DIR),
    cases: new CaseStore(join(DEMO_DIR, 'cases')),
    internalUsers: config.internalUsers,
    approverUserIds: config.approverUserIds,
    allowSelfApproval: config.allowSelfApproval,
    approvalChannelId: config.slackApprovalChannelId,
    postCards: true,
  };
}
