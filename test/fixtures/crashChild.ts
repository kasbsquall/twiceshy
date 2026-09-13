import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createMemoryApps, type MemoryState } from '../../src/adapters/fake/memory.js';
import type { Apps } from '../../src/ports.js';
import { CaseStore } from '../../src/runtime/caseStore.js';
import { Ledger } from '../../src/runtime/ledger.js';
import type { CrashPoint } from '../../src/runtime/runner.js';
import { approveCase, prepareCase, resumeUnfinished, type WorkflowDeps } from '../../src/workflow.js';
import { CSM, proposal, THREAD, world } from './world.js';

/**
 * Child process for the crash test. The in-memory apps are saved to disk after every write,
 * so they survive the process being killed the way real apps would.
 */
const [, , dir, mode, point] = process.argv as [string, string, string, 'approve' | 'resume', CrashPoint | undefined];
const statePath = join(dir, 'apps.json');
const state: MemoryState = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : world();
const save = () => writeFileSync(statePath, JSON.stringify(state));

function persisting(apps: Apps): Apps {
  const wrap = <T extends object>(port: T, writes: Array<keyof T>): T =>
    new Proxy(port, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (typeof value !== 'function' || !writes.includes(key as keyof T)) return value;
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          save();
          return result;
        };
      },
    });
  return {
    chat: wrap(apps.chat, ['postMessage', 'updateMessage']),
    crm: wrap(apps.crm, ['addNote']),
    tracker: apps.tracker,
    billing: wrap(apps.billing, ['createCredit']),
  };
}

const deps: WorkflowDeps = {
  apps: persisting(createMemoryApps(state)),
  ledger: new Ledger(join(dir, 'ledger')),
  cases: new CaseStore(join(dir, 'cases')),
  internalUsers: new Map([[CSM, 'csm']]),
  approverUserIds: new Set(['U_MANAGER']),
  approvalChannelId: 'C_APPROVALS',
  postCards: true,
};

if (mode === 'approve') {
  save();
  const record = await prepareCase(deps, THREAD, async () => ({ proposal }));
  save();
  await approveCase(deps, record.runId, 'U_MANAGER', point ? { crashAt: point, crashMode: 'exit' } : {});
} else {
  await resumeUnfinished(deps);
}
save();
