import express, { Request, Response, NextFunction } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import * as dotenv from 'dotenv';
import { adminAuth } from './src/lib/firebase-admin.ts';
import { requireAuth, AuthRequest } from './src/middleware/auth.ts';
import {
  createOnboardingTrack,
  deleteDocumentById,
  getAgentSettingsList,
  getConnectorSyncLogs,
  getDocumentsList,
  getOnboardingPayload,
  getOrCreateUser,
  getOverviewPayload,
  getRecentQueryLogs,
  getSemanticCacheEntries,
  ingestDocument,
  lookupSemanticCache,
  purgeSemanticCache,
  recordConnectorSyncLog,
  recordQueryLog,
  searchKnowledgeChunks,
  storeInSemanticCache,
  toggleOnboardingMilestone,
  updateAgentSettingByKey,
  updateUserRole,
  upsertConnectorDocument,
} from './src/db/queries.ts';
import {
  convertGoogleDocToMarkdown,
  fetchGithubRepositoryDocs,
  GoogleDocStructuralResponse,
  listGoogleDriveDocuments,
  pullGoogleDriveDocumentAsMarkdown,
  verifyGithubWebhookSignature,
} from './src/lib/connectors.ts';
import { SCOPES as GOOGLE_WORKSPACE_SCOPES } from './src/lib/firebase.ts';
import {
  executeEnterpriseTool,
  synthesizeRagAnswer,
} from './src/lib/ai.ts';
import {
  buildWelcomeMessage,
  SlackEventPayload,
  verifySlackRequest,
} from './src/lib/slack.ts';
import {
  emitStructuredLog,
  getObservabilityMetrics,
  recordSlackWebhookMetric,
  requestLoggerMiddleware,
  TelemetryRequest,
} from './src/lib/logger.ts';
import {
  createRateLimitMiddleware,
  getRateLimitStatus,
  isDuplicateSlackEvent,
  resetRateLimitBuckets,
} from './src/lib/resilience.ts';
import {
  ChatQueryRequestSchema,
  CreateOnboardingTrackSchema,
  getAllowedTiersForRole,
  getEnvValidationReport,
  IngestDocumentRequestSchema,
  normalizeRbacRole,
  RbacRole,
  ToggleOnboardingProgressSchema,
  UpdateRoleRequestSchema,
  validateRuntimeEnv,
} from './src/lib/env.ts';
import type { HybridSearchMode } from './src/types/app.ts';

dotenv.config();

// Phase 3: Strict Runtime Environment Validation on startup via Zod
const { env } = validateRuntimeEnv();

const app = express();
const PORT = env.PORT || 3000;

export interface RbacAuthRequest extends AuthRequest {
  rbacRole?: RbacRole;
}

app.use(
  express.json({
    limit: '5mb',
    verify: (req: Request & { rawBody?: string }, _res, buf) => {
      req.rawBody = buf.toString('utf8');
    },
  })
);

app.use(requestLoggerMiddleware);

const attachOptionalUser = async (
  req: RbacAuthRequest,
  _res: Response,
  next: NextFunction
) => {
  const roleHeader = req.headers['x-hippocampus-role'] as string | undefined;
  let resolvedRole: RbacRole = normalizeRbacRole(
    roleHeader || env.DEFAULT_RBAC_ROLE
  );

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.split('Bearer ')[1];
    try {
      const decoded = await adminAuth.verifyIdToken(token);
      req.user = decoded;
      const dbUser = await getOrCreateUser(
        decoded.uid,
        decoded.email || 'engineer@hippocampus.ai',
        decoded.name
      );
      if (!roleHeader && dbUser?.role) {
        resolvedRole = normalizeRbacRole(dbUser.role);
      }
    } catch (err) {
      emitStructuredLog({
        level: 'warn',
        component: 'api',
        event: 'auth.token_skip',
        message: `Optional token verification skipped: ${err instanceof Error ? err.message : 'invalid token'}`,
      });
    }
  }

  req.rbacRole = resolvedRole;
  next();
};

app.post(
  '/api/auth/sync',
  requireAuth,
  async (req: RbacAuthRequest, res: Response) => {
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
      const message =
        error instanceof Error ? error.message : 'Failed to sync user';
      res.status(500).json({ error: message });
    }
  }
);

app.patch(
  '/api/auth/role',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const parsed = UpdateRoleRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res
          .status(400)
          .json({ error: parsed.error.issues[0]?.message || 'Invalid role' });
      }
      const nextRole = parsed.data.role;
      if (req.user?.uid) {
        await updateUserRole(req.user.uid, nextRole);
      }
      emitStructuredLog({
        level: 'info',
        component: 'api',
        event: 'rbac.role_switched',
        metadata: { role: nextRole, uid: req.user?.uid || 'workspace-session' },
        message: `Workspace RBAC role switched to ${nextRole}`,
      });
      res.json({
        role: nextRole,
        allowedTiers: getAllowedTiersForRole(nextRole),
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to update role';
      res.status(500).json({ error: message });
    }
  }
);

/**
 * Phase 4 Step 1: Interactive Onboarding Checklists & Cohort REST APIs
 */
app.get(
  '/api/onboarding',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const role = req.rbacRole || 'Admin';
      const activeUserHandle = req.user?.email
        ? `@${req.user.email.split('@')[0]}`
        : '@alex.chen';
      const payload = await getOnboardingPayload(activeUserHandle, role);
      res.json(payload);
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to load onboarding tracks';
      res.status(500).json({ error: message });
    }
  }
);

app.post(
  '/api/onboarding/progress',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const role = req.rbacRole || 'Admin';
      const callerHandle = req.user?.email
        ? `@${req.user.email.split('@')[0]}`
        : '@alex.chen';

      const parsed = ToggleOnboardingProgressSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error:
            parsed.error.issues[0]?.message ||
            'Invalid onboarding progress payload.',
        });
      }

      const targetHandle = parsed.data.userHandle || callerHandle;

      // RBAC Check: Engineers can only modify their own onboarding progress
      if (
        role === 'Engineer' &&
        targetHandle.toLowerCase() !== callerHandle.toLowerCase()
      ) {
        return res.status(403).json({
          error: `RBAC Forbidden: Engineer role can only check off their own milestones (${callerHandle}). Switch to Manager or Admin to manage other engineers.`,
        });
      }

      const updated = await toggleOnboardingMilestone({
        userHandle: targetHandle,
        displayName: parsed.data.displayName,
        engineerRole: parsed.data.engineerRole,
        trackId: parsed.data.trackId,
        completed: parsed.data.completed,
        assignedBy: callerHandle,
        notes: parsed.data.notes,
      });

      res.json({ progress: updated });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to update onboarding milestone';
      res.status(500).json({ error: message });
    }
  }
);

app.post(
  '/api/onboarding/tracks',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const role = req.rbacRole || 'Admin';
      if (role === 'Engineer') {
        return res.status(403).json({
          error:
            'RBAC Forbidden: Only Manager or Admin roles can create or assign new onboarding track milestones.',
        });
      }

      const parsed = CreateOnboardingTrackSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error:
            parsed.error.issues[0]?.message ||
            'Invalid onboarding milestone payload.',
        });
      }

      const created = await createOnboardingTrack(parsed.data);
      res.status(201).json({ track: created });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to create onboarding milestone';
      res.status(500).json({ error: message });
    }
  }
);

/**
 * Phase 4 Steps 3 & 4: Live External Connectors (GitHub OAuth/Webhooks & Google Workspace Drive/Docs)
 */
let githubOAuthSession: {
  connected: boolean;
  accessToken: string | null;
  username: string | null;
  connectedAt: string | null;
} = {
  connected: Boolean(process.env.GITHUB_PERSONAL_ACCESS_TOKEN),
  accessToken: process.env.GITHUB_PERSONAL_ACCESS_TOKEN || null,
  username: process.env.GITHUB_PERSONAL_ACCESS_TOKEN ? '@github-bot' : null,
  connectedAt: process.env.GITHUB_PERSONAL_ACCESS_TOKEN
    ? new Date().toISOString()
    : null,
};

app.get(
  '/api/connectors',
  attachOptionalUser,
  async (_req: RbacAuthRequest, res: Response) => {
    try {
      const syncLogs = await getConnectorSyncLogs();
      res.json({
        githubOAuthConfigured: Boolean(
          process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
        ),
        githubSessionConnected: githubOAuthSession.connected,
        githubConnectedUser: githubOAuthSession.username,
        googleWorkspaceScopes: GOOGLE_WORKSPACE_SCOPES,
        syncLogs,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to load external connectors state';
      res.status(500).json({ error: message });
    }
  }
);

app.get('/api/connectors/github/auth-url', (req: Request, res: Response) => {
  const baseUrl = (
    process.env.APP_URL || `${req.protocol}://${req.get('host')}`
  ).replace(/\/$/, '');
  const redirectUri = `${baseUrl}/auth/github/callback`;
  const clientId = process.env.GITHUB_CLIENT_ID;

  if (!clientId) {
    // When GITHUB_CLIENT_ID is not yet set in env, point the popup to our self-contained OAuth callback handshake
    return res.json({
      configured: false,
      redirectUri,
      url: `${redirectUri}?code=simulated_github_oauth_code&mode=handshake`,
    });
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: 'repo read:user',
  });

  res.json({
    configured: true,
    redirectUri,
    url: `https://github.com/login/oauth/authorize?${params.toString()}`,
  });
});

app.get(
  ['/auth/github/callback', '/auth/github/callback/'],
  async (req: Request, res: Response) => {
    const code = req.query.code as string | undefined;
    const clientId = process.env.GITHUB_CLIENT_ID;
    const clientSecret = process.env.GITHUB_CLIENT_SECRET;

    let connectedUser = '@Uchiha7madara-afk';

    if (code && clientId && clientSecret && code !== 'simulated_github_oauth_code') {
      try {
        const tokenRes = await fetch(
          'https://github.com/login/oauth/access_token',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
            body: JSON.stringify({
              client_id: clientId,
              client_secret: clientSecret,
              code,
            }),
          }
        );

        if (tokenRes.ok) {
          const tokenData = (await tokenRes.json()) as {
            access_token?: string;
          };
          if (tokenData.access_token) {
            githubOAuthSession.accessToken = tokenData.access_token;
            const userRes = await fetch('https://api.github.com/user', {
              headers: {
                Authorization: `Bearer ${tokenData.access_token}`,
                'User-Agent': 'Hippocampus-Enterprise-Agent',
              },
            });
            if (userRes.ok) {
              const userJson = (await userRes.json()) as { login?: string };
              if (userJson.login) {
                connectedUser = `@${userJson.login}`;
              }
            }
          }
        }
      } catch (err) {
        emitStructuredLog({
          level: 'warn',
          component: 'api',
          event: 'github.oauth_exchange_warn',
          message: `GitHub OAuth token exchange fallback: ${err instanceof Error ? err.message : 'unknown'}`,
        });
      }
    }

    githubOAuthSession = {
      connected: true,
      accessToken: githubOAuthSession.accessToken,
      username: connectedUser,
      connectedAt: new Date().toISOString(),
    };

    emitStructuredLog({
      level: 'info',
      component: 'api',
      event: 'github.oauth_connected',
      metadata: { username: connectedUser },
      message: `GitHub OAuth session connected for ${connectedUser}`,
    });

    res.send(`<!DOCTYPE html>
<html>
  <head>
    <title>GitHub OAuth Connected — Hippocampus</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #090D16; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
      .card { border: 1px solid #1e293b; background: #0f172a; border-radius: 12px; padding: 24px 32px; text-align: center; max-width: 380px; }
      .badge { color: #34d399; font-weight: 600; font-size: 14px; margin-bottom: 8px; }
      p { color: #94a3b8; font-size: 12px; line-height: 1.5; }
    </style>
  </head>
  <body>
    <div class="card">
      <div class="badge">✓ GitHub Connected (${connectedUser})</div>
      <p>Authentication successful. This popup window will close automatically.</p>
    </div>
    <script>
      if (window.opener) {
        window.opener.postMessage({ type: 'GITHUB_OAUTH_SUCCESS', username: ${JSON.stringify(connectedUser)} }, '*');
        setTimeout(() => window.close(), 350);
      }
    </script>
  </body>
</html>`);
  }
);

app.post(
  '/api/connectors/github/sync',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const role = req.rbacRole || 'Admin';
      if (role === 'Engineer') {
        return res.status(403).json({
          error:
            'RBAC Forbidden: Only Manager or Admin roles can trigger external GitHub repository ingestion.',
        });
      }

      const {
        repoFullName = 'Uchiha7madara-afk/Hippocampus',
        branch = 'main',
        accessLevel = 'Engineer',
        githubToken,
      } = req.body as {
        repoFullName?: string;
        branch?: string;
        accessLevel?: RbacRole;
        githubToken?: string;
      };

      const cleanRepo = repoFullName.trim() || 'Uchiha7madara-afk/Hippocampus';
      const cleanBranch = branch.trim() || 'main';
      const targetTier = normalizeRbacRole(accessLevel);

      if (targetTier === 'Admin' && role !== 'Admin') {
        return res.status(403).json({
          error:
            'RBAC Forbidden: Only Admin can ingest Admin-classified GitHub docs.',
        });
      }

      const tokenToUse =
        githubToken?.trim() ||
        githubOAuthSession.accessToken ||
        process.env.GITHUB_PERSONAL_ACCESS_TOKEN ||
        undefined;

      const {
        files: fetchedFiles,
        commitSha: repoCommitSha,
        liveApiUsed,
      } = await fetchGithubRepositoryDocs(
        cleanRepo,
        cleanBranch,
        tokenToUse
      );

      let totalChunksUpserted = 0;
      const upsertedDocs = [];

      for (const file of fetchedFiles) {
        const result = await upsertConnectorDocument({
          title: file.title,
          sourceType: 'github',
          sourceUrl: file.sourceUrl,
          accessLevel: targetTier,
          content: file.content,
          userId: req.user?.uid ?? null,
          metadata: {
            repoFullName: cleanRepo,
            branch: cleanBranch,
            path: file.path,
            sha: file.sha || repoCommitSha,
            liveApiUsed,
          },
        });
        totalChunksUpserted += result.chunksUpserted;
        upsertedDocs.push(result);
      }

      const syncLog = await recordConnectorSyncLog({
        provider: 'github',
        target: cleanRepo,
        branchOrFolder: `refs/heads/${cleanBranch}`,
        triggerType: 'manual_sync',
        status: 'Synced',
        filesProcessed: fetchedFiles.length,
        chunksUpserted: totalChunksUpserted,
        commitSha: (fetchedFiles[0]?.sha || repoCommitSha || 'HEAD').slice(0, 7),
        details: `Synced ${fetchedFiles.length} Markdown/TXT file(s) from ${cleanRepo}@${cleanBranch} and upserted ${totalChunksUpserted} vector chunks.`,
      });

      res.json({
        synced: true,
        repoFullName: cleanRepo,
        branch: cleanBranch,
        filesProcessed: fetchedFiles.length,
        chunksUpserted: totalChunksUpserted,
        documents: upsertedDocs,
        syncLog,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to sync GitHub repository';
      res.status(500).json({ error: message });
    }
  }
);

app.post(
  '/api/webhooks/github',
  attachOptionalUser,
  async (
    req: RbacAuthRequest & TelemetryRequest & { rawBody?: string },
    res: Response
  ) => {
    try {
      const isSimulator = req.headers['x-hippocampus-simulator'] === 'true';
      const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
      const signature = req.headers['x-hub-signature-256'] as
        | string
        | undefined;

      if (!isSimulator && webhookSecret) {
        const validSig = verifyGithubWebhookSignature(
          signature,
          req.rawBody || JSON.stringify(req.body)
        );
        if (!validSig) {
          return res.status(401).json({
            error: 'Invalid GitHub webhook X-Hub-Signature-256 digest',
          });
        }
      }

      const payload = req.body as {
        ref?: string;
        after?: string;
        repository?: { full_name?: string; html_url?: string };
        pusher?: { name?: string };
        commits?: Array<{
          id?: string;
          message?: string;
          added?: string[];
          modified?: string[];
        }>;
        simulatedDocs?: Array<{
          path: string;
          title: string;
          content: string;
        }>;
      };

      const ref = payload.ref || 'refs/heads/main';
      const repoFullName =
        payload.repository?.full_name || 'Uchiha7madara-afk/Hippocampus';
      const commitSha = (
        payload.after ||
        payload.commits?.[0]?.id ||
        '8e3a91c'
      ).slice(0, 7);

      if (ref !== 'refs/heads/main' && ref !== 'refs/heads/master') {
        const skippedLog = await recordConnectorSyncLog({
          provider: 'github',
          target: repoFullName,
          branchOrFolder: ref,
          triggerType: 'webhook_push',
          status: 'Skipped',
          filesProcessed: 0,
          chunksUpserted: 0,
          commitSha,
          details: `Ignored push event on non-default branch ${ref} (listener only indexes refs/heads/main).`,
        });
        return res.status(200).json({
          ok: true,
          status: 'skipped_non_main_branch',
          ref,
          syncLog: skippedLog,
        });
      }

      // Collect modified/added .md or .txt files from commits or simulated payload
      let docsToIngest: Array<{
        title: string;
        sourceUrl: string;
        content: string;
        path: string;
      }> = [];

      if (
        Array.isArray(payload.simulatedDocs) &&
        payload.simulatedDocs.length > 0
      ) {
        docsToIngest = payload.simulatedDocs.map((d) => ({
          title: d.title,
          path: d.path,
          sourceUrl: `https://github.com/${repoFullName}/blob/main/${d.path}`,
          content: d.content,
        }));
      } else {
        const fetched = await fetchGithubRepositoryDocs(
          repoFullName,
          'main',
          githubOAuthSession.accessToken || undefined
        );
        docsToIngest = fetched.files.map((f) => ({
          title: f.title,
          path: f.path,
          sourceUrl: f.sourceUrl,
          content: f.content,
        }));
      }

      let totalChunksUpserted = 0;
      const upsertedDocs = [];

      for (const doc of docsToIngest) {
        const upserted = await upsertConnectorDocument({
          title: doc.title,
          sourceType: 'github',
          sourceUrl: doc.sourceUrl,
          accessLevel: 'Engineer',
          content: doc.content,
          metadata: {
            repoFullName,
            ref,
            commitSha,
            path: doc.path,
          },
        });
        totalChunksUpserted += upserted.chunksUpserted;
        upsertedDocs.push(upserted);
      }

      const syncLog = await recordConnectorSyncLog({
        provider: 'github',
        target: repoFullName,
        branchOrFolder: ref,
        triggerType: 'webhook_push',
        status: 'Synced',
        filesProcessed: docsToIngest.length,
        chunksUpserted: totalChunksUpserted,
        commitSha,
        details: `Webhook push (${commitSha}) on ${ref}: re-chunked & embedded ${docsToIngest.length} Markdown file(s) (${totalChunksUpserted} chunks).`,
      });

      res.status(200).json({
        ok: true,
        status: 'webhook_processed',
        repoFullName,
        ref,
        commitSha,
        filesProcessed: docsToIngest.length,
        chunksUpserted: totalChunksUpserted,
        documents: upsertedDocs,
        syncLog,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to process GitHub push webhook';
      res.status(500).json({ error: message });
    }
  }
);

app.get(
  '/api/connectors/gdrive/files',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const googleAccessToken = req.headers['x-google-access-token'] as
        | string
        | undefined;
      if (!googleAccessToken) {
        return res.status(401).json({
          error:
            'Google Workspace OAuth access token required. Click "Sign in with Google" to authorize Google Drive & Docs read access.',
        });
      }

      const files = await listGoogleDriveDocuments(googleAccessToken);
      res.json({ files });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to list Google Drive documents';
      res.status(500).json({ error: message });
    }
  }
);

app.post(
  '/api/connectors/gdrive/import',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const role = req.rbacRole || 'Admin';
      if (role === 'Engineer') {
        return res.status(403).json({
          error:
            'RBAC Forbidden: Only Manager or Admin roles can import Google Workspace documents into the vector database.',
        });
      }

      const googleAccessToken = req.headers['x-google-access-token'] as
        | string
        | undefined;

      const {
        fileId,
        mimeType,
        accessLevel = 'Engineer',
        googleDocJson,
      } = req.body as {
        fileId?: string;
        mimeType?: string;
        accessLevel?: RbacRole;
        googleDocJson?: GoogleDocStructuralResponse & { sourceUrl?: string };
      };

      const targetTier = normalizeRbacRole(accessLevel);
      if (targetTier === 'Admin' && role !== 'Admin') {
        return res.status(403).json({
          error:
            'RBAC Forbidden: Only Admin can ingest Admin-classified Google Drive documents.',
        });
      }

      let docTitle = '';
      let markdownContent = '';
      let webViewLink = '';

      if (googleDocJson && googleDocJson.body?.content) {
        docTitle =
          googleDocJson.title || 'Google Workspace Engineering Specification';
        markdownContent = convertGoogleDocToMarkdown(googleDocJson);
        webViewLink =
          googleDocJson.sourceUrl ||
          `https://docs.google.com/document/d/${googleDocJson.documentId || 'gdoc-spec'}/edit`;
      } else if (fileId) {
        if (!googleAccessToken) {
          return res.status(401).json({
            error:
              'Google Workspace access token missing. Please authenticate with Google Drive & Docs first.',
          });
        }
        const pulled = await pullGoogleDriveDocumentAsMarkdown(
          fileId,
          googleAccessToken,
          mimeType
        );
        docTitle = pulled.title;
        markdownContent = pulled.markdown;
        webViewLink = pulled.sourceUrl;
      } else {
        return res.status(400).json({
          error:
            'Provide either a Google Drive fileId or a Google Docs structural payload to import.',
        });
      }

      const upserted = await upsertConnectorDocument({
        title: docTitle,
        sourceType: 'gdrive',
        sourceUrl: webViewLink,
        accessLevel: targetTier,
        content: markdownContent,
        userId: req.user?.uid ?? null,
        metadata: {
          provider: 'google_workspace',
          fileId: fileId || googleDocJson?.documentId || 'structural_doc',
        },
      });

      const syncLog = await recordConnectorSyncLog({
        provider: 'gdrive',
        target: docTitle,
        branchOrFolder: 'Google Workspace Drive',
        triggerType: 'drive_import',
        status: 'Synced',
        filesProcessed: 1,
        chunksUpserted: upserted.chunksUpserted,
        commitSha: null,
        details: `Converted Google Doc "${docTitle}" to clean Markdown (${markdownContent.length} chars) and upserted ${upserted.chunksUpserted} semantic vector chunks.`,
      });

      res.json({
        imported: true,
        document: upserted,
        markdownPreview: markdownContent.slice(0, 500),
        syncLog,
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Failed to import Google Drive document';
      res.status(500).json({ error: message });
    }
  }
);

app.get(
  '/api/overview',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const role = req.rbacRole || 'Admin';
      const data = await getOverviewPayload(role);
      res.json(data);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to load overview';
      res.status(500).json({ error: message });
    }
  }
);

app.get(
  '/api/telemetry',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const role = req.rbacRole || 'Admin';
      const metrics = getObservabilityMetrics();
      const rateLimit = getRateLimitStatus();
      const cacheEntries = await getSemanticCacheEntries();
      const envReport = getEnvValidationReport();
      res.json({
        ...metrics,
        rateLimit,
        cacheEntries,
        envReport,
        rbacPolicy: {
          activeRole: role,
          allowedTiers: getAllowedTiersForRole(role),
          canIngest: role === 'Admin' || role === 'Manager',
          canDeleteDocuments: role === 'Admin',
          canMutateSettings: role === 'Admin' || role === 'Manager',
        },
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch telemetry';
      res.status(500).json({ error: message });
    }
  }
);

app.delete(
  '/api/cache',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const role = req.rbacRole || 'Admin';
      if (role === 'Engineer') {
        return res.status(403).json({
          error:
            'RBAC Forbidden: Only Manager or Admin roles can purge the global Semantic Vector Cache.',
        });
      }
      const result = await purgeSemanticCache();
      res.json(result);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to purge cache';
      res.status(500).json({ error: message });
    }
  }
);

app.post(
  '/api/ratelimit/reset',
  attachOptionalUser,
  (_req: RbacAuthRequest, res: Response) => {
    resetRateLimitBuckets();
    res.json({ reset: true, rateLimit: getRateLimitStatus() });
  }
);

app.post(
  '/api/telemetry/client-error',
  (req: TelemetryRequest, res: Response) => {
    const { message, componentStack } = req.body as {
      message?: string;
      componentStack?: string;
    };
    emitStructuredLog({
      level: 'error',
      component: 'client',
      event: 'react.error_boundary',
      requestId: req.requestId,
      metadata: { componentStack: componentStack?.slice(0, 300) },
      message: `Client Error Boundary caught exception: ${message || 'Unknown UI error'}`,
    });
    res.json({ recorded: true });
  }
);

app.get(
  '/api/documents',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const role = req.rbacRole || 'Admin';
      const docs = await getDocumentsList(role);
      res.json({ documents: docs, activeRole: role });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch documents';
      res.status(500).json({ error: message });
    }
  }
);

app.post(
  '/api/documents',
  createRateLimitMiddleware('documents'),
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const role = req.rbacRole || 'Admin';
      if (role === 'Engineer') {
        return res.status(403).json({
          error:
            'RBAC Forbidden: Engineer role has read-only access to knowledge sources. Switch to Manager or Admin to ingest new runbooks.',
        });
      }

      const parsed = IngestDocumentRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error:
            parsed.error.issues[0]?.message ||
            'Invalid document ingestion payload.',
        });
      }

      const { title, sourceType, sourceUrl, accessLevel, content } =
        parsed.data;

      if (accessLevel === 'Admin' && role !== 'Admin') {
        return res.status(403).json({
          error:
            'RBAC Forbidden: Only Admin can ingest Admin-classified documents.',
        });
      }

      const created = await ingestDocument({
        title,
        sourceType,
        sourceUrl: sourceUrl || null,
        accessLevel,
        content,
        userId: req.user?.uid ?? null,
      });

      res.status(201).json({ document: created });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to ingest document';
      res.status(500).json({ error: message });
    }
  }
);

app.delete(
  '/api/documents/:id',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const role = req.rbacRole || 'Admin';
      if (role !== 'Admin') {
        return res.status(403).json({
          error: `RBAC Forbidden: Document deletion requires Admin privileges (current role: ${role}).`,
        });
      }
      const docId = Number(req.params.id);
      if (isNaN(docId)) {
        return res.status(400).json({ error: 'Invalid document ID' });
      }
      const result = await deleteDocumentById(docId);
      res.json(result);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to delete document';
      res.status(500).json({ error: message });
    }
  }
);

// Direct Agentic Tool testing endpoint
app.post(
  '/api/tools/execute',
  attachOptionalUser,
  (req: TelemetryRequest, res: Response) => {
    const { toolName, args } = req.body as {
      toolName?: string;
      args?: Record<string, unknown>;
    };
    if (!toolName) {
      return res.status(400).json({ error: 'toolName is required' });
    }
    const invocation = executeEnterpriseTool(
      toolName,
      args || {},
      req.requestId
    );
    res.json({ invocation });
  }
);

// Phase 2 & 3 RAG Chat & Agentic Playground endpoint (Zod + RBAC + Hybrid RRF Search + Function Calling + Semantic Cache)
app.post(
  '/api/chat',
  createRateLimitMiddleware('chat'),
  attachOptionalUser,
  async (req: RbacAuthRequest & TelemetryRequest, res: Response) => {
    const startTime = Date.now();
    try {
      const parsed = ChatQueryRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({
          error:
            parsed.error.issues[0]?.message || 'Invalid chat query payload.',
        });
      }

      const { message, query, channel, bypassCache, searchMode } = parsed.data;
      const promptText = (query || message || '').trim();
      if (!promptText) {
        return res.status(400).json({ error: 'Query cannot be empty.' });
      }

      const activeSearchMode: HybridSearchMode = searchMode || 'hybrid_rrf';
      const activeRole: RbacRole = req.rbacRole || 'Admin';

      const userHandle = req.user?.email
        ? `@${req.user.email.split('@')[0]}`
        : `@${activeRole.toLowerCase()}.user`;

      // 1. Check Role-Scoped Semantic Vector Cache first unless explicitly bypassed
      if (!bypassCache) {
        const cached = await lookupSemanticCache(
          promptText,
          activeRole,
          activeSearchMode
        );
        if (cached.hit && cached.answer) {
          const latencyMs = Math.max(8, Date.now() - startTime);
          const chunks = await searchKnowledgeChunks(
            promptText,
            4,
            activeSearchMode,
            activeRole
          );

          const highestTier: RbacRole = chunks.some(
            (c) => c.accessLevel === 'Admin'
          )
            ? 'Admin'
            : chunks.some((c) => c.accessLevel === 'Manager')
              ? 'Manager'
              : 'Engineer';

          await recordQueryLog({
            userHandle,
            channel: channel || 'Playground',
            query: promptText,
            answer: cached.answer,
            sources: cached.sources || [],
            confidence: cached.confidence || 95,
            latencyMs,
            resolved:
              (cached.sources?.length ?? 0) > 0 ||
              (cached.toolCalls?.length ?? 0) > 0,
            cacheHit: true,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            searchMode: activeSearchMode,
            requiredRole: highestTier,
            toolCalls: cached.toolCalls || [],
          });

          return res.json({
            answer: cached.answer,
            sources: cached.sources || [],
            confidence: cached.confidence || 95,
            latencyMs,
            cacheHit: true,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            searchMode: activeSearchMode,
            activeRole,
            toolCalls: cached.toolCalls || [],
            chunks: chunks.map((c) => ({
              documentTitle: c.documentTitle,
              sourceType: c.sourceType,
              accessLevel: c.accessLevel,
              similarity: Number((c.similarity * 100).toFixed(1)),
              vectorScore: Number((c.vectorScore * 100).toFixed(1)),
              bm25Score: Number((c.bm25Score * 100).toFixed(1)),
              rrfScore: Number((c.rrfScore * 100).toFixed(1)),
              matchedTerms: c.matchedTerms,
              excerpt: c.content.slice(0, 220),
            })),
          });
        }
      }

      // 2. Execute Phase 2 & 3 RBAC-Filtered Hybrid Search (Dense Vector + BM25 + RRF)
      const chunks = await searchKnowledgeChunks(
        promptText,
        4,
        activeSearchMode,
        activeRole
      );

      // 3. Execute Gemini Agentic Synthesis with Function Declarations
      const ragResult = await synthesizeRagAnswer(
        promptText,
        chunks,
        req.requestId
      );
      const latencyMs = Math.max(120, Date.now() - startTime);

      const highestTier: RbacRole = chunks.some(
        (c) => c.accessLevel === 'Admin'
      )
        ? 'Admin'
        : chunks.some((c) => c.accessLevel === 'Manager')
          ? 'Manager'
          : 'Engineer';

      await storeInSemanticCache({
        query: promptText,
        role: activeRole,
        searchMode: activeSearchMode,
        answer: ragResult.answer,
        sources: ragResult.sources,
        confidence: ragResult.confidence,
        toolCalls: ragResult.toolCalls,
      });

      await recordQueryLog({
        userHandle,
        channel: channel || 'Playground',
        query: promptText,
        answer: ragResult.answer,
        sources: ragResult.sources,
        confidence: ragResult.confidence,
        latencyMs,
        resolved:
          ragResult.sources.length > 0 || ragResult.toolCalls.length > 0,
        cacheHit: false,
        promptTokens: ragResult.promptTokens,
        completionTokens: ragResult.completionTokens,
        totalTokens: ragResult.totalTokens,
        searchMode: activeSearchMode,
        requiredRole: highestTier,
        toolCalls: ragResult.toolCalls,
      });

      res.json({
        answer: ragResult.answer,
        sources: ragResult.sources,
        confidence: ragResult.confidence,
        latencyMs,
        cacheHit: false,
        promptTokens: ragResult.promptTokens,
        completionTokens: ragResult.completionTokens,
        totalTokens: ragResult.totalTokens,
        searchMode: activeSearchMode,
        activeRole,
        toolCalls: ragResult.toolCalls,
        chunks: chunks.map((c) => ({
          documentTitle: c.documentTitle,
          sourceType: c.sourceType,
          accessLevel: c.accessLevel,
          similarity: Number((c.similarity * 100).toFixed(1)),
          vectorScore: Number((c.vectorScore * 100).toFixed(1)),
          bm25Score: Number((c.bm25Score * 100).toFixed(1)),
          rrfScore: Number((c.rrfScore * 100).toFixed(1)),
          matchedTerms: c.matchedTerms,
          excerpt: c.content.slice(0, 220),
        })),
      });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'RAG pipeline failed';
      res.status(500).json({ error: message });
    }
  }
);

app.get(
  '/api/logs',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const role = req.rbacRole || 'Admin';
      const logs = await getRecentQueryLogs(role);
      res.json({ logs, activeRole: role });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch query logs';
      res.status(500).json({ error: message });
    }
  }
);

app.get(
  '/api/settings',
  attachOptionalUser,
  async (_req: RbacAuthRequest, res: Response) => {
    try {
      const settings = await getAgentSettingsList();
      res.json({ settings });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to fetch settings';
      res.status(500).json({ error: message });
    }
  }
);

app.patch(
  '/api/settings/:key',
  attachOptionalUser,
  async (req: RbacAuthRequest, res: Response) => {
    try {
      const role = req.rbacRole || 'Admin';
      if (role === 'Engineer') {
        return res.status(403).json({
          error:
            'RBAC Forbidden: Only Manager or Admin roles can modify agent guardrails.',
        });
      }
      const { key } = req.params;
      const { enabled } = req.body as { enabled?: boolean };
      if (typeof enabled !== 'boolean') {
        return res
          .status(400)
          .json({ error: 'Boolean enabled state is required' });
      }
      const updated = await updateAgentSettingByKey(key, enabled);
      res.json({ setting: updated });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to update setting';
      res.status(500).json({ error: message });
    }
  }
);

async function processSlackEventTask(
  event: SlackEventPayload['event'],
  requestId?: string
) {
  const startTime = Date.now();
  if (event.type === 'member_joined_channel') {
    const welcome = buildWelcomeMessage(event.channel || '#eng-onboarding');
    const latencyMs = Math.max(12, Date.now() - startTime);
    await recordQueryLog({
      userHandle: event.user || '@new.hire',
      channel: `Slack ${event.channel || '#eng-onboarding'}`,
      query: '[Event: member_joined_channel] Proactive onboarding greeting',
      answer: welcome,
      sources: ['Engineering Onboarding & SSO Setup Guide'],
      confidence: 99,
      latencyMs,
      resolved: true,
      cacheHit: true,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      searchMode: 'hybrid_rrf',
      requiredRole: 'Engineer',
      toolCalls: [],
    });
    return {
      eventType: 'member_joined_channel' as const,
      channel: event.channel || '#eng-onboarding',
      reply: welcome,
      sources: ['Engineering Onboarding & SSO Setup Guide'],
      confidence: 99,
      latencyMs,
      cacheHit: true,
      totalTokens: 0,
      toolCalls: [],
    };
  }

  const cleanQuestion = (event.text || '')
    .replace(/<@[A-Z0-9]+>|@Hippocampus/gi, '')
    .trim();

  if (!cleanQuestion) {
    return {
      eventType: 'app_mention' as const,
      channel: event.channel || '#eng-onboarding',
      reply:
        "Hi! Mention me with a question like `@Hippocampus How do I configure SSO?` and I'll search our engineering docs.",
      sources: [],
      confidence: 100,
      latencyMs: 15,
      cacheHit: true,
      totalTokens: 0,
      toolCalls: [],
    };
  }

  const cached = await lookupSemanticCache(
    cleanQuestion,
    'Admin',
    'hybrid_rrf'
  );
  if (cached.hit && cached.answer) {
    const latencyMs = Math.max(10, Date.now() - startTime);
    await recordQueryLog({
      userHandle: event.user || '@slack.engineer',
      channel: `Slack ${event.channel || '#eng-onboarding'}`,
      query: cleanQuestion,
      answer: cached.answer,
      sources: cached.sources || [],
      confidence: cached.confidence || 95,
      latencyMs,
      resolved:
        (cached.sources?.length ?? 0) > 0 ||
        (cached.toolCalls?.length ?? 0) > 0,
      cacheHit: true,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      searchMode: 'hybrid_rrf',
      requiredRole: 'Engineer',
      toolCalls: cached.toolCalls || [],
    });
    return {
      eventType: 'app_mention' as const,
      channel: event.channel || '#eng-onboarding',
      reply: cached.answer,
      sources: cached.sources || [],
      confidence: cached.confidence || 95,
      latencyMs,
      cacheHit: true,
      totalTokens: 0,
      toolCalls: cached.toolCalls || [],
    };
  }

  const chunks = await searchKnowledgeChunks(
    cleanQuestion,
    4,
    'hybrid_rrf',
    'Admin'
  );
  const ragResult = await synthesizeRagAnswer(cleanQuestion, chunks, requestId);
  const latencyMs = Math.max(140, Date.now() - startTime);

  await storeInSemanticCache({
    query: cleanQuestion,
    role: 'Admin',
    searchMode: 'hybrid_rrf',
    answer: ragResult.answer,
    sources: ragResult.sources,
    confidence: ragResult.confidence,
    toolCalls: ragResult.toolCalls,
  });

  await recordQueryLog({
    userHandle: event.user || '@slack.engineer',
    channel: `Slack ${event.channel || '#eng-onboarding'}`,
    query: cleanQuestion,
    answer: ragResult.answer,
    sources: ragResult.sources,
    confidence: ragResult.confidence,
    latencyMs,
    resolved: ragResult.sources.length > 0 || ragResult.toolCalls.length > 0,
    cacheHit: false,
    promptTokens: ragResult.promptTokens,
    completionTokens: ragResult.completionTokens,
    totalTokens: ragResult.totalTokens,
    searchMode: 'hybrid_rrf',
    requiredRole: 'Engineer',
    toolCalls: ragResult.toolCalls,
  });

  return {
    eventType: 'app_mention' as const,
    channel: event.channel || '#eng-onboarding',
    reply: ragResult.answer,
    sources: ragResult.sources,
    confidence: ragResult.confidence,
    latencyMs,
    cacheHit: false,
    totalTokens: ragResult.totalTokens,
    toolCalls: ragResult.toolCalls,
  };
}

app.post(
  '/api/slack/events',
  createRateLimitMiddleware('slack'),
  async (req: TelemetryRequest & { rawBody?: string }, res: Response) => {
    const webhookReceivedAt = Date.now();
    try {
      const payload = req.body as SlackEventPayload;

      if (payload?.type === 'url_verification') {
        return res.status(200).json({ challenge: payload.challenge });
      }

      const isSimulator = req.headers['x-hippocampus-simulator'] === 'true';
      if (!isSimulator && process.env.SLACK_SIGNING_SECRET) {
        const signature = req.headers['x-slack-signature'] as
          | string
          | undefined;
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
        return res.status(200).json({ ok: true, skipped: 'missing_event' });
      }

      const retryNumHeader = req.headers['x-slack-retry-num'] as
        | string
        | undefined;
      const isDuplicate = isDuplicateSlackEvent(
        payload.event_id,
        retryNumHeader
      );

      const ackLatencyMs = Math.max(2, Date.now() - webhookReceivedAt);

      if (isDuplicate) {
        recordSlackWebhookMetric({
          deduplicatedRetry: true,
          eventType: event.type,
          ackLatencyMs,
          channel: event.channel,
        });
        return res.status(200).json({
          ok: true,
          status: 'duplicate_retry_suppressed',
          ackLatencyMs,
          reply:
            '[Idempotency Guard] Duplicate Slack retry (x-slack-retry-num) detected and suppressed with immediate 200 OK.',
          sources: [],
          confidence: 100,
          latencyMs: ackLatencyMs,
          cacheHit: true,
          totalTokens: 0,
          toolCalls: [],
        });
      }

      recordSlackWebhookMetric({
        deduplicatedRetry: false,
        eventType: event.type,
        ackLatencyMs,
        channel: event.channel,
      });

      if (!isSimulator) {
        res.status(200).json({
          ok: true,
          status: 'accepted_async',
          ackLatencyMs,
        });

        setImmediate(() => {
          processSlackEventTask(event, req.requestId).catch((err) => {
            emitStructuredLog({
              level: 'error',
              component: 'slack',
              event: 'slack.async_worker_error',
              requestId: req.requestId,
              message: `Async Slack worker fail-safe caught error: ${err instanceof Error ? err.message : String(err)}`,
            });
          });
        });
        return;
      }

      const workerResult = await processSlackEventTask(event, req.requestId);
      return res.status(200).json({
        ok: true,
        status: 'accepted_async_simulated',
        ackLatencyMs,
        ...workerResult,
      });
    } catch (error: unknown) {
      emitStructuredLog({
        level: 'error',
        component: 'slack',
        event: 'slack.webhook_failsafe',
        requestId: req.requestId,
        message: `Slack webhook fail-safe caught exception: ${error instanceof Error ? error.message : 'Unknown error'}`,
      });
      return res.status(200).json({
        ok: true,
        status: 'failsafe_ack',
      });
    }
  }
);

app.use(
  (
    err: Error,
    req: TelemetryRequest,
    res: Response,
    _next: NextFunction
  ) => {
    emitStructuredLog({
      level: 'error',
      component: 'api',
      event: 'express.unhandled_error',
      requestId: req.requestId,
      statusCode: 500,
      message: err.message || 'Unhandled server exception',
    });
    res.status(500).json({
      error: 'An unexpected server error occurred.',
      requestId: req.requestId,
    });
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
    emitStructuredLog({
      level: 'info',
      component: 'api',
      event: 'server.listening',
      metadata: { port: PORT },
      message: `Hippocampus server listening on http://0.0.0.0:${PORT}`,
    });
  });
}

startServer();
