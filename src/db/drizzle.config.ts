import { defineConfig } from 'drizzle-kit';
import * as dotenv from 'dotenv';

dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
const sqlHost = process.env.SQL_HOST || 'localhost';
const sqlDbName = process.env.SQL_DB_NAME || 'hippocampus_ci';
const user =
  process.env.SQL_ADMIN_USER || process.env.SQL_USER || 'postgres';
const password =
  process.env.SQL_ADMIN_PASSWORD ||
  process.env.SQL_PASSWORD ||
  'postgres_ci_password';

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
        ssl: false,
      },
  verbose: true,
});
