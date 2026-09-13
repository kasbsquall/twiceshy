import { WebClient } from '@slack/web-api';
import type { ChatPort, PostOptions } from '../../ports.js';
import type { SlackMessage } from '../../types.js';

const EVENT_TYPE = 'twiceshy_step';

interface RawMessage {
  ts?: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> };
}

/**
 * Slack through the bot token. Every message this system posts carries the run id and step in
 * Slack message metadata, so a restarted run can find it by reading the thread.
 */
export class SlackChat implements ChatPort {
  private readonly client: WebClient;

  constructor(botToken: string) {
    this.client = new WebClient(botToken, { retryConfig: { retries: 3 } });
  }

  private async replies(channelId: string, threadTs: string): Promise<RawMessage[]> {
    const messages: RawMessage[] = [];
    let cursor: string | undefined;
    do {
      const page = await this.client.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: 200,
        include_all_metadata: true,
        ...(cursor ? { cursor } : {}),
      });
      messages.push(...((page.messages ?? []) as RawMessage[]));
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return messages;
  }

  async getThread(channelId: string, threadTs: string): Promise<SlackMessage[]> {
    const raw = await this.replies(channelId, threadTs);
    return raw
      .filter((m) => m.ts && m.metadata?.event_type !== EVENT_TYPE)
      .map((m) => ({
        ts: m.ts!,
        threadTs: m.thread_ts ?? m.ts!,
        userId: m.user ?? `bot:${m.bot_id ?? 'unknown'}`,
        ...(m.username ? { authorName: m.username } : {}),
        text: m.text ?? '',
      }));
  }

  async postMessage(channelId: string, text: string, options: PostOptions = {}): Promise<{ ts: string }> {
    const result = await this.client.chat.postMessage({
      channel: channelId,
      text,
      ...(options.threadTs ? { thread_ts: options.threadTs } : {}),
      ...(options.blocks ? { blocks: options.blocks as never } : {}),
      ...(options.username ? { username: options.username } : {}),
      ...(options.runId
        ? { metadata: { event_type: EVENT_TYPE, event_payload: { run_id: options.runId, step: options.step ?? '' } } }
        : {}),
      unfurl_links: false,
    });
    if (!result.ts) throw new Error('Slack did not return a message ts');
    return { ts: result.ts };
  }

  async updateMessage(channelId: string, ts: string, text: string, blocks?: unknown[]): Promise<void> {
    await this.client.chat.update({ channel: channelId, ts, text, ...(blocks ? { blocks: blocks as never } : {}) });
  }

  async findPostedMessage(channelId: string, threadTs: string, runId: string, step: string): Promise<string | null> {
    const raw = await this.replies(channelId, threadTs);
    const found = raw.find(
      (m) => m.metadata?.event_type === EVENT_TYPE && m.metadata.event_payload?.run_id === runId && m.metadata.event_payload?.step === step,
    );
    return found?.ts ?? null;
  }
}
