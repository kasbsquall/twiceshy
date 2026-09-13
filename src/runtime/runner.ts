import type { StepName } from '../types.js';
import type { Ledger } from './ledger.js';

export interface StepSpec {
  name: StepName;
  /** Looks the object up in the app by run id, without a search index. */
  find(): Promise<string | null>;
  execute(): Promise<{ id: string }>;
}

export type CrashPoint = `after:${StepName}` | `lost-response:${StepName}`;

export class SimulatedCrash extends Error {
  constructor(readonly point: CrashPoint) {
    super(`Simulated crash at ${point}`);
  }
}

export interface RunOptions {
  /** Where to crash, for the eval and the demo. */
  crashAt?: CrashPoint;
  /** "exit" kills the process for real; "throw" is for in-process tests and the eval. */
  crashMode?: 'throw' | 'exit';
  /** Called before executing a step whose intent was logged but whose object was not found. */
  beforeRetry?(step: StepName): Promise<void>;
  onEvent?(message: string): void;
}

export interface RunOutcome {
  objects: Partial<Record<StepName, string>>;
  resumed: StepName[];
}

function crash(point: CrashPoint, options: RunOptions): void {
  if (options.crashAt !== point) return;
  options.onEvent?.(`CRASH ${point}`);
  if (options.crashMode === 'exit') process.exit(137);
  throw new SimulatedCrash(point);
}

/**
 * Executes steps exactly once across restarts. Intent is written before the call and the
 * object id after it; on restart, a step with intent and no done is reconciled against the app.
 */
export async function runSteps(ledger: Ledger, runId: string, steps: StepSpec[], options: RunOptions = {}): Promise<RunOutcome> {
  const outcome: RunOutcome = { objects: {}, resumed: [] };
  for (const step of steps) {
    const done = ledger.entries(runId).find((e) => e.step === step.name && e.status === 'done');
    if (done?.objectId) {
      outcome.objects[step.name] = done.objectId;
      continue;
    }

    if (ledger.hasStatus(runId, step.name, 'intent')) {
      const existing = await step.find();
      if (existing) {
        ledger.append({ runId, step: step.name, status: 'done', objectId: existing, detail: 'reconciled after interruption' });
        options.onEvent?.(`RECONCILED ${step.name} -> ${existing}`);
        outcome.objects[step.name] = existing;
        outcome.resumed.push(step.name);
        continue;
      }
      await options.beforeRetry?.(step.name);
      outcome.resumed.push(step.name);
    } else {
      ledger.append({ runId, step: step.name, status: 'intent' });
    }

    options.onEvent?.(`EXECUTE ${step.name}`);
    const { id } = await step.execute();
    crash(`lost-response:${step.name}`, options);
    ledger.append({ runId, step: step.name, status: 'done', objectId: id });
    outcome.objects[step.name] = id;
    crash(`after:${step.name}`, options);
  }
  ledger.append({ runId, step: 'run', status: 'done' });
  return outcome;
}
