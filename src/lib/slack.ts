import { createHmac, timingSafeEqual } from 'crypto';

const FIVE_MINUTES_SEC = 5 * 60;

export interface SlackMentionEvent {
  type: 'app_mention' | 'message' | 'member_joined_channel';
  user: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  channel: string;
  event_ts?: string;
  bot_id?: string;
}

export interface SlackEventPayload {
  token?: string;
  team_id?: string;
  api_app_id?: string;
  event: SlackMentionEvent;
  type: 'event_callback' | 'url_verification';
  challenge?: string;
  event_id?: string;
  event_time?: number;
}

export function verifySlackRequest(
  signature: string | null | undefined,
  timestamp: string | null | undefined,
  rawBody: string,
  signingSecret?: string
): boolean {
  const secret = signingSecret || process.env.SLACK_SIGNING_SECRET;
  if (!secret) {
    // Allow internal simulator requests when signing secret is not set in environment
    return false;
  }
  if (!signature || !timestamp) return false;

  const now = Math.floor(Date.now() / 1000);
  const requestTime = parseInt(timestamp, 10);
  if (isNaN(requestTime) || Math.abs(now - requestTime) > FIVE_MINUTES_SEC) {
    return false;
  }

  const baseString = `v0:${timestamp}:${rawBody}`;
  const computed = createHmac('sha256', secret).update(baseString).digest('hex');
  const expected = `v0=${computed}`;

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);

  if (sigBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
}

export function buildWelcomeMessage(channelName = '#eng-onboarding'): string {
  return (
    `Welcome to ${channelName}! I'm *Hippocampus*, your engineering onboarding mentor.\n\n` +
    `Here is what I can help you with right away:\n` +
    `• *Runbooks & Architecture* — Ask about SSO, local Mac dev setup, staging deployments, or pgvector schemas\n` +
    `• *API & Webhooks* — Query rate limits, HMAC verification, or key rotation policies\n` +
    `• *Thread Mentions* — Tag \`@Hippocampus\` anywhere in Slack for source-cited answers in under 2 seconds`
  );
}
