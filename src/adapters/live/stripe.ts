import Stripe from 'stripe';
import type { BillingPort, CreateCreditOptions } from '../../ports.js';
import type { Cents, Currency, ExistingCredit } from '../../types.js';

const LIST_CAP = 1000;

function toIso(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/**
 * Stripe test mode billing. Prior compensation is read through list endpoints only:
 * Stripe Search is eventually consistent and does not cover balance transactions or refunds.
 */
export class StripeBilling implements BillingPort {
  private readonly stripe: Stripe;

  constructor(secretKey: string) {
    if (!secretKey.startsWith('sk_test_')) throw new Error('TwiceShy only runs against Stripe test mode');
    this.stripe = new Stripe(secretKey, { maxNetworkRetries: 2 });
  }

  async listCredits(customerId: string): Promise<ExistingCredit[]> {
    const [balance, creditNotes, charges] = await Promise.all([
      this.stripe.customers.listBalanceTransactions(customerId, { limit: 100 }).autoPagingToArray({ limit: LIST_CAP }),
      this.stripe.creditNotes.list({ customer: customerId, limit: 100 }).autoPagingToArray({ limit: LIST_CAP }),
      this.stripe.charges.list({ customer: customerId, limit: 100 }).autoPagingToArray({ limit: LIST_CAP }),
    ]);

    const credits: ExistingCredit[] = [];
    for (const txn of balance) {
      // Negative amounts are credits to the customer; credit notes also create balance transactions,
      // which are reported once below as credit notes.
      if (txn.amount >= 0 || txn.credit_note) continue;
      credits.push({
        id: txn.id,
        kind: 'balance_transaction',
        amountMinor: -txn.amount,
        createdAt: toIso(txn.created),
        metadata: { ...(txn.metadata ?? {}) },
      });
    }
    for (const note of creditNotes) {
      if (note.status === 'void') continue;
      credits.push({
        id: note.id,
        kind: 'credit_note',
        amountMinor: note.total,
        createdAt: toIso(note.created),
        metadata: { ...(note.metadata ?? {}) },
      });
    }
    const chargeRefunds = await Promise.all(
      charges
        .filter((charge) => charge.amount_refunded > 0)
        .map((charge) => this.stripe.refunds.list({ charge: charge.id, limit: 100 }).autoPagingToArray({ limit: LIST_CAP })),
    );
    for (const refund of chargeRefunds.flat()) {
      if (refund.status === 'failed' || refund.status === 'canceled') continue;
      credits.push({
        id: refund.id,
        kind: 'refund',
        amountMinor: refund.amount,
        createdAt: toIso(refund.created),
        metadata: { ...(refund.metadata ?? {}) },
      });
    }
    return credits;
  }

  async createCredit(
    customerId: string,
    amountMinor: Cents,
    currency: Currency,
    options: CreateCreditOptions,
  ): Promise<{ id: string }> {
    if (!Number.isInteger(amountMinor) || amountMinor <= 0) throw new Error(`Invalid credit amount ${amountMinor}`);
    const txn = await this.stripe.customers.createBalanceTransaction(
      customerId,
      { amount: -amountMinor, currency, description: options.description, metadata: options.metadata },
      { idempotencyKey: options.idempotencyKey },
    );
    return { id: txn.id };
  }

  async customerExists(customerId: string): Promise<boolean> {
    try {
      const customer = await this.stripe.customers.retrieve(customerId);
      return !('deleted' in customer && customer.deleted);
    } catch (error) {
      if (error instanceof Stripe.errors.StripeInvalidRequestError && error.statusCode === 404) return false;
      throw error;
    }
  }

  /** Used by the eval seeder: a fresh test customer per scenario run. */
  async createTestCustomer(name: string, metadata: Record<string, string>): Promise<string> {
    const customer = await this.stripe.customers.create({ name, metadata });
    return customer.id;
  }

  /** Used by the eval seeder to simulate a teammate crediting by hand in the dashboard (no run metadata). */
  async createManualCredit(customerId: string, amountMinor: Cents, currency: Currency): Promise<string> {
    const txn = await this.stripe.customers.createBalanceTransaction(customerId, {
      amount: -amountMinor,
      currency,
      description: 'Goodwill credit',
    });
    return txn.id;
  }
}
