import type { LiveConfig } from '../../config.js';
import type { Apps } from '../../ports.js';
import { HubSpotCrm } from './hubspot.js';
import { LinearTracker } from './linear.js';
import { SlackChat } from './slack.js';
import { StripeBilling } from './stripe.js';

export interface LiveApps extends Apps {
  chat: SlackChat;
  crm: HubSpotCrm;
  tracker: LinearTracker;
  billing: StripeBilling;
}

export function createLiveApps(config: LiveConfig): LiveApps {
  return {
    chat: new SlackChat(config.slackBotToken),
    crm: new HubSpotCrm(config.hubspotAccessToken),
    tracker: new LinearTracker(config.linearApiKey, config.linearTeamKey),
    billing: new StripeBilling(config.stripeSecretKey),
  };
}
