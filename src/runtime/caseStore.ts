import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ThreadLocation } from '../agent/tools.js';
import type { CaseSnapshot, Cents, Proposal, ReasonCode, StepName, Verdict } from '../types.js';

export interface CaseRecord {
  runId: string;
  thread: ThreadLocation;
  createdAt: string;
  proposal: Proposal | null;
  /** Plain-language reason when the proposal could not be verified. */
  verificationDetail?: string;
  verdict: Verdict;
  snapshot: CaseSnapshot | null;
  /** HubSpot searches the agent ran, re-run by code so the card never repeats model text. */
  searches: Array<{ query: string; matches: string[] }>;
  cardTs?: string;
  approval?: { userId: string; at: string; snapshot: CaseSnapshot; verdict: Verdict };
  outcome?: {
    status: 'done' | 'blocked' | 'failed';
    objects: Partial<Record<StepName, string>>;
    resumed: StepName[];
    creditMinor: Cents | null;
    reasons: ReasonCode[];
    detail?: string;
  };
  usage?: { inputTokens: number; outputTokens: number; turns: number; latencyMs: number };
}

/** One JSON file per case next to the ledger. Written atomically with a rename. */
export class CaseStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private file(runId: string): string {
    if (!/^[\w-]+$/.test(runId)) throw new Error(`Invalid run id ${runId}`);
    return join(this.dir, `${runId}.case.json`);
  }

  save(record: CaseRecord): void {
    const path = this.file(record.runId);
    writeFileSync(`${path}.tmp`, JSON.stringify(record, null, 2));
    renameSync(`${path}.tmp`, path);
  }

  load(runId: string): CaseRecord | null {
    const path = this.file(runId);
    return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as CaseRecord) : null;
  }
}
