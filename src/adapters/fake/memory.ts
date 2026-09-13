import type { Apps, BillingPort, ChatPort, CreateCreditOptions, CrmPort, PostOptions, TrackerPort } from '../../ports.js';
import type { Cents, Company, Currency, ExistingCredit, Incident, SlackMessage } from '../../types.js';

/**
 * In-memory apps for offline mode and unit tests. Never used for reported eval metrics.
 */
export interface MemoryState {
  companies: Company[];
  incidents: Incident[];
  threads: Record<string, SlackMessage[]>;
  credits: Record<string, ExistingCredit[]>;
  notes: Record<string, Array<{ id: string; body: string }>>;
  posted: Array<{ channelId: string; ts: string; threadTs?: string; text: string; runId?: string; step?: string }>;
  idempotency: Record<string, string>;
}

export class InjectedFault extends Error {
  constructor(where: string) {
    super(`Injected fault: ${where} unavailable (simulated 429)`);
  }
}

export interface Faults {
  /** Names of read operations that throw once, e.g. "billing.listCredits". */
  failReads: Set<string>;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${(++counter).toString().padStart(6, '0')}`;

function maybeFail(faults: Faults, name: string): void {
  if (faults.failReads.has(name)) {
    faults.failReads.delete(name);
    throw new InjectedFault(name);
  }
}

export function createMemoryApps(state: MemoryState, faults: Faults = { failReads: new Set() }): Apps {
  const chat: ChatPort = {
    async getThread(_channelId, threadTs) {
      maybeFail(faults, 'chat.getThread');
      return [...(state.threads[threadTs] ?? [])];
    },
    async postMessage(channelId, text, options: PostOptions = {}) {
      const ts = `${Date.now() / 1000}${(++counter).toString()}`;
      state.posted.push({ channelId, ts, threadTs: options.threadTs, text, runId: options.runId, step: options.step });
      return { ts };
    },
    async updateMessage(channelId, ts, text) {
      const message = state.posted.find((p) => p.channelId === channelId && p.ts === ts);
      if (message) message.text = text;
    },
    async findPostedMessage(channelId, threadTs, runId, step) {
      maybeFail(faults, 'chat.findPostedMessage');
      const found = state.posted.find(
        (p) => p.channelId === channelId && p.threadTs === threadTs && p.runId === runId && p.step === step,
      );
      return found?.ts ?? null;
    },
  };

  const crm: CrmPort = {
    async searchCompanies(query) {
      maybeFail(faults, 'crm.searchCompanies');
      const q = query.toLowerCase();
      return state.companies.filter((c) => c.name.toLowerCase().includes(q));
    },
    async getCompany(companyId) {
      maybeFail(faults, 'crm.getCompany');
      return state.companies.find((c) => c.id === companyId) ?? null;
    },
    async addNote(companyId, body) {
      const id = nextId('note');
      (state.notes[companyId] ??= []).push({ id, body });
      return { id };
    },
    async findNote(companyId, runId) {
      maybeFail(faults, 'crm.findNote');
      return state.notes[companyId]?.find((n) => n.body.includes(runId))?.id ?? null;
    },
  };

  const tracker: TrackerPort = {
    async listIncidents() {
      maybeFail(faults, 'tracker.listIncidents');
      return [...state.incidents];
    },
    async getIncident(incidentId) {
      maybeFail(faults, 'tracker.getIncident');
      return state.incidents.find((i) => i.id === incidentId) ?? null;
    },
  };

  const billing: BillingPort = {
    async listCredits(customerId) {
      maybeFail(faults, 'billing.listCredits');
      return [...(state.credits[customerId] ?? [])];
    },
    async createCredit(customerId: string, amountMinor: Cents, _currency: Currency, options: CreateCreditOptions) {
      const replay = state.idempotency[options.idempotencyKey];
      if (replay) return { id: replay };
      const id = nextId('cbtxn');
      (state.credits[customerId] ??= []).push({
        id,
        kind: 'balance_transaction',
        amountMinor,
        createdAt: new Date().toISOString(),
        metadata: { ...options.metadata },
      });
      state.idempotency[options.idempotencyKey] = id;
      return { id };
    },
    async customerExists(customerId) {
      return state.companies.some((c) => c.stripeCustomerId === customerId);
    },
  };

  return { chat, crm, tracker, billing };
}

export function emptyState(): MemoryState {
  return { companies: [], incidents: [], threads: {}, credits: {}, notes: {}, posted: [], idempotency: {} };
}
