import { policyCredit } from '../policy.js';
import type { CaseSnapshot, CheckResult, ReasonCode, ResolvedProposal, Role, Verdict, VerdictStatus } from '../types.js';
import {
  checkAccountIdentity,
  checkAmountVsPolicy,
  checkDuplicateCredit,
  checkPromiseAuthority,
  checkStaleState,
} from './checks.js';

const BLOCKING: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  'DUPLICATE_CREDIT',
  'ACCOUNT_IDENTITY_MISMATCH',
  'STALE_STATE',
  'VERIFICATION_UNAVAILABLE',
]);

export function statusFor(reasons: ReasonCode[]): VerdictStatus {
  if (reasons.some((r) => BLOCKING.has(r))) return 'BLOCK';
  return reasons.length > 0 ? 'HOLD' : 'PASS';
}

function toVerdict(checks: CheckResult[], creditMinor: number | null, extra: ReasonCode[] = []): Verdict {
  const reasons = [...extra, ...checks.flatMap((c) => (c.ok || !c.reason ? [] : [c.reason]))];
  return { status: statusFor(reasons), reasons, checks, creditMinor };
}

/** Runs the four pre-approval checks on a verified proposal. Pure: no I/O. */
export function evaluateCase(
  proposal: ResolvedProposal,
  snapshot: CaseSnapshot,
  internalUsers: ReadonlyMap<string, Role>,
): Verdict {
  const creditMinor = policyCredit(snapshot.company.slaTier, snapshot.incident.severity);
  const eligibility: ReasonCode[] =
    creditMinor === 0 || snapshot.incident.resolvedAt === null ? ['INCIDENT_NOT_ELIGIBLE'] : [];
  const checks = [
    checkDuplicateCredit(snapshot),
    checkAmountVsPolicy(proposal, creditMinor, internalUsers),
    checkPromiseAuthority(proposal, internalUsers),
    checkAccountIdentity(proposal, snapshot),
  ];
  return toVerdict(checks, creditMinor, eligibility);
}

/** Runs on Approve: all checks again on fresh state, plus the stale-state diff. */
export function evaluateOnApproval(
  proposal: ResolvedProposal,
  before: CaseSnapshot,
  after: CaseSnapshot,
  internalUsers: ReadonlyMap<string, Role>,
): Verdict {
  const fresh = evaluateCase(proposal, after, internalUsers);
  const checks = [...fresh.checks, checkStaleState(before, after)];
  const eligibility = fresh.reasons.filter((r) => r === 'INCIDENT_NOT_ELIGIBLE');
  return toVerdict(checks, fresh.creditMinor, eligibility);
}

export function unavailableVerdict(detail: string): Verdict {
  return {
    status: 'BLOCK',
    reasons: ['VERIFICATION_UNAVAILABLE'],
    checks: [{ check: 'stale_state', ok: false, reason: 'VERIFICATION_UNAVAILABLE', detail, evidence: [] }],
    creditMinor: null,
  };
}
