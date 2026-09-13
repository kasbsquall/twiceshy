import 'dotenv/config';
import { z } from 'zod';
import type { Role } from './types.js';

const roleSchema = z.enum(['csm', 'cs_manager']);

const liveSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL: z.string().min(1).default('claude-sonnet-5'),
  STRIPE_SECRET_KEY: z
    .string()
    .startsWith('sk_test_', 'Only Stripe test mode keys are allowed'),
  SLACK_BOT_TOKEN: z.string().startsWith('xoxb-'),
  SLACK_APP_TOKEN: z.string().startsWith('xapp-'),
  SLACK_DEMO_CHANNEL_ID: z.string().min(1),
  SLACK_EVAL_CHANNEL_ID: z.string().min(1),
  INTERNAL_SLACK_USERS: z.string().min(1),
  APPROVER_SLACK_USER_IDS: z.string().min(1),
  HUBSPOT_ACCESS_TOKEN: z.string().min(1),
  LINEAR_API_KEY: z.string().min(1),
  LINEAR_TEAM_KEY: z.string().min(1).default('INC'),
});

export interface LiveConfig {
  anthropicApiKey: string;
  anthropicModel: string;
  stripeSecretKey: string;
  slackBotToken: string;
  slackAppToken: string;
  slackDemoChannelId: string;
  slackEvalChannelId: string;
  internalUsers: ReadonlyMap<string, Role>;
  approverUserIds: ReadonlySet<string>;
  hubspotAccessToken: string;
  linearApiKey: string;
  linearTeamKey: string;
}

export function parseInternalUsers(raw: string): Map<string, Role> {
  const users = new Map<string, Role>();
  for (const pair of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const [userId, role] = pair.split(':');
    if (!userId || !role) throw new Error(`INTERNAL_SLACK_USERS entry "${pair}" must look like U123:csm`);
    users.set(userId, roleSchema.parse(role));
  }
  return users;
}

/** Loads and validates live credentials. Offline mode never calls this. */
export function loadLiveConfig(env: NodeJS.ProcessEnv = process.env): LiveConfig {
  const parsed = liveSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Missing or invalid configuration in .env:\n  ${problems}`);
  }
  const e = parsed.data;
  return {
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    anthropicModel: e.ANTHROPIC_MODEL,
    stripeSecretKey: e.STRIPE_SECRET_KEY,
    slackBotToken: e.SLACK_BOT_TOKEN,
    slackAppToken: e.SLACK_APP_TOKEN,
    slackDemoChannelId: e.SLACK_DEMO_CHANNEL_ID,
    slackEvalChannelId: e.SLACK_EVAL_CHANNEL_ID,
    internalUsers: parseInternalUsers(e.INTERNAL_SLACK_USERS),
    approverUserIds: new Set(e.APPROVER_SLACK_USER_IDS.split(',').map((s) => s.trim()).filter(Boolean)),
    hubspotAccessToken: e.HUBSPOT_ACCESS_TOKEN,
    linearApiKey: e.LINEAR_API_KEY,
    linearTeamKey: e.LINEAR_TEAM_KEY,
  };
}
