import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const config = {
  port: Number(process.env.PORT || 8787),
  dataDir: process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  tokenSecret: process.env.TOKEN_SECRET || 'ipam-dev-secret-change-in-production',
  tokenTtlMs: 12 * 60 * 60 * 1000,
  collectIntervalMs: Number(process.env.COLLECT_INTERVAL_MS || 60000),
  reconcileIntervalMs: Number(process.env.RECONCILE_INTERVAL_MS || 120000),
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD || 'Admin@12345',
  probeRateLimitPerMin: 20,
  acOnlineUserCap: 100,
  defaults: {
    acOnlineWindowMin: 5,
    acBindingWindowMin: 10,
    arpWindowMin: 10,
    macWindowMin: 10,
    dhcpWindowMin: 15,
  },
};
