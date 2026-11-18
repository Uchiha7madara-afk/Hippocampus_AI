import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

export const createPool = () => {
  if (!global._postgresPool) {
    const connectionString = process.env.DATABASE_URL;
    global._postgresPool = connectionString
      ? new Pool({
          connectionString,
          max: 10,
          connectionTimeoutMillis: 5000,
        })
      : new Pool({
          host: process.env.SQL_HOST || 'localhost',
          user: process.env.SQL_USER || 'postgres',
          password: process.env.SQL_PASSWORD || 'postgres_ci_password',
          database: process.env.SQL_DB_NAME || 'hippocampus_ci',
          max: 10,
          connectionTimeoutMillis: 5000,
        });

    global._postgresPool.on('error', (err) => {
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._postgresPool;
};

const pool = createPool();

export const db = drizzle(pool, { schema });
