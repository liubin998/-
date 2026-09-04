import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { seed } from './seed.js';
import { authMiddleware } from './domain/authHelpers.js';
import { requireCap } from './domain/auth.js';
import { recordAudit } from './domain/audit.js';
import { startScheduler } from './scheduler.js';
import { runCollectAll, runReconcileAll } from './collector/runner.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { subnetRouter } from './routes/subnets.js';
import { ipRouter } from './routes/ips.js';
import { deviceRouter } from './routes/devices.js';
import { importRouter } from './routes/imports.js';
import { ticketRouter } from './routes/tickets.js';
import { auditRouter, dashboardRouter, searchRouter } from './routes/system.js';
import { aiRouter } from './routes/ai.js';
import { wrap, errorMiddleware, notFoundHandler } from './routes/errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  seed();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.use('/api/auth', authRouter);

  app.post('/api/collect/run', authMiddleware, requireCap('device'), wrap(async (req, res) => {
    const results = await runCollectAll();
    recordAudit({
      userId: req.user.id, username: req.user.username, action: 'collect.run_all',
      entityType: 'device', after: { count: results.length }, source: 'web',
    });
    res.json({ results });
  }));

  app.post('/api/reconcile/run', authMiddleware, requireCap('conflict'), wrap(async (req, res) => {
    const created = runReconcileAll();
    res.json({ created: created.length, tickets: created.map((t) => ({ id: t.id, title: t.title })) });
  }));

  app.use('/api/admin', adminRouter);
  app.use('/api/subnets', subnetRouter);
  app.use('/api/ips', ipRouter);
  app.use('/api/devices', deviceRouter);
  app.use('/api/import', importRouter);
  app.use('/api/tickets', ticketRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/dashboard', dashboardRouter);
  app.use('/api/search', searchRouter);
  app.use('/api/ai', aiRouter);

  app.use('/api', notFoundHandler);
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get(/^\/(?!api\/).*/, (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });
  app.use(errorMiddleware);
  return app;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.listen(config.port, () => {
    console.log(`[ipam] listening on http://localhost:${config.port}`);
    startScheduler();
  });
}
