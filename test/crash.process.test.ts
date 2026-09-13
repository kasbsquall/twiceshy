import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MemoryState } from '../src/adapters/fake/memory.js';

const child = (dir: string, ...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', join('test', 'fixtures', 'crashChild.ts'), dir, ...args], { encoding: 'utf8' });

const POINTS = ['after:stripe_credit', 'after:hubspot_note', 'after:slack_reply', 'lost-response:stripe_credit'];

describe('real process kill', () => {
  for (const point of POINTS) {
    it(`one object per app after the process exits at ${point} and restarts`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'twiceshy-kill-'));
      const killed = child(dir, 'approve', point);
      expect(killed.status, killed.stderr).toBe(137);

      const resumed = child(dir, 'resume');
      expect(resumed.status, resumed.stderr).toBe(0);

      const state = JSON.parse(readFileSync(join(dir, 'apps.json'), 'utf8')) as MemoryState;
      expect((state.credits['cus_inc'] ?? []).filter((c) => c.metadata['run_id'])).toHaveLength(1);
      expect(state.notes['co_inc'] ?? []).toHaveLength(1);
      expect(state.posted.filter((p) => p.step === 'slack_reply')).toHaveLength(1);
    }, 30_000);
  }
});
