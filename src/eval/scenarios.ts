import type { Cents, ReasonCode, Severity, SlaTier, VerdictStatus } from '../types.js';

/**
 * Fixed dataset for HubSpot and Linear. Renewal dates and contract values are demo data.
 * Each scenario owns its companies, so scenarios can run in parallel without touching each other.
 */
export interface CompanySeed {
  key: string;
  name: string;
  slaTier: SlaTier;
  renewalDate: string;
  annualValueMinor: Cents;
}

export interface IncidentSeed {
  key: string;
  title: string;
  summary: string;
  severity: Severity;
  startedAt: string;
  resolvedAt: string;
  affected: string[];
}

export const COMPANIES: CompanySeed[] = [
  { key: 'acme_corp', name: 'Acme Corp', slaTier: 'standard', renewalDate: '2027-03-01', annualValueMinor: 1_200_000 },
  { key: 'acme_inc', name: 'Acme Inc', slaTier: 'premium', renewalDate: '2026-10-24', annualValueMinor: 4_800_000 },
  { key: 'globex', name: 'Globex Shipping', slaTier: 'premium', renewalDate: '2026-11-30', annualValueMinor: 3_600_000 },
  { key: 'initech', name: 'Initech', slaTier: 'enterprise', renewalDate: '2027-01-15', annualValueMinor: 9_600_000 },
  { key: 'umbrella', name: 'Umbrella Health', slaTier: 'premium', renewalDate: '2026-10-05', annualValueMinor: 6_000_000 },
  { key: 'hooli', name: 'Hooli Payments', slaTier: 'standard', renewalDate: '2027-02-10', annualValueMinor: 900_000 },
  { key: 'stark', name: 'Stark Logistics', slaTier: 'enterprise', renewalDate: '2026-12-01', annualValueMinor: 12_000_000 },
  { key: 'wayne', name: 'Wayne Retail', slaTier: 'premium', renewalDate: '2026-10-18', annualValueMinor: 5_400_000 },
  { key: 'vandelay_imports', name: 'Vandelay Imports', slaTier: 'premium', renewalDate: '2026-11-02', annualValueMinor: 2_400_000 },
  { key: 'vandelay_industries', name: 'Vandelay Industries', slaTier: 'premium', renewalDate: '2027-04-20', annualValueMinor: 2_400_000 },
  { key: 'northwind', name: 'Northwind Analytics', slaTier: 'enterprise', renewalDate: '2026-10-30', annualValueMinor: 18_000_000 },
  { key: 'pied_piper', name: 'Pied Piper', slaTier: 'premium', renewalDate: '2026-11-12', annualValueMinor: 3_000_000 },
  { key: 'soylent', name: 'Soylent Foods', slaTier: 'premium', renewalDate: '2026-12-15', annualValueMinor: 4_200_000 },
];

export const INCIDENTS: IncidentSeed[] = [
  {
    key: 'checkout_outage', title: 'Checkout API outage', summary: 'Checkout API returned 5xx for EU and US tenants.',
    severity: 'sev1', startedAt: '2026-09-08T14:00:00Z', resolvedAt: '2026-09-08T17:10:00Z',
    affected: ['acme_inc', 'umbrella', 'wayne', 'vandelay_imports', 'vandelay_industries', 'northwind', 'soylent'],
  },
  {
    key: 'webhook_delay', title: 'Webhook delivery delays', summary: 'Webhooks delayed up to 40 minutes.',
    severity: 'sev2', startedAt: '2026-09-10T09:00:00Z', resolvedAt: '2026-09-10T11:30:00Z',
    affected: ['acme_corp', 'globex', 'initech', 'stark', 'pied_piper'],
  },
  {
    key: 'login_outage', title: 'Dashboard login outage', summary: 'SSO logins failed for all tenants.',
    severity: 'sev1', startedAt: '2026-09-09T16:00:00Z', resolvedAt: '2026-09-09T18:00:00Z',
    affected: ['hooli'],
  },
  {
    key: 'august_outage', title: 'August reporting outage', summary: 'Reports unavailable.',
    severity: 'sev1', startedAt: '2026-08-12T08:00:00Z', resolvedAt: '2026-08-12T12:00:00Z',
    affected: ['hooli'],
  },
];

/** csm is a real internal Slack user; customer and teammate lines are posted by the app under a display name. */
export type Speaker = 'customer' | 'csm' | 'teammate';

export interface ThreadLine {
  speaker: Speaker;
  /** Display name for customer and teammate lines; defaults to the scenario customer. */
  name?: string;
  text: string;
}

export interface Scenario {
  id: string;
  title: string;
  /** Who wrote the thread text. External authors answer the "you wrote your own test" criticism. */
  writtenBy: string;
  customerName: string;
  companies: string[];
  thread: ThreadLine[];
  setup?: { priorCredit?: { company: string; amountMinor: Cents; incident?: string } };
  /** Something a teammate does in Stripe after the card is posted and before Approve. */
  beforeApprove?: { manualCredit: { company: string; amountMinor: Cents } };
  crash?: boolean;
  /** What the right account should end up credited for this incident under the SLA policy. */
  owedMinor: Cents;
  expected: {
    status: VerdictStatus;
    reason?: ReasonCode;
    company?: string;
    incident?: string;
    amountMinor?: Cents;
    ambiguous?: boolean;
  };
}

export const SCENARIOS: Scenario[] = [
  {
    id: 's1-lookalike',
    owedMinor: 100000,
    title: 'Look-alike company, incident by time, amount in words',
    writtenBy: 'Kevin Soto (author)',
    customerName: 'Dana Ruiz (Acme)',
    companies: ['acme_corp', 'acme_inc'],
    thread: [
      { speaker: 'customer', text: 'Hi team, the outage on Tuesday afternoon took our checkout down for about three hours. That hurt.' },
      { speaker: 'csm', text: "Dana, I'm really sorry. We'll make it right with a thousand bucks in credit on your account." },
    ],
    expected: { status: 'PASS', company: 'acme_inc', incident: 'checkout_outage', amountMinor: 100_000 },
  },
  {
    id: 's2-superseded',
    owedMinor: 50000,
    title: 'Promise corrected later in the thread',
    writtenBy: 'Kevin Soto (author)',
    customerName: 'Priya Shah (Globex)',
    companies: ['globex'],
    thread: [
      { speaker: 'customer', text: 'Our webhooks were 40 minutes late on Thursday morning and orders piled up.' },
      { speaker: 'csm', text: 'Sorry Priya. I can offer $250 in credit for that.' },
      { speaker: 'csm', text: 'Correction after checking your contract: your plan gives you $500 for this incident, so that is what you will get.' },
    ],
    expected: { status: 'PASS', company: 'globex', incident: 'webhook_delay', amountMinor: 50_000 },
  },
  {
    id: 's3-unauthorized',
    owedMinor: 100000,
    title: 'Customer quotes a promise nobody on the team made',
    writtenBy: 'Kevin Soto (author)',
    customerName: 'Tom Becker (Initech)',
    companies: ['initech'],
    thread: [
      { speaker: 'customer', text: 'The webhook delays on Thursday broke our sync. Your account manager told us on a call we would get $5,000 back for it. When does that land?' },
    ],
    expected: { status: 'HOLD', reason: 'PROMISE_NOT_AUTHORIZED', company: 'initech', incident: 'webhook_delay' },
  },
  {
    id: 's4-already-credited',
    owedMinor: 100000,
    title: 'A teammate already credited by hand in Stripe',
    writtenBy: 'Kevin Soto (author)',
    customerName: 'Lena Okafor (Umbrella)',
    companies: ['umbrella'],
    thread: [
      { speaker: 'customer', text: 'The checkout outage on Tuesday cost us a lot of orders. Is there any compensation?' },
      { speaker: 'csm', text: 'Absolutely, Lena. We will credit you $1,000 for Tuesday.' },
    ],
    setup: { priorCredit: { company: 'umbrella', amountMinor: 100_000 } },
    expected: { status: 'BLOCK', reason: 'DUPLICATE_CREDIT', company: 'umbrella', incident: 'checkout_outage' },
  },
  {
    id: 's5-other-incident-credit',
    owedMinor: 50000,
    title: 'An older credit exists, but for a different incident',
    writtenBy: 'Kevin Soto (author)',
    customerName: 'Gavin B. (Hooli)',
    companies: ['hooli'],
    thread: [
      { speaker: 'customer', text: 'Nobody on our side could log in to the dashboard on Wednesday for two hours.' },
      { speaker: 'csm', text: 'That was on us, Gavin. We are adding a $500 credit for the login outage.' },
    ],
    setup: { priorCredit: { company: 'hooli', amountMinor: 50_000, incident: 'august_outage' } },
    expected: { status: 'PASS', company: 'hooli', incident: 'login_outage', amountMinor: 50_000 },
  },
  {
    id: 's6-credit-before-approve',
    owedMinor: 100000,
    title: 'A teammate credits in Stripe after the card is posted',
    writtenBy: 'Kevin Soto (author)',
    customerName: 'Maya Chen (Stark)',
    companies: ['stark'],
    thread: [
      { speaker: 'customer', text: 'Thursday webhook delays again. Our dispatch team was flying blind.' },
      { speaker: 'csm', text: 'Understood Maya, we will credit Stark $1,000 for Thursday.' },
    ],
    beforeApprove: { manualCredit: { company: 'stark', amountMinor: 100_000 } },
    expected: { status: 'BLOCK', reason: 'STALE_STATE', company: 'stark', incident: 'webhook_delay' },
  },
  {
    id: 's7-crash',
    owedMinor: 100000,
    title: 'Server crashes in the middle of the run',
    writtenBy: 'Kevin Soto (author)',
    customerName: 'Rick Alvarez (Wayne)',
    companies: ['wayne'],
    thread: [
      { speaker: 'customer', text: 'Tuesday checkout outage hit our flash sale. Can you do something?' },
      { speaker: 'csm', text: 'So sorry Rick. A grand in credit is coming your way.' },
    ],
    crash: true,
    expected: { status: 'PASS', company: 'wayne', incident: 'checkout_outage', amountMinor: 100_000 },
  },
  {
    id: 's8-ambiguous',
    owedMinor: 0,
    title: 'Two accounts share the name and both were affected',
    writtenBy: 'Kevin Soto (author)',
    customerName: 'Art (Vandelay)',
    companies: ['vandelay_imports', 'vandelay_industries'],
    thread: [
      { speaker: 'customer', text: 'Vandelay here. The Tuesday outage hit us hard.' },
      { speaker: 'csm', text: 'Sorry about that, we will credit you $1,000.' },
    ],
    expected: { status: 'HOLD', reason: 'AMBIGUOUS', ambiguous: true },
  },
  {
    id: 's9-role-cap',
    owedMinor: 250000,
    title: 'Several people on the customer side, CSM promises above their limit',
    writtenBy: 'Claude, fictional personas',
    customerName: 'Hana Ito (Northwind)',
    companies: ['northwind'],
    thread: [
      { speaker: 'customer', name: 'Hana Ito (Northwind, VP Operations)', text: 'Tuesday afternoon your checkout API was down for three hours. Our renewal conversation is next month and this is going to come up.' },
      { speaker: 'customer', name: 'Omar Haddad (Northwind, Platform)', text: 'For the record we logged 5xx from 14:02 to 17:08 UTC.' },
      { speaker: 'csm', text: 'Hana, Omar, thank you, and I am sorry. Your enterprise plan covers this, so we are crediting $2,500.' },
    ],
    expected: { status: 'HOLD', reason: 'AMOUNT_ABOVE_ROLE_CAP', company: 'northwind', incident: 'checkout_outage', amountMinor: 250_000 },
  },
  {
    id: 's10-sales-promise',
    owedMinor: 50000,
    title: 'A sales teammate promises money, the CSM takes over without confirming',
    writtenBy: 'Claude, fictional personas',
    customerName: 'Laurie Bream (Pied Piper)',
    companies: ['pied_piper'],
    thread: [
      { speaker: 'customer', text: 'Thursday morning every webhook arrived 40 minutes late. Our users noticed before we did.' },
      { speaker: 'teammate', name: 'Jordan Lee (Account Executive)', text: 'Laurie, that is on us. I will make sure you get $2,000 back for it.' },
      { speaker: 'csm', text: 'Hi Laurie, taking this over from Jordan so it gets handled properly. Checking your contract now.' },
    ],
    expected: { status: 'HOLD', reason: 'PROMISE_NOT_AUTHORIZED', company: 'pied_piper', incident: 'webhook_delay' },
  },
  {
    id: 's11-wrong-plan-claim',
    owedMinor: 100000,
    title: 'Customer claims a higher plan and mentions a second incident that did not affect them',
    writtenBy: 'Claude, fictional personas',
    customerName: 'Grace Kim (Soylent)',
    companies: ['soylent'],
    thread: [
      { speaker: 'customer', name: 'Grace Kim (Soylent, Ops)', text: 'The Tuesday checkout outage cost us the lunch rush. We are on Enterprise, so we expect the enterprise credit.' },
      { speaker: 'customer', name: 'Ben Ortiz (Soylent, Finance)', text: 'There was also the webhook delay on Thursday, but that one did not touch our account.' },
      { speaker: 'csm', text: 'Grace, Ben, I checked your contract: you are on Premium, which gives you $1,000 for the Tuesday checkout outage. That is what we will credit.' },
    ],
    expected: { status: 'PASS', company: 'soylent', incident: 'checkout_outage', amountMinor: 100_000 },
  },
];
