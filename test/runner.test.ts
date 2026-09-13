import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ledger } from '../src/runtime/ledger.js';
import { runSteps, SimulatedCrash, type CrashPoint, type StepSpec } from '../src/runtime/runner.js';
import type { StepName } from '../src/types.js';

/** A fake app per step that records created objects tagged with the run id. */
function fakeWorld() {
  const created: Record<StepName, Array<{ id: string; runId: string }>> = {
    stripe_credit: [],
    hubspot_note: [],
    slack_reply: [],
  };
  let n = 0;
  const steps = (runId: string): StepSpec[] =>
    (Object.keys(created) as StepName[]).map((name) => ({
      name,
      find: async () => created[name].find((o) => o.runId === runId)?.id ?? null,
      execute: async () => {
        const id = `${name}_${++n}`;
        created[name].push({ id, runId });
        return { id };
      },
    }));
  return { created, steps };
}

const POINTS: CrashPoint[] = [
  'after:stripe_credit',
  'after:hubspot_note',
  'after:slack_reply',
  'lost-response:stripe_credit',
];

describe('durable runner', () => {
  for (const point of POINTS) {
    it(`creates exactly one object per app when crashing at ${point} and restarting`, async () => {
      const ledger = new Ledger(mkdtempSync(join(tmpdir(), 'twiceshy-')));
      const world = fakeWorld();
      const runId = 'run_test';

      await expect(runSteps(ledger, runId, world.steps(runId), { crashAt: point })).rejects.toBeInstanceOf(SimulatedCrash);
      const restarted = new Ledger((ledger as unknown as { dir: string }).dir);
      const outcome = await runSteps(restarted, runId, world.steps(runId));

      expect(world.created.stripe_credit).toHaveLength(1);
      expect(world.created.hubspot_note).toHaveLength(1);
      expect(world.created.slack_reply).toHaveLength(1);
      expect(Object.keys(outcome.objects)).toHaveLength(3);
    });
  }

  it('a naive restart without the ledger duplicates side effects', async () => {
    const world = fakeWorld();
    const naive = async (crashAfterFirst: boolean) => {
      for (const [i, step] of world.steps('run_naive').entries()) {
        await step.execute();
        if (crashAfterFirst && i === 0) throw new Error('crash');
      }
    };
    await expect(naive(true)).rejects.toThrow('crash');
    await naive(false);
    expect(world.created.stripe_credit).toHaveLength(2);
  });
});
