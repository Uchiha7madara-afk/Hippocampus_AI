import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config();

const isProd = process.env.NODE_ENV === 'production';
const databaseUrl = process.env.DATABASE_URL?.trim();
const sqlHost = process.env.SQL_HOST?.trim() || (isProd ? '' : 'localhost');
const sqlDbName = process.env.SQL_DB_NAME?.trim() || (isProd ? '' : 'postgres');
const user =
  process.env.SQL_ADMIN_USER?.trim() ||
  process.env.SQL_USER?.trim() ||
  (isProd ? '' : 'postgres');
const password =
  process.env.SQL_ADMIN_PASSWORD ?? process.env.SQL_PASSWORD ?? '';

const isUnixSocket = sqlHost.startsWith('/');
const isLocalHost =
  sqlHost === 'localhost' || sqlHost === '127.0.0.1' || sqlHost === '::1';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  schemaFilter: ['public'],
  dbCredentials: databaseUrl
    ? {
        url: databaseUrl,
      }
    : {
        host: sqlHost,
        user,
        password,
        database: sqlDbName,
        ssl: isProd && !isUnixSocket && !isLocalHost ? 'require' : false,
      },
  verbose: true,
});
