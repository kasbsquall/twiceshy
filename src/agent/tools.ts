import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Apps } from '../ports.js';
import type { AppName, EvidenceRef } from '../types.js';

/** Where the thread under review lives. The agent can only read this one thread. */
export interface ThreadLocation {
  channelId: string;
  threadTs: string;
}

const noInput = (): Anthropic.Tool.InputSchema => ({ type: 'object', properties: {}, required: [], additionalProperties: false });

export const READ_TOOLS: Anthropic.Tool[] = [
  {
    name: 'get_slack_thread',
    description:
      'Returns every message in the shared Slack thread under review, oldest first, with ts, user_id and text. Call this first.',
    input_schema: noInput(),
    strict: true,
  },
  {
    name: 'search_hubspot_companies',
    description:
      'Searches HubSpot companies whose name contains the query (case-insensitive). Returns id, name, SLA tier, renewal date and the linked Stripe customer id. Several companies can share a word in their name, so compare all results.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Part of a company name, for example "acme".' } },
      required: ['query'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'get_hubspot_company',
    description: 'Returns one HubSpot company by id.',
    input_schema: {
      type: 'object',
      properties: { company_id: { type: 'string' } },
      required: ['company_id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'list_linear_incidents',
    description:
      'Lists Linear incidents with identifier, title, severity, start and resolve times (UTC) and the HubSpot company ids affected.',
    input_schema: noInput(),
    strict: true,
  },
  {
    name: 'get_linear_incident',
    description: 'Returns one Linear incident by id.',
    input_schema: {
      type: 'object',
      properties: { incident_id: { type: 'string' } },
      required: ['incident_id'],
      additionalProperties: false,
    },
    strict: true,
  },
  {
    name: 'list_stripe_credits',
    description:
      'Lists credits already given to a Stripe customer: balance credits, credit notes and refunds, with amount in cents, creation time and metadata.',
    input_schema: {
      type: 'object',
      properties: { customer_id: { type: 'string', description: 'Stripe customer id, starts with cus_.' } },
      required: ['customer_id'],
      additionalProperties: false,
    },
    strict: true,
  },
];

export const SUBMIT_TOOL: Anthropic.Tool = {
  name: 'submit_proposal',
  description:
    'Submit your conclusion exactly once. Use kind "resolved" only when a single company and a single incident fit the evidence; otherwise use kind "ambiguous" with the candidates and one question for the CSM. Every id must come from a tool result. Quotes must be copied verbatim from the Slack thread.',
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['resolved', 'ambiguous'] },
      company_id: { type: ['string', 'null'], description: 'HubSpot company id, null when ambiguous.' },
      stripe_customer_id: { type: ['string', 'null'], description: 'Stripe customer id of that company, null when ambiguous.' },
      incident_id: { type: ['string', 'null'], description: 'Linear incident identifier as shown in tool results, for example AVA-6. Null when ambiguous.' },
      promise: {
        anyOf: [
          { type: 'null' },
          {
            type: 'object',
            description:
              'The credit promise currently in force in the thread. If a later message changes an earlier promise, use the later one.',
            properties: {
              amount_usd: { type: 'number', description: 'Dollars, for example 1000 for "a thousand bucks".' },
              author_user_id: { type: 'string', description: 'Slack user id of the message that made the promise.' },
              message_ts: { type: 'string', description: 'ts of that message.' },
              quote: { type: 'string', description: 'Verbatim words from that message stating the amount.' },
            },
            required: ['amount_usd', 'author_user_id', 'message_ts', 'quote'],
            additionalProperties: false,
          },
        ],
      },
      reasoning: {
        type: 'string',
        description: 'One sentence a CSM can read: which company and incident you picked and the evidence that ruled out the others.',
      },
      evidence: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            app: { type: 'string', enum: ['slack', 'hubspot', 'linear', 'stripe'] },
            id: { type: 'string' },
            quote: { type: ['string', 'null'] },
          },
          required: ['app', 'id', 'quote'],
          additionalProperties: false,
        },
      },
      candidates: {
        type: 'array',
        description: 'Only for kind "ambiguous": the companies (and incidents) that fit.',
        items: {
          type: 'object',
          properties: {
            company_id: { type: 'string' },
            incident_id: { type: ['string', 'null'] },
            why: { type: 'string' },
          },
          required: ['company_id', 'incident_id', 'why'],
          additionalProperties: false,
        },
      },
      question: { type: ['string', 'null'], description: 'Only for kind "ambiguous": one question for the CSM.' },
    },
    required: [
      'kind',
      'company_id',
      'stripe_customer_id',
      'incident_id',
      'promise',
      'reasoning',
      'evidence',
      'candidates',
      'question',
    ],
    additionalProperties: false,
  },
  strict: true,
};

export const submitSchema = z.object({
  kind: z.enum(['resolved', 'ambiguous']),
  company_id: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
  incident_id: z.string().nullable(),
  promise: z
    .object({
      amount_usd: z.number().nonnegative(),
      author_user_id: z.string(),
      message_ts: z.string(),
      quote: z.string(),
    })
    .nullable(),
  reasoning: z.string(),
  evidence: z.array(z.object({ app: z.enum(['slack', 'hubspot', 'linear', 'stripe']), id: z.string(), quote: z.string().nullable() })),
  candidates: z.array(z.object({ company_id: z.string(), incident_id: z.string().nullable(), why: z.string() })),
  question: z.string().nullable(),
});

export type SubmitInput = z.infer<typeof submitSchema>;

const idInput = (key: string) => z.object({ [key]: z.string().min(1) });

/** Runs a read tool against the apps. Returns JSON text for the model. Throws on app errors. */
export async function executeReadTool(apps: Apps, thread: ThreadLocation, name: string, input: unknown): Promise<string> {
  switch (name) {
    case 'get_slack_thread': {
      const messages = await apps.chat.getThread(thread.channelId, thread.threadTs);
      return JSON.stringify(messages.map((m) => ({ ts: m.ts, user_id: m.userId, author_name: m.authorName ?? null, text: m.text })));
    }
    case 'search_hubspot_companies': {
      const { query } = idInput('query').parse(input) as { query: string };
      return JSON.stringify(await apps.crm.searchCompanies(query));
    }
    case 'get_hubspot_company': {
      const { company_id } = idInput('company_id').parse(input) as { company_id: string };
      return JSON.stringify(await apps.crm.getCompany(company_id));
    }
    case 'list_linear_incidents':
      return JSON.stringify(await apps.tracker.listIncidents());
    case 'get_linear_incident': {
      const { incident_id } = idInput('incident_id').parse(input) as { incident_id: string };
      return JSON.stringify(await apps.tracker.getIncident(incident_id));
    }
    case 'list_stripe_credits': {
      const { customer_id } = idInput('customer_id').parse(input) as { customer_id: string };
      return JSON.stringify(await apps.billing.listCredits(customer_id));
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

export function toEvidence(items: SubmitInput['evidence']): EvidenceRef[] {
  return items.map((e) => ({ app: e.app as AppName, id: e.id, ...(e.quote ? { quote: e.quote } : {}) }));
}
