import express from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import * as dotenv from 'dotenv';
import { createApp } from './src/app-server.ts';
import {
  assertSafeProductionConfig,
  validateRuntimeEnv,
} from './src/lib/env.ts';
import { emitStructuredLog } from './src/lib/logger.ts';

dotenv.config();

const { env } = validateRuntimeEnv();
assertSafeProductionConfig();
const PORT = env.PORT || 3000;
const app = createApp();

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
      metadata: { port: PORT, nodeEnv: process.env.NODE_ENV || 'development' },
      message: `Hippocampus hardened server listening on http://0.0.0.0:${PORT}`,
    });
  });
}

startServer();
