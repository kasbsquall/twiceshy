import type { Cents, Role, Severity, SlaTier } from './types.js';

/**
 * SLA credit per incident, decided by contract tier (HubSpot) and incident severity (Linear).
 * Values are demo policy, in cents. Shown verbatim in the README and on approval cards.
 */
export const CREDIT_TABLE: Readonly<Record<SlaTier, Readonly<Record<Severity, Cents>>>> = {
  standard: { sev1: 50_000, sev2: 25_000, sev3: 0 },
  premium: { sev1: 100_000, sev2: 50_000, sev3: 10_000 },
  enterprise: { sev1: 250_000, sev2: 100_000, sev3: 25_000 },
};

/** The largest credit each internal role may promise a customer. */
export const ROLE_CAPS: Readonly<Record<Role, Cents>> = {
  csm: 100_000,
  cs_manager: 500_000,
};

/** Cards flag accounts renewing within this many days. */
export const RENEWAL_WINDOW_DAYS = 90;

/** A credit without metadata counts as the same compensation if created this close to the incident. */
export const MANUAL_CREDIT_WINDOW_DAYS = 14;

export function policyCredit(tier: SlaTier, severity: Severity): Cents {
  return CREDIT_TABLE[tier][severity];
}

export function formatUsd(amountMinor: Cents): string {
  const dollars = amountMinor / 100;
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}
