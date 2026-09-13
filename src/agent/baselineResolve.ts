import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Apps } from '../ports.js';
import type { ResolvedProposal } from '../types.js';
import type { ModelClient } from './resolve.js';
import type { ThreadLocation } from './tools.js';

/**
 * Resolution baseline, the approach most teams ship first: one extraction prompt over the thread
 * text, no tool use, then plain code that matches the extracted name to the first HubSpot hit and
 * takes the latest incident for that company. No verification step.
 */
const EXTRACT_TOOL: Anthropic.Tool = {
  name: 'extract_credit_request',
  description: 'Record what the thread says.',
  input_schema: {
    type: 'object',
    properties: {
      company_name: { type: 'string' },
      amount_usd: { type: ['number', 'null'] },
      author_user_id: { type: ['string', 'null'] },
      message_ts: { type: ['string', 'null'] },
      quote: { type: ['string', 'null'] },
    },
    required: ['company_name', 'amount_usd', 'author_user_id', 'message_ts', 'quote'],
    additionalProperties: false,
  },
  strict: true,
};

const extractSchema = z.object({
  company_name: z.string(),
  amount_usd: z.number().nullable(),
  author_user_id: z.string().nullable(),
  message_ts: z.string().nullable(),
  quote: z.string().nullable(),
});

export interface BaselineResult {
  proposal: ResolvedProposal | null;
  failure?: string;
  usage: { inputTokens: number; outputTokens: number };
}

export async function baselineResolve(client: ModelClient, model: string, apps: Apps, thread: ThreadLocation): Promise<BaselineResult> {
  const messages = await apps.chat.getThread(thread.channelId, thread.threadTs);
  const transcript = messages.map((m) => `[ts ${m.ts}] <${m.userId}${m.authorName ? ` ${m.authorName}` : ''}> ${m.text}`).join('\n');
  const response = await client.create({
    model,
    max_tokens: 2000,
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: EXTRACT_TOOL.name },
    messages: [
      {
        role: 'user',
        content: `From this Slack thread, extract the customer company name and the SLA credit promised (amount in dollars, who promised it, the message ts and the exact words).\n\n${transcript}`,
      },
    ],
  });
  const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  const call = response.content.find((b) => b.type === 'tool_use');
  const parsed = extractSchema.safeParse(call?.type === 'tool_use' ? call.input : null);
  if (!parsed.success) return { proposal: null, failure: 'Extraction did not return the expected fields', usage };
  const extracted = parsed.data;

  const [company] = await apps.crm.searchCompanies(extracted.company_name);
  if (!company) return { proposal: null, failure: `No HubSpot company matches "${extracted.company_name}"`, usage };
  const incident = (await apps.tracker.listIncidents())
    .filter((i) => i.affectedCompanyIds.includes(company.id))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (!incident) return { proposal: null, failure: `No incident lists ${company.name}`, usage };

  return {
    proposal: {
      kind: 'resolved',
      companyId: company.id,
      stripeCustomerId: company.stripeCustomerId,
      incidentId: incident.id,
      promise:
        extracted.amount_usd !== null && extracted.author_user_id && extracted.message_ts
          ? {
              amountMinor: Math.round(extracted.amount_usd * 100),
              currency: 'usd',
              authorUserId: extracted.author_user_id,
              messageTs: extracted.message_ts,
              quote: extracted.quote ?? '',
            }
          : null,
      reasoning: `Name match on "${extracted.company_name}", latest incident for that company`,
      evidence: [],
    },
    usage,
  };
}
