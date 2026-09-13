import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { LedgerEntry, LedgerStatus, StepName } from '../types.js';

/**
 * Append-only write-ahead ledger, one JSONL file per run. Every append is flushed to disk
 * before the caller touches an external app, so a crash never loses an intent.
 */
export class Ledger {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(runId: string): string {
    if (!/^[\w-]+$/.test(runId)) throw new Error(`Invalid run id ${runId}`);
    return join(this.dir, `${runId}.jsonl`);
  }

  append(entry: Omit<LedgerEntry, 'at'>): LedgerEntry {
    const full: LedgerEntry = { ...entry, at: new Date().toISOString() };
    const fd = openSync(this.file(entry.runId), 'a');
    try {
      writeSync(fd, `${JSON.stringify(full)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return full;
  }

  entries(runId: string): LedgerEntry[] {
    const path = this.file(runId);
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as LedgerEntry);
  }

  lastStatus(runId: string, step: StepName | 'run'): LedgerEntry | undefined {
    return this.entries(runId).filter((e) => e.step === step).at(-1);
  }

  hasStatus(runId: string, step: StepName | 'run', status: LedgerStatus): boolean {
    return this.entries(runId).some((e) => e.step === step && e.status === status);
  }

  runIds(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.slice(0, -'.jsonl'.length));
  }

  /** Runs that recorded an intent on some step without a matching done. */
  unfinishedRuns(): string[] {
    return this.runIds().filter((runId) => {
      const entries = this.entries(runId);
      if (entries.some((e) => e.step === 'run' && (e.status === 'done' || e.status === 'failed'))) return false;
      return entries.some((e) => e.status === 'intent' && e.step !== 'run');
    });
  }
}
