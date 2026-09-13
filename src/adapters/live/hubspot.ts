import { z } from 'zod';
import type { CrmPort } from '../../ports.js';
import type { Company } from '../../types.js';

const BASE = 'https://api.hubapi.com';
const NOTE_TO_COMPANY = 190;

export const COMPANY_PROPS = {
  slaTier: 'twiceshy_sla_tier',
  renewalDate: 'twiceshy_renewal_date',
  annualValue: 'twiceshy_annual_value_usd',
  stripeCustomerId: 'twiceshy_stripe_customer_id',
} as const;

const PROPERTY_LIST = ['name', ...Object.values(COMPANY_PROPS)].join(',');

const companySchema = z.object({
  id: z.string(),
  properties: z.object({
    name: z.string().nullable(),
    [COMPANY_PROPS.slaTier]: z.string().nullable().optional(),
    [COMPANY_PROPS.renewalDate]: z.string().nullable().optional(),
    [COMPANY_PROPS.annualValue]: z.string().nullable().optional(),
    [COMPANY_PROPS.stripeCustomerId]: z.string().nullable().optional(),
  }),
});

type RawCompany = z.infer<typeof companySchema>;

export class HubSpotError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/**
 * HubSpot CRM over REST. Company lookups list and filter on the client instead of using the
 * search endpoint, which indexes with a delay; the demo dataset is small.
 */
export class HubSpotCrm implements CrmPort {
  constructor(private readonly token: string) {}

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      if (response.status === 404) return null as T;
      if (!response.ok) throw new HubSpotError(response.status, `HubSpot ${method} ${path} failed: ${response.status} ${await response.text()}`);
      return (response.status === 204 ? null : await response.json()) as T;
    }
  }

  private toCompany(raw: RawCompany): Company | null {
    const p = raw.properties;
    const tier = p[COMPANY_PROPS.slaTier];
    const stripeId = p[COMPANY_PROPS.stripeCustomerId];
    if (!p.name || !stripeId || (tier !== 'standard' && tier !== 'premium' && tier !== 'enterprise')) return null;
    return {
      id: raw.id,
      name: p.name,
      slaTier: tier,
      renewalDate: p[COMPANY_PROPS.renewalDate] ?? '',
      annualValueMinor: Math.round(Number(p[COMPANY_PROPS.annualValue] ?? 0) * 100),
      stripeCustomerId: stripeId,
    };
  }

  async listAllCompanies(): Promise<Company[]> {
    const companies: Company[] = [];
    let after: string | undefined;
    do {
      const page = await this.request<{ results: unknown[]; paging?: { next?: { after: string } } }>(
        'GET',
        `/crm/v3/objects/companies?limit=100&archived=false&properties=${PROPERTY_LIST}${after ? `&after=${after}` : ''}`,
      );
      for (const raw of page.results) {
        const company = this.toCompany(companySchema.parse(raw));
        if (company) companies.push(company);
      }
      after = page.paging?.next?.after;
    } while (after);
    return companies;
  }

  async searchCompanies(query: string): Promise<Company[]> {
    const q = query.toLowerCase().trim();
    return (await this.listAllCompanies()).filter((c) => c.name.toLowerCase().includes(q));
  }

  async getCompany(companyId: string): Promise<Company | null> {
    if (!/^\d+$/.test(companyId)) return null;
    const raw = await this.request<unknown>('GET', `/crm/v3/objects/companies/${companyId}?properties=${PROPERTY_LIST}`);
    return raw ? this.toCompany(companySchema.parse(raw)) : null;
  }

  async addNote(companyId: string, body: string): Promise<{ id: string }> {
    const note = await this.request<{ id: string }>('POST', '/crm/v3/objects/notes', {
      properties: { hs_timestamp: new Date().toISOString(), hs_note_body: body },
      associations: [{ to: { id: companyId }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: NOTE_TO_COMPANY }] }],
    });
    return { id: note.id };
  }

  async findNote(companyId: string, runId: string): Promise<string | null> {
    const links = await this.request<{ results: Array<{ toObjectId: number | string }> } | null>(
      'GET',
      `/crm/v4/objects/companies/${companyId}/associations/notes?limit=500`,
    );
    const ids = (links?.results ?? []).map((r) => String(r.toObjectId));
    if (ids.length === 0) return null;
    const notes = await this.request<{ results: Array<{ id: string; properties: { hs_note_body?: string | null } }> }>(
      'POST',
      '/crm/v3/objects/notes/batch/read',
      { properties: ['hs_note_body'], inputs: ids.map((id) => ({ id })) },
    );
    return notes.results.find((n) => (n.properties.hs_note_body ?? '').includes(runId))?.id ?? null;
  }

  /** Seeder: creates the TwiceShy company properties if they are missing. */
  async ensureProperties(): Promise<void> {
    const existing = await this.request<{ results: Array<{ name: string }> }>('GET', '/crm/v3/properties/companies');
    const names = new Set(existing.results.map((p) => p.name));
    const wanted = [
      {
        name: COMPANY_PROPS.slaTier,
        label: 'SLA tier',
        type: 'enumeration',
        fieldType: 'select',
        options: ['standard', 'premium', 'enterprise'].map((v, i) => ({ label: v[0]!.toUpperCase() + v.slice(1), value: v, displayOrder: i })),
      },
      { name: COMPANY_PROPS.renewalDate, label: 'Renewal date', type: 'date', fieldType: 'date' },
      { name: COMPANY_PROPS.annualValue, label: 'Annual contract value (USD)', type: 'number', fieldType: 'number' },
      { name: COMPANY_PROPS.stripeCustomerId, label: 'Stripe customer ID', type: 'string', fieldType: 'text' },
    ];
    for (const property of wanted) {
      if (names.has(property.name)) continue;
      await this.request('POST', '/crm/v3/properties/companies', { groupName: 'companyinformation', ...property });
    }
  }

  /** Seeder: creates or updates a company by exact name. */
  async upsertCompany(company: Omit<Company, 'id'>): Promise<string> {
    const properties = {
      name: company.name,
      [COMPANY_PROPS.slaTier]: company.slaTier,
      [COMPANY_PROPS.renewalDate]: company.renewalDate,
      [COMPANY_PROPS.annualValue]: String(company.annualValueMinor / 100),
      [COMPANY_PROPS.stripeCustomerId]: company.stripeCustomerId,
    };
    const page = await this.request<{ results: Array<{ id: string; properties: { name: string | null } }> }>(
      'GET',
      '/crm/v3/objects/companies?limit=100&archived=false&properties=name',
    );
    const match = page.results.find((r) => r.properties.name === company.name);
    if (match) {
      await this.request('PATCH', `/crm/v3/objects/companies/${match.id}`, { properties });
      return match.id;
    }
    const created = await this.request<{ id: string }>('POST', '/crm/v3/objects/companies', { properties });
    return created.id;
  }

  /** Seeder: points a company at a fresh Stripe test customer for one eval run. */
  async setStripeCustomer(companyId: string, stripeCustomerId: string): Promise<void> {
    await this.request('PATCH', `/crm/v3/objects/companies/${companyId}`, {
      properties: { [COMPANY_PROPS.stripeCustomerId]: stripeCustomerId },
    });
  }
}
