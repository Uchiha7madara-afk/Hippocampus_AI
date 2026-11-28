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

const SLACK_TIMESTAMP_PATTERN = /^\d{10}$/;
const SLACK_SIGNATURE_PATTERN = /^v0=[a-f0-9]{64}$/i;

export function verifySlackRequest(
  signature: string | null | undefined,
  timestamp: string | null | undefined,
  rawBody: Buffer | string | undefined,
  signingSecret?: string
): boolean {
  const secret = (signingSecret || process.env.SLACK_SIGNING_SECRET)?.trim();
  if (!secret) {
    return false;
  }
  if (!signature || !timestamp || rawBody === undefined) return false;

  const trimmedTimestamp = timestamp.trim();
  const trimmedSignature = signature.trim();

  if (
    !SLACK_TIMESTAMP_PATTERN.test(trimmedTimestamp) ||
    !SLACK_SIGNATURE_PATTERN.test(trimmedSignature)
  ) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const requestTime = Number(trimmedTimestamp);
  if (
    !Number.isSafeInteger(requestTime) ||
    Math.abs(now - requestTime) > FIVE_MINUTES_SEC
  ) {
    return false;
  }

  const rawBuffer = Buffer.isBuffer(rawBody)
    ? rawBody
    : Buffer.from(rawBody, 'utf8');
  const prefixBuffer = Buffer.from(`v0:${trimmedTimestamp}:`, 'utf8');
  const computed = createHmac('sha256', secret)
    .update(Buffer.concat([prefixBuffer, rawBuffer]))
    .digest('hex');
  const expected = `v0=${computed}`;

  const sigBuf = Buffer.from(trimmedSignature.toLowerCase(), 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');

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
