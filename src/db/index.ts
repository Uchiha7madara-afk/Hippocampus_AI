import fs from 'fs';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';
import * as schema from './schema.ts';

export type AppDatabase = NodePgDatabase<typeof schema>;

declare global {
  var _postgresPool: Pool | undefined;
}

function isUnixSocketHost(host?: string): boolean {
  return Boolean(host && host.startsWith('/'));
}

function isLocalTcpHost(host?: string): boolean {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function buildProductionSslConfig(): PoolConfig['ssl'] {
  // Never disable certificate verification (rejectUnauthorized is strictly true).
  const caPath = process.env.SQL_SSL_CA_PATH?.trim();
  const caCertInline = process.env.SQL_SSL_CA_CERT?.trim();

  if (caPath) {
    return {
      rejectUnauthorized: true,
      ca: fs.readFileSync(caPath, 'utf8'),
    };
  }
  if (caCertInline) {
    return {
      rejectUnauthorized: true,
      ca: caCertInline.replace(/\\n/g, '\n'),
    };
  }
  return {
    rejectUnauthorized: true,
  };
}

export function buildPoolConfigFromEnv(): PoolConfig {
  const isProd = process.env.NODE_ENV === 'production';
  const connectionString = process.env.DATABASE_URL?.trim();

  if (connectionString) {
    const parsedUrl = (() => {
      try {
        return new URL(connectionString);
      } catch {
        return null;
      }
    })();
    const hostParam = parsedUrl?.searchParams.get('host') || parsedUrl?.hostname || '';
    const requiresTls =
      isProd && !isUnixSocketHost(hostParam) && !isLocalTcpHost(hostParam);

    return {
      connectionString,
      max: 10,
      connectionTimeoutMillis: 5000,
      ...(requiresTls ? { ssl: buildProductionSslConfig() } : {}),
    };
  }

  const host = process.env.SQL_HOST?.trim();
  const user = process.env.SQL_USER?.trim();
  const password = process.env.SQL_PASSWORD;
  const database = process.env.SQL_DB_NAME?.trim();

  if (isProd) {
    if (!host || !user || !database || !password) {
      throw new Error(
        'Production PostgreSQL configuration incomplete: set DATABASE_URL or explicit SQL_HOST, SQL_USER, SQL_PASSWORD, and SQL_DB_NAME.'
      );
    }
  }

  // Cloud SQL Auth Proxy Unix domain sockets (/cloudsql/... or /app/cloudsql/...)
  // encrypt transport via the proxy mTLS tunnel; TCP hosts in production enforce verified TLS.
  const requiresTls =
    isProd && !isUnixSocketHost(host) && !isLocalTcpHost(host);

  return {
    host: host || 'localhost',
    user: user || 'postgres',
    password: password ?? '',
    database: database || 'postgres',
    max: 10,
    connectionTimeoutMillis: 5000,
    ...(requiresTls ? { ssl: buildProductionSslConfig() } : {}),
  };
}

export const createPool = (): Pool => {
  if (!global._postgresPool) {
    const config = buildPoolConfigFromEnv();
    global._postgresPool = new Pool(config);

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err.message);
    });
  }
  return global._postgresPool;
};

let activeDbOverride: AppDatabase | null = null;
let defaultDbInstance: AppDatabase | null = null;

function resolveActiveDb(): AppDatabase {
  if (activeDbOverride) {
    return activeDbOverride;
  }
  if (!defaultDbInstance) {
    const pool = createPool();
    defaultDbInstance = drizzle(pool, { schema });
  }
  return defaultDbInstance;
}

/**
 * Allows isolated real PostgreSQL integration tests (e.g. PGlite or a test Postgres pool)
 * to bind an isolated database instance. Blocked in production.
 */
export function setDbInstanceForTesting(customDb: AppDatabase | null): void {
  if (process.env.NODE_ENV === 'production' && customDb !== null) {
    throw new Error('Cannot override database instance in production.');
  }
  activeDbOverride = customDb;
}

export function getActiveDb(): AppDatabase {
  return resolveActiveDb();
}

export const db: AppDatabase = new Proxy({} as AppDatabase, {
  get(_target, prop, receiver) {
    const current = resolveActiveDb();
    const value = Reflect.get(current as object, prop, receiver);
    return typeof value === 'function' ? value.bind(current) : value;
  },
});
