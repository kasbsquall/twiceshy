import Anthropic from '@anthropic-ai/sdk';
import type { Apps } from '../ports.js';
import type { Proposal } from '../types.js';
import { executeReadTool, READ_TOOLS, SUBMIT_TOOL, submitSchema, toEvidence, type SubmitInput, type ThreadLocation } from './tools.js';

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.Messages.BetaMessage;

/** The one call the loop needs. Tests pass a scripted implementation. */
export interface ModelClient {
  create(params: Params): Promise<Message>;
}

export function anthropicClient(apiKey: string): ModelClient {
  const client = new Anthropic({ apiKey, maxRetries: 3 });
  return { create: (params) => client.beta.messages.create(params) };
}

export interface ResolveUsage {
  inputTokens: number;
  outputTokens: number;
  turns: number;
  toolCalls: Array<{ name: string; input: unknown; error?: string }>;
}

export interface ResolveResult {
  proposal: Proposal | null;
  /** Why no proposal came back, when proposal is null. */
  failure?: string;
  usage: ResolveUsage;
}

const MAX_TURNS = 14;
const MAX_INVALID_SUBMITS = 2;

const SYSTEM = `You help a customer success team at a B2B SaaS company settle SLA credits after incidents.
You read one shared Slack thread between the team and a customer, then find which HubSpot company it is about, which Linear incident it refers to, and which credit promise is currently in force.

Rules:
- Use the tools. Every id you submit must come from a tool result in this conversation.
- Company names are often partial or informal ("Acme", "the Acme folks"). Search broadly and compare every match against the incident's affected company ids and the dates in the thread before choosing.
- Relative dates ("Tuesday", "yesterday") are relative to the ts of the message that says them. Slack ts is Unix seconds, UTC.
- Amounts can be written in words. Convert them to dollars.
- A promise is whatever amount the latest message in the thread states, whoever wrote it. Do not judge whether the author was allowed to promise it; another system checks that.
- You do not decide whether a credit should be paid, and you never pay anything. Only report what the evidence shows.
- If more than one company or incident still fits after checking, submit kind "ambiguous" with the candidates and one short question. Guessing is worse than asking.
- Finish by calling submit_proposal exactly once.`;

function toProposal(input: SubmitInput): Proposal {
  if (input.kind === 'ambiguous') {
    return {
      kind: 'ambiguous',
      candidates: input.candidates.map((c) => ({ companyId: c.company_id, ...(c.incident_id ? { incidentId: c.incident_id } : {}), why: c.why })),
      question: input.question ?? 'Which account and incident does this thread refer to?',
    };
  }
  if (!input.company_id || !input.stripe_customer_id || !input.incident_id) {
    throw new Error('kind "resolved" needs company_id, stripe_customer_id and incident_id');
  }
  return {
    kind: 'resolved',
    companyId: input.company_id,
    stripeCustomerId: input.stripe_customer_id,
    incidentId: input.incident_id,
    promise: input.promise
      ? {
          amountMinor: Math.round(input.promise.amount_usd * 100),
          currency: 'usd',
          authorUserId: input.promise.author_user_id,
          messageTs: input.promise.message_ts,
          quote: input.promise.quote,
        }
      : null,
    reasoning: input.reasoning,
    evidence: toEvidence(input.evidence),
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Claude tool loop. Claude reads the four apps and submits a proposal; nothing here writes to
 * any app. The proposal is untrusted until verifyProposal checks it.
 */
export async function resolveThread(client: ModelClient, model: string, apps: Apps, thread: ThreadLocation): Promise<ResolveResult> {
  const usage: ResolveUsage = { inputTokens: 0, outputTokens: 0, turns: 0, toolCalls: [] };
  const messages: Anthropic.Beta.Messages.BetaMessageParam[] = [
    { role: 'user', content: 'Resolve the Slack thread under review and submit your proposal.' },
  ];
  let invalidSubmits = 0;

  while (usage.turns < MAX_TURNS) {
    usage.turns += 1;
    const response = await client.create({
      model,
      max_tokens: 16000,
      system: SYSTEM,
      tools: [...READ_TOOLS, SUBMIT_TOOL],
      // Haiku 4.5 predates adaptive thinking; newer models get it.
      ...(model.startsWith('claude-haiku-4-5') ? {} : { thinking: { type: 'adaptive' as const } }),
      messages,
      ...(model === 'claude-opus-5' ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    usage.inputTokens += response.usage.input_tokens;
    usage.outputTokens += response.usage.output_tokens;
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      return { proposal: null, failure: `Model stopped with ${response.stop_reason} before submitting`, usage };
    }

    const results: Anthropic.Beta.Messages.BetaToolResultBlockParam[] = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name === SUBMIT_TOOL.name) {
        const parsed = submitSchema.safeParse(block.input);
        try {
          if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
          const proposal = toProposal(parsed.data);
          usage.toolCalls.push({ name: block.name, input: block.input });
          return { proposal, usage };
        } catch (error) {
          invalidSubmits += 1;
          usage.toolCalls.push({ name: block.name, input: block.input, error: errorText(error) });
          if (invalidSubmits > MAX_INVALID_SUBMITS) return { proposal: null, failure: `Invalid submission: ${errorText(error)}`, usage };
          results.push({ type: 'tool_result', tool_use_id: block.id, content: `Invalid submission: ${errorText(error)}`, is_error: true });
        }
        continue;
      }
      try {
        const content = await executeReadTool(apps, thread, block.name, block.input);
        usage.toolCalls.push({ name: block.name, input: block.input });
        results.push({ type: 'tool_result', tool_use_id: block.id, content });
      } catch (error) {
        usage.toolCalls.push({ name: block.name, input: block.input, error: errorText(error) });
        results.push({ type: 'tool_result', tool_use_id: block.id, content: `Tool failed: ${errorText(error)}`, is_error: true });
      }
    }
    messages.push({ role: 'user', content: results });
  }
  return { proposal: null, failure: `No submission after ${MAX_TURNS} turns`, usage };
}
