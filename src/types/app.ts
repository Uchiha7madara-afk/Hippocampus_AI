export type WorkspaceTab =
  | 'dashboard'
  | 'sources'
  | 'playground'
  | 'slack'
  | 'logs';

export interface IndexedDocument {
  id: number;
  userId: string | null;
  title: string;
  sourceType: 'file' | 'url' | 'slack';
  sourceUrl: string | null;
  status: string;
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
}

export interface OverviewPayload {
  stats: DashboardStats;
  recentDocuments: IndexedDocument[];
  recentLogs: QueryLogItem[];
  settings: AgentSettingItem[];
}

export interface RetrievedChunkPreview {
  documentTitle: string;
  sourceType: string;
  similarity: number;
  excerpt: string;
}
