import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import {
  Check,
  Copy,
  Hash,
  MessageSquare,
  Send,
  UserPlus,
} from 'lucide-react';

interface SlackThreadEvent {
  id: string;
  channel: string;
  user: string;
  eventType: 'app_mention' | 'member_joined_channel';
  userText: string;
  botReply: string;
  sources: string[];
  confidence: number;
  latencyMs: number;
  timestamp: string;
}

interface SlackSimulatorPanelProps {
  onTriggerSlackEvent: (payload: {
    type: 'app_mention' | 'member_joined_channel';
    channel: string;
    user: string;
    text?: string;
  }) => Promise<{
    reply: string;
    sources: string[];
    confidence: number;
    latencyMs: number;
  }>;
}

const SLACK_MANIFEST_YAML = `display_information:
  name: Hippocampus
  description: AI Onboarding Mentor & Engineering Knowledge Agent
features:
  bot_user:
    display_name: Hippocampus
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
      - users:read
settings:
  event_subscriptions:
    request_url: https://your-domain.run.app/api/slack/events
    bot_events:
      - app_mention
      - member_joined_channel`;

export function SlackSimulatorPanel({
  onTriggerSlackEvent,
}: SlackSimulatorPanelProps) {
  const [selectedChannel, setSelectedChannel] = useState('#eng-onboarding');
  const [userHandle, setUserHandle] = useState('@dev.newhire');
  const [mentionText, setMentionText] = useState(
    '@Hippocampus How do I set up local dev environment on Mac?'
  );
  const [sending, setSending] = useState(false);
  const [copiedManifest, setCopiedManifest] = useState(false);

  const [events, setEvents] = useState<SlackThreadEvent[]>([
    {
      id: 'seed-slack-1',
      channel: '#eng-onboarding',
      user: '@alex.chen',
      eventType: 'app_mention',
      userText: '@Hippocampus How do I configure SSO for my team?',
      botReply:
        'Navigate to **Workspace Settings > Security & Identity > SSO Provider**, copy the ACS URL (`https://auth.hippocampus.internal/saml/callback`) and Entity ID into Okta or Google Workspace SAML, map `email`, `firstName`, `lastName`, and `groups`, then upload your X.509 certificate [Source: Engineering Onboarding & SSO Setup Guide].',
      sources: ['Engineering Onboarding & SSO Setup Guide'],
      confidence: 96,
      latencyMs: 840,
      timestamp: '10:14 AM',
    },
  ]);

  const handleSendMention = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mentionText.trim() || sending) return;

    setSending(true);
    try {
      const formattedText = mentionText.includes('@Hippocampus')
        ? mentionText.trim()
        : `@Hippocampus ${mentionText.trim()}`;

      const result = await onTriggerSlackEvent({
        type: 'app_mention',
        channel: selectedChannel,
        user: userHandle,
        text: formattedText,
      });

      setEvents((prev) => [
        {
          id: `slack-${Date.now()}`,
          channel: selectedChannel,
          user: userHandle,
          eventType: 'app_mention',
          userText: formattedText,
          botReply: result.reply,
          sources: result.sources,
          confidence: result.confidence,
          latencyMs: result.latencyMs,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
        },
        ...prev,
      ]);
      setMentionText('');
    } finally {
      setSending(false);
    }
  };

  const handleSimulateMemberJoined = async () => {
    if (sending) return;
    setSending(true);
    try {
      const result = await onTriggerSlackEvent({
        type: 'member_joined_channel',
        channel: selectedChannel,
        user: userHandle,
      });

      setEvents((prev) => [
        {
          id: `slack-join-${Date.now()}`,
          channel: selectedChannel,
          user: userHandle,
          eventType: 'member_joined_channel',
          userText: `${userHandle} joined ${selectedChannel}`,
          botReply: result.reply,
          sources: result.sources,
          confidence: result.confidence,
          latencyMs: result.latencyMs,
          timestamp: new Date().toLocaleTimeString([], {
            hour: '2-digit',
            minute: '2-digit',
          }),
        },
        ...prev,
      ]);
    } finally {
      setSending(false);
    }
  };

  const copyManifest = async () => {
    await navigator.clipboard.writeText(SLACK_MANIFEST_YAML);
    setCopiedManifest(true);
    setTimeout(() => setCopiedManifest(false), 2000);
  };

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
      {/* Left: Live Slack Events API Simulator */}
      <div className="lg:col-span-7 space-y-6">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="font-display text-base font-semibold text-white">
                Slack Events API Live Simulator
              </h2>
              <p className="text-xs text-slate-400">
                Dispatches real <code>app_mention</code> and <code>member_joined_channel</code> payloads to <code>POST /api/slack/events</code>
              </p>
            </div>

            <button
              type="button"
              disabled={sending}
              onClick={handleSimulateMemberJoined}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-medium text-emerald-400 transition-colors hover:border-emerald-500/50 hover:text-emerald-300 disabled:opacity-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <UserPlus className="h-3.5 w-3.5" />
              Simulate New Hire Joining Channel
            </button>
          </div>

          <form onSubmit={handleSendMention} className="space-y-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Target Slack Channel
                </label>
                <select
                  value={selectedChannel}
                  onChange={(e) => setSelectedChannel(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
                >
                  <option value="#eng-onboarding">#eng-onboarding</option>
                  <option value="#platform-ops">#platform-ops</option>
                  <option value="#eng-releases">#eng-releases</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1">
                  Engineer Slack Handle
                </label>
                <input
                  type="text"
                  value={userHandle}
                  onChange={(e) => setUserHandle(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-white focus:border-emerald-500 focus:outline-none"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Channel Message (@Hippocampus Mention)
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={mentionText}
                  onChange={(e) => setMentionText(e.target.value)}
                  placeholder="@Hippocampus Where can I find the billing documentation?"
                  className="flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3.5 py-2 text-xs text-white placeholder:text-slate-500 focus:border-emerald-500 focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={sending || !mentionText.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Send className="h-3.5 w-3.5" />
                  {sending ? 'Dispatching...' : 'Send Event'}
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* Thread Feed */}
        <div className="space-y-3">
          <h3 className="font-display text-sm font-semibold text-white">
            Recent Slack Thread Dispatches ({events.length})
          </h3>
          {events.map((ev) => (
            <div
              key={ev.id}
              className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 space-y-3"
            >
              <div className="flex items-center justify-between text-xs text-slate-400">
                <div className="flex items-center gap-2">
                  <Hash className="h-3.5 w-3.5 text-emerald-400" />
                  <span className="font-medium text-white">
                    {ev.channel.replace('#', '')}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>Event: {ev.eventType}</span>
                </div>
                <span className="font-mono tabular-nums">
                  {ev.latencyMs}ms · {ev.timestamp}
                </span>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs">
                <p className="font-semibold text-slate-300">{ev.user}</p>
                <p className="mt-1 text-slate-200">{ev.userText}</p>
              </div>

              <div className="rounded-lg border border-slate-800 bg-slate-950/90 p-4 space-y-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-emerald-400">
                    Hippocampus Bot (Thread Reply)
                  </span>
                  <span className="font-mono text-[11px] text-slate-400 tabular-nums">
                    Confidence: {ev.confidence}%
                  </span>
                </div>
                <div className="prose prose-invert prose-xs max-w-none text-slate-200">
                  <ReactMarkdown>{ev.botReply}</ReactMarkdown>
                </div>
                {ev.sources.length > 0 && (
                  <p className="pt-1 text-[11px] text-slate-400">
                    Cited Sources: {ev.sources.join(' · ')}
                  </p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right: Slack App Manifest & Webhook Configuration */}
      <div className="lg:col-span-5 space-y-6">
        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold text-white">
              Slack App Manifest (YAML)
            </h3>
            <button
              type="button"
              onClick={copyManifest}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copiedManifest ? (
                <>
                  <Check className="h-3.5 w-3.5 text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3.5 w-3.5" />
                  Copy Manifest
                </>
              )}
            </button>
          </div>
          <p className="text-xs leading-relaxed text-slate-400">
            Paste this manifest when creating your Slack App at{' '}
            <code>api.slack.com/apps</code> to configure scopes and point Event
            Subscriptions to <code>/api/slack/events</code>.
          </p>
          <pre className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950 p-4 font-mono text-[11px] leading-relaxed text-slate-300">
            {SLACK_MANIFEST_YAML}
          </pre>
        </div>

        <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-6 space-y-3">
          <div className="flex items-center gap-2">
            <MessageSquare className="h-4 w-4 text-emerald-400" />
            <h3 className="font-display text-sm font-semibold text-white">
              HMAC-SHA256 Security Verification
            </h3>
          </div>
          <p className="text-xs leading-relaxed text-slate-400">
            Every production webhook call from Slack is verified against{' '}
            <code>x-slack-signature</code> and{' '}
            <code>x-slack-request-timestamp</code> using timing-safe HMAC-SHA256
            comparison and a 5-minute replay guard.
          </p>
        </div>
      </div>
    </div>
  );
}
