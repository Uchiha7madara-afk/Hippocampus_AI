export type WorkspaceTab =
  | 'dashboard'
  | 'onboarding'
  | 'connectors'
  | 'sources'
  | 'playground'
  | 'slack'
  | 'logs';

export type HybridSearchMode =
  | 'hybrid_rrf'
  | 'sparse_bm25'
  | 'dense_vector'
  | 'linear_sum'
  | 'vector_only'
  | 'bm25_lexical';

export type RbacRole = 'Admin' | 'Manager' | 'Engineer';

export type OnboardingPhase = 'Day 1' | 'Week 1' | 'Month 1';

export type DocumentSourceType = 'file' | 'url' | 'slack' | 'github' | 'gdrive';

export interface AgentToolInvocation {
  toolName: string;
  args: Record<string, unknown>;
  result: Record<string, unknown>;
  durationMs: number;
}

export interface IndexedDocument {
  id: number;
  userId: string | null;
  title: string;
  sourceType: DocumentSourceType;
  sourceUrl: string | null;
  status: string;
  accessLevel: RbacRole;
  chunkCount: number;
  contentPreview: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface QueryLogItem {
  id: number;
  userHandle: string;
  channel: string;
  query: string;
  answer: string;
  sources: string[];
  sourcesCited: number;
  confidence: number;
  latencyMs: number;
  resolved: boolean;
  cacheHit: boolean;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  searchMode: string;
  requiredRole: RbacRole;
  toolCalls: AgentToolInvocation[];
  createdAt: string;
}

export interface AgentSettingItem {
  id: number;
  key: string;
  label: string;
  description: string;
  enabled: boolean;
  updatedAt: string;
}

export interface DashboardStats {
  totalDocuments: number;
  totalChunks: number;
  totalQueries: number;
  avgConfidence: number;
  avgLatencyMs: number;
  cachedQueriesCount?: number;
}

export interface OverviewPayload {
  stats: DashboardStats;
  recentDocuments: IndexedDocument[];
  recentLogs: QueryLogItem[];
  settings: AgentSettingItem[];
  activeRole?: RbacRole;
}

export interface RetrievedChunkPreview {
  documentTitle: string;
  sourceType: string;
  accessLevel?: RbacRole;
  similarity: number;
  vectorScore: number;
  bm25Score: number;
  rrfScore: number;
  matchedTerms: string[];
  excerpt: string;
}

export interface StructuredLogItem {
  id: string;
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  component:
    | 'api'
    | 'gemini'
    | 'slack'
    | 'cache'
    | 'ratelimit'
    | 'db'
    | 'client'
    | 'tools';
  event: string;
  requestId?: string;
  latencyMs?: number;
  cacheHit?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  statusCode?: number;
  metadata?: Record<string, unknown>;
  message: string;
}

export interface SemanticCacheEntry {
  id: number;
  queryText: string;
  answer: string;
  sources: string[];
  confidence: number;
  toolCalls?: AgentToolInvocation[];
  hitCount: number;
  createdAt: string;
  lastHitAt: string;
}

export interface EnvValidationCheck {
  key: string;
  status: 'valid' | 'fallback' | 'missing';
  description: string;
}

export interface EnvValidationReport {
  valid: boolean;
  checkedAt: string;
  environment: string;
  checks: EnvValidationCheck[];
  issues: string[];
}

export interface TelemetryPayload {
  tokenTotals: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    llmRequests: number;
    cacheHits: number;
    cacheMisses: number;
    slackEventsProcessed: number;
    slackRetriesDeduplicated: number;
    agentToolCalls?: number;
  };
  cacheHitRate: number;
  recentLogs: StructuredLogItem[];
  rateLimit: {
    backend: string;
    windowSeconds: number;
    chatLimit: number;
    chatRemaining: number;
    resetEpochSeconds: number;
    throttledRequests: number;
  };
  cacheEntries: SemanticCacheEntry[];
  envReport?: EnvValidationReport;
  rbacPolicy?: {
    activeRole: RbacRole;
    allowedTiers: RbacRole[];
    canIngest: boolean;
    canDeleteDocuments: boolean;
    canMutateSettings: boolean;
  };
}

/**
 * Phase 4 Step 1 & 2: Interactive Onboarding Checklists & Cohort Types
 */
export interface OnboardingTrackItem {
  id: number;
  phase: OnboardingPhase;
  title: string;
  description: string;
  category: string;
  targetRole: RbacRole;
  linkedDocTitle: string | null;
  verificationPrompt: string | null;
  estimatedMinutes: number;
  sortOrder: number;
  createdAt: string;
}

export interface UserMilestoneProgress {
  trackId: number;
  completed: boolean;
  completedAt: string | null;
  assignedBy: string;
  notes: string | null;
}

export interface EngineerCohortSummary {
  userHandle: string;
  displayName: string;
  engineerRole: string;
  completedCount: number;
  totalCount: number;
  completionRate: number;
  day1Completed: number;
  day1Total: number;
  week1Completed: number;
  week1Total: number;
  month1Completed: number;
  month1Total: number;
  lastUpdatedAt: string | null;
  progressByTrackId: Record<number, UserMilestoneProgress>;
}

export interface OnboardingPayload {
  activeUserHandle: string;
  activeRole: RbacRole;
  tracks: OnboardingTrackItem[];
  cohort: EngineerCohortSummary[];
}

/**
 * Phase 4 Step 3 & 4: External Connectors (GitHub & Google Workspace Drive/Docs)
 */
export interface ConnectorSyncLogItem {
  id: number;
  provider: 'github' | 'gdrive';
  target: string;
  branchOrFolder: string;
  triggerType: string;
  filesProcessed: number;
  chunksUpserted: number;
  commitSha: string | null;
  status: string;
  details: string;
  createdAt: string;
}

export interface GoogleDriveDocCandidate {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink?: string;
}

export interface ConnectorsOverviewPayload {
  githubOAuthConfigured: boolean;
  githubSessionConnected: boolean;
  githubConnectedUser?: string | null;
  googleWorkspaceScopes: string[];
  syncLogs: ConnectorSyncLogItem[];
}
