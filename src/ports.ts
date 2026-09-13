import type { Cents, Company, Currency, ExistingCredit, Incident, SlackMessage } from './types.js';

export interface PostOptions {
  threadTs?: string;
  runId?: string;
  step?: string;
  blocks?: unknown[];
}

export interface ChatPort {
  getThread(channelId: string, threadTs: string): Promise<SlackMessage[]>;
  postMessage(channelId: string, text: string, options?: PostOptions): Promise<{ ts: string }>;
  updateMessage(channelId: string, ts: string, text: string, blocks?: unknown[]): Promise<void>;
  /** Finds a message this system posted for a run and step, reading the thread (no search index). */
  findPostedMessage(channelId: string, threadTs: string, runId: string, step: string): Promise<string | null>;
}

export interface CrmPort {
  searchCompanies(query: string): Promise<Company[]>;
  getCompany(companyId: string): Promise<Company | null>;
  addNote(companyId: string, body: string): Promise<{ id: string }>;
  /** Finds a note for a run by listing the company's associated notes (no search index). */
  findNote(companyId: string, runId: string): Promise<string | null>;
}

export interface TrackerPort {
  listIncidents(): Promise<Incident[]>;
  getIncident(incidentId: string): Promise<Incident | null>;
}

export interface CreateCreditOptions {
  idempotencyKey: string;
  metadata: Record<string, string>;
  description: string;
}

export interface BillingPort {
  listCredits(customerId: string): Promise<ExistingCredit[]>;
  createCredit(
    customerId: string,
    amountMinor: Cents,
    currency: Currency,
    options: CreateCreditOptions,
  ): Promise<{ id: string }>;
  customerExists(customerId: string): Promise<boolean>;
}

export interface Apps {
  chat: ChatPort;
  crm: CrmPort;
  tracker: TrackerPort;
  billing: BillingPort;
}
