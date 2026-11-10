import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import * as dotenv from 'dotenv';
import { adminAuth } from './src/lib/firebase-admin.ts';
import { requireAuth, AuthRequest } from './src/middleware/auth.ts';
import {
  deleteDocumentById,
  getAgentSettingsList,
  getDocumentsList,
  getOrCreateUser,
  getOverviewPayload,
  getRecentQueryLogs,
  ingestDocument,
  recordQueryLog,
  searchKnowledgeChunks,
  updateAgentSettingByKey,
} from './src/db/queries.ts';
import { synthesizeRagAnswer } from './src/lib/ai.ts';
import {
  buildWelcomeMessage,
  SlackEventPayload,
  verifySlackRequest,
} from './src/lib/slack.ts';

dotenv.config();

const app = express();
const PORT = 3000;

// Capture raw body for Slack HMAC-SHA256 signature verification
app.use(
  express.json({
    limit: '5mb',
    verify: (req: Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

// Optional auth middleware that attaches decoded Firebase user if Bearer token is present
const attachOptionalUser = async (
  req: AuthRequest,
  _res: Response,
  next: NextFunction
) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split('Bearer ')[1];
    try {
      const decoded = await adminAuth.verifyIdToken(token);
      req.user = decoded;
      await getOrCreateUser(
        decoded.uid,
        decoded.email || 'engineer@hippocampus.ai',
        decoded.name
      );
    } catch (err) {
      console.warn('Optional token verification skipped:', err);
    }
  }
  next();
};

// Strict authenticated profile sync endpoint
app.post('/api/auth/sync', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const dbUser = await getOrCreateUser(
      req.user.uid,
      req.user.email || 'engineer@hippocampus.ai',
      req.user.name
    );
    res.json({ user: dbUser });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to sync user';
    res.status(500).json({ error: message });
  }
});

// Dashboard overview endpoint
app.get('/api/overview', attachOptionalUser, async (_req: AuthRequest, res: Response) => {
  try {
    const data = await getOverviewPayload();
    res.json(data);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to load overview';
    res.status(500).json({ error: message });
  }
});

// Documents list endpoint
app.get('/api/documents', attachOptionalUser, async (_req: AuthRequest, res: Response) => {
  try {
    const docs = await getDocumentsList();
    res.json({ documents: docs });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch documents';
    res.status(500).json({ error: message });
  }
});

// Document ingestion endpoint (chunks + vector embeddings)
app.post('/api/documents', attachOptionalUser, async (req: AuthRequest, res: Response) => {
  try {
    const { title, sourceType, sourceUrl, content } = req.body as {
      title?: string;
      sourceType?: 'file' | 'url' | 'slack';
      sourceUrl?: string;
      content?: string;
    };

    if (!title?.trim() || !content?.trim()) {
      return res.status(400).json({
        error: 'Both document title and content are required for ingestion.',
      });
    }

    const validSourceType =
      sourceType === 'url' || sourceType === 'slack' ? sourceType : 'file';

    const created = await ingestDocument({
      title: title.trim(),
      sourceType: validSourceType,
      sourceUrl: sourceUrl?.trim() || null,
      content: content.trim(),
      userId: req.user?.uid ?? null,
    });

    res.status(201).json({ document: created });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to ingest document';
    res.status(500).json({ error: message });
  }
});

// Delete document endpoint
app.delete('/api/documents/:id', attachOptionalUser, async (req: AuthRequest, res: Response) => {
  try {
    const docId = Number(req.params.id);
    if (isNaN(docId)) {
      return res.status(400).json({ error: 'Invalid document ID' });
    }
    const result = await deleteDocumentById(docId);
    res.json(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to delete document';
    res.status(500).json({ error: message });
  }
});

// RAG Chat & Playground endpoint
app.post('/api/chat', attachOptionalUser, async (req: AuthRequest, res: Response) => {
  const startTime = Date.now();
  try {
    const { message, query, channel } = req.body as {
      message?: string;
      query?: string;
      channel?: string;
    };
    const promptText = (query || message || '').trim();
    if (!promptText) {
      return res.status(400).json({ error: 'Query cannot be empty.' });
    }

    const chunks = await searchKnowledgeChunks(promptText, 4);
    const ragResult = await synthesizeRagAnswer(promptText, chunks);
    const latencyMs = Math.max(120, Date.now() - startTime);

    const userHandle = req.user?.email
      ? `@${req.user.email.split('@')[0]}`
      : '@alex.chen';

    await recordQueryLog({
      userHandle,
      channel: channel || 'Playground',
      query: promptText,
      answer: ragResult.answer,
      sources: ragResult.sources,
      confidence: ragResult.confidence,
      latencyMs,
      resolved: ragResult.sources.length > 0,
    });

    res.json({
      answer: ragResult.answer,
      sources: ragResult.sources,
      confidence: ragResult.confidence,
      latencyMs,
      chunks: chunks.map((c) => ({
        documentTitle: c.documentTitle,
        sourceType: c.sourceType,
        similarity: Number((c.similarity * 100).toFixed(1)),
        excerpt: c.content.slice(0, 220),
      })),
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'RAG pipeline failed';
    res.status(500).json({ error: message });
  }
});

// Query logs endpoint
app.get('/api/logs', attachOptionalUser, async (_req: AuthRequest, res: Response) => {
  try {
    const logs = await getRecentQueryLogs();
    res.json({ logs });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch query logs';
    res.status(500).json({ error: message });
  }
});

// Agent capability settings endpoints
app.get('/api/settings', attachOptionalUser, async (_req: AuthRequest, res: Response) => {
  try {
    const settings = await getAgentSettingsList();
    res.json({ settings });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to fetch settings';
    res.status(500).json({ error: message });
  }
});

app.patch('/api/settings/:key', attachOptionalUser, async (req: AuthRequest, res: Response) => {
  try {
    const { key } = req.params;
    const { enabled } = req.body as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'Boolean enabled state is required' });
    }
    const updated = await updateAgentSettingByKey(key, enabled);
    res.json({ setting: updated });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to update setting';
    res.status(500).json({ error: message });
  }
});

// Slack Events API Webhook & Interactive Simulator endpoint
app.post(
  '/api/slack/events',
  async (req: Request & { rawBody?: string }, res: Response) => {
    const startTime = Date.now();
    try {
      const payload = req.body as SlackEventPayload;

      // 1. Slack URL verification challenge
      if (payload?.type === 'url_verification') {
        return res.json({ challenge: payload.challenge });
      }

      // 2. Verify HMAC signature unless invoked from internal Slack simulator UI
      const isSimulator = req.headers['x-hippocampus-simulator'] === 'true';
      if (!isSimulator && process.env.SLACK_SIGNING_SECRET) {
        const signature = req.headers['x-slack-signature'] as string | undefined;
        const timestamp = req.headers['x-slack-request-timestamp'] as
          | string
          | undefined;
        const isValid = verifySlackRequest(
          signature,
          timestamp,
          req.rawBody || JSON.stringify(payload)
        );
        if (!isValid) {
          return res
            .status(401)
            .json({ error: 'Invalid Slack HMAC-SHA256 signature' });
        }
      }

      const event = payload?.event;
      if (!event) {
        return res.status(400).json({ error: 'Missing Slack event object' });
      }

      if (event.type === 'member_joined_channel') {
        const welcome = buildWelcomeMessage(event.channel || '#eng-onboarding');
        const latencyMs = Math.max(95, Date.now() - startTime);
        await recordQueryLog({
          userHandle: event.user || '@new.hire',
          channel: `Slack ${event.channel || '#eng-onboarding'}`,
          query: '[Event: member_joined_channel] Proactive onboarding greeting',
          answer: welcome,
          sources: ['Engineering Onboarding & SSO Setup Guide'],
          confidence: 99,
          latencyMs,
          resolved: true,
        });
        return res.json({
          ok: true,
          eventType: 'member_joined_channel',
          channel: event.channel || '#eng-onboarding',
          reply: welcome,
          sources: ['Engineering Onboarding & SSO Setup Guide'],
          confidence: 99,
          latencyMs,
        });
      }

      // Default: app_mention or channel question
      const cleanQuestion = (event.text || '')
        .replace(/<@[A-Z0-9]+>|@Hippocampus/gi, '')
        .trim();

      if (!cleanQuestion) {
        return res.json({
          ok: true,
          reply:
            "Hi! Mention me with a question like `@Hippocampus How do I configure SSO?` and I'll search our engineering docs.",
          sources: [],
          confidence: 100,
          latencyMs: 50,
        });
      }

      const chunks = await searchKnowledgeChunks(cleanQuestion, 4);
      const ragResult = await synthesizeRagAnswer(cleanQuestion, chunks);
      const latencyMs = Math.max(140, Date.now() - startTime);

      await recordQueryLog({
        userHandle: event.user || '@slack.engineer',
        channel: `Slack ${event.channel || '#eng-onboarding'}`,
        query: cleanQuestion,
        answer: ragResult.answer,
        sources: ragResult.sources,
        confidence: ragResult.confidence,
        latencyMs,
        resolved: ragResult.sources.length > 0,
      });

      return res.json({
        ok: true,
        eventType: 'app_mention',
        channel: event.channel || '#eng-onboarding',
        reply: ragResult.answer,
        sources: ragResult.sources,
        confidence: ragResult.confidence,
        latencyMs,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Slack event handler error';
      res.status(500).json({ error: message });
    }
  }
);

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Hippocampus server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
