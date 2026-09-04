import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { applySchema } from './schema.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, 'ipam.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

applySchema(db);

export function now() {
  return Date.now();
}
