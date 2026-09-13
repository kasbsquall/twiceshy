/** Money is always in minor units (cents). */
export type Cents = number;
export type Currency = 'usd';

export type Role = 'csm' | 'cs_manager';
export type SlaTier = 'standard' | 'premium' | 'enterprise';
export type Severity = 'sev1' | 'sev2' | 'sev3';
export type AppName = 'slack' | 'hubspot' | 'linear' | 'stripe';

export interface EvidenceRef {
  app: AppName;
  id: string;
  quote?: string;
}

export interface SlackMessage {
  ts: string;
  threadTs: string;
  userId: string;
  text: string;
}

export interface Company {
  id: string;
  name: string;
  slaTier: SlaTier;
  renewalDate: string;
  annualValueMinor: Cents;
  stripeCustomerId: string;
}

export interface Incident {
  id: string;
  identifier: string;
  title: string;
  severity: Severity;
  startedAt: string;
  resolvedAt: string | null;
  affectedCompanyIds: string[];
}

export type CreditKind = 'balance_transaction' | 'credit_note' | 'refund';

export interface ExistingCredit {
  id: string;
  kind: CreditKind;
  amountMinor: Cents;
  createdAt: string;
  metadata: Record<string, string>;
}

export interface CreditPromise {
  amountMinor: Cents;
  currency: Currency;
  authorUserId: string;
  messageTs: string;
  quote: string;
}

export interface ResolvedProposal {
  kind: 'resolved';
  companyId: string;
  stripeCustomerId: string;
  incidentId: string;
  promise: CreditPromise | null;
  /** One sentence explaining how the account and incident were chosen, built from evidence. */
  reasoning: string;
  evidence: EvidenceRef[];
}

export interface AmbiguousProposal {
  kind: 'ambiguous';
  candidates: Array<{ companyId: string; incidentId?: string; why: string }>;
  question: string;
}

export type Proposal = ResolvedProposal | AmbiguousProposal;

export type ReasonCode =
  | 'AMBIGUOUS'
  | 'PROPOSAL_UNVERIFIED'
  | 'INCIDENT_NOT_ELIGIBLE'
  | 'DUPLICATE_CREDIT'
  | 'AMOUNT_VS_POLICY'
  | 'AMOUNT_ABOVE_ROLE_CAP'
  | 'PROMISE_NOT_AUTHORIZED'
  | 'ACCOUNT_IDENTITY_MISMATCH'
  | 'STALE_STATE'
  | 'VERIFICATION_UNAVAILABLE';

export type CheckName =
  | 'duplicate_credit'
  | 'amount_vs_policy'
  | 'promise_authority'
  | 'account_identity'
  | 'stale_state';

export interface CheckResult {
  check: CheckName;
  ok: boolean;
  reason?: ReasonCode;
  /** Plain-language line shown to the approver. */
  detail: string;
  evidence: EvidenceRef[];
}

export type VerdictStatus = 'PASS' | 'HOLD' | 'BLOCK';

export interface Verdict {
  status: VerdictStatus;
  reasons: ReasonCode[];
  checks: CheckResult[];
  creditMinor: Cents | null;
}

/** Everything read from the apps before the approval card is posted. */
export interface CaseSnapshot {
  company: Company;
  incident: Incident;
  thread: SlackMessage[];
  credits: ExistingCredit[];
  readAt: string;
}

export type StepName = 'stripe_credit' | 'hubspot_note' | 'slack_reply';
export type LedgerStatus = 'intent' | 'done' | 'paused' | 'failed';

export interface LedgerEntry {
  runId: string;
  step: StepName | 'run';
  status: LedgerStatus;
  at: string;
  objectId?: string;
  detail?: string;
}
