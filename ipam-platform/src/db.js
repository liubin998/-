import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new Database(path.join(config.dataDir, 'ipam.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS branches (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  parent_id INTEGER REFERENCES branches(id),
  owner TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  email TEXT,
  department TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS role_caps (
  role TEXT NOT NULL,
  cap TEXT NOT NULL,
  PRIMARY KEY (role, cap)
);

CREATE TABLE IF NOT EXISTS user_grants (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  role TEXT NOT NULL,
  valid_until INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subnets (
  id INTEGER PRIMARY KEY,
  cidr TEXT NOT NULL UNIQUE,
  family INTEGER NOT NULL,
  prefix INTEGER NOT NULL,
  network_start BLOB NOT NULL,
  network_end BLOB NOT NULL,
  purpose TEXT,
  kind TEXT,
  branch_id INTEGER REFERENCES branches(id),
  vlan INTEGER,
  gateway TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subnets_range ON subnets (family, network_start, network_end);
CREATE INDEX IF NOT EXISTS idx_subnets_branch ON subnets (branch_id);

CREATE TABLE IF NOT EXISTS ip_ledger (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  family INTEGER NOT NULL,
  value BLOB NOT NULL,
  subnet_id INTEGER REFERENCES subnets(id),
  business_status TEXT NOT NULL DEFAULT 'pending',
  mac TEXT,
  branch_id INTEGER REFERENCES branches(id),
  description TEXT,
  source TEXT DEFAULT 'manual',
  import_batch_id INTEGER REFERENCES import_batches(id),
  import_row INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ip_value ON ip_ledger (family, value);
CREATE INDEX IF NOT EXISTS idx_ip_subnet ON ip_ledger (subnet_id);
CREATE INDEX IF NOT EXISTS idx_ip_branch ON ip_ledger (branch_id);

CREATE TABLE IF NOT EXISTS ip_assignments (
  id INTEGER PRIMARY KEY,
  ip_id INTEGER NOT NULL REFERENCES ip_ledger(id),
  object_id INTEGER NOT NULL REFERENCES objects(id),
  assigned_at INTEGER NOT NULL,
  released_at INTEGER,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_assign_ip ON ip_assignments (ip_id);
CREATE INDEX IF NOT EXISTS idx_assign_obj ON ip_assignments (object_id);

CREATE TABLE IF NOT EXISTS object_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  fields_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS objects (
  id INTEGER PRIMARY KEY,
  type_id INTEGER NOT NULL REFERENCES object_types(id),
  name TEXT NOT NULL,
  code TEXT,
  owner TEXT,
  department TEXT,
  branch_id INTEGER REFERENCES branches(id),
  fields_json TEXT NOT NULL DEFAULT '{}',
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obj_branch ON objects (branch_id);

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  vendor TEXT NOT NULL,
  model TEXT,
  software_version TEXT,
  mgmt_ip TEXT,
  branch_id INTEGER REFERENCES branches(id),
  role TEXT,
  protocol TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  credential_ref TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'unknown',
  last_comm_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  branch_id INTEGER REFERENCES branches(id),
  evidence_type TEXT NOT NULL,
  ip TEXT NOT NULL,
  value BLOB NOT NULL,
  family INTEGER NOT NULL,
  mac TEXT,
  username TEXT,
  terminal TEXT,
  port TEXT,
  vlan TEXT,
  detail_json TEXT,
  login_time INTEGER,
  online_seconds INTEGER,
  confidence TEXT NOT NULL DEFAULT 'high',
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_ip ON observations (family, value, evidence_type);
CREATE INDEX IF NOT EXISTS idx_obs_device ON observations (device_id, observed_at);
CREATE INDEX IF NOT EXISTS idx_obs_expires ON observations (expires_at);

CREATE TABLE IF NOT EXISTS collect_runs (
  id INTEGER PRIMARY KEY,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  task TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  completeness TEXT NOT NULL DEFAULT 'complete',
  record_count INTEGER DEFAULT 0,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_device ON collect_runs (device_id, started_at);

CREATE TABLE IF NOT EXISTS probes (
  id INTEGER PRIMARY KEY,
  initiator_id INTEGER NOT NULL REFERENCES users(id),
  ip TEXT NOT NULL,
  subnet_id INTEGER REFERENCES subnets(id),
  probe_type TEXT NOT NULL DEFAULT 'icmp',
  result TEXT NOT NULL,
  detail TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batches (
  id INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  file_hash TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  file_type TEXT NOT NULL,
  sheet TEXT,
  branch_id INTEGER REFERENCES branches(id),
  uploaded_by INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'uploaded',
  stats_json TEXT,
  created_at INTEGER NOT NULL,
  committed_at INTEGER
);

CREATE TABLE IF NOT EXISTS import_errors (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES import_batches(id),
  row_no INTEGER NOT NULL,
  level TEXT NOT NULL,
  error_type TEXT NOT NULL,
  column_name TEXT,
  original_value TEXT,
  message TEXT NOT NULL,
  suggestion TEXT
);
CREATE INDEX IF NOT EXISTS idx_imperr_batch ON import_errors (batch_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  entity_type TEXT,
  entity_id TEXT,
  branch_id INTEGER,
  before_json TEXT,
  after_json TEXT,
  result TEXT NOT NULL DEFAULT 'ok',
  reason TEXT,
  source TEXT DEFAULT 'web',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_logs (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs (entity_type, entity_id);

CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY,
  ticket_key TEXT UNIQUE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'medium',
  branch_id INTEGER REFERENCES branches(id),
  ip TEXT,
  subnet_id INTEGER REFERENCES subnets(id),
  device_id INTEGER REFERENCES devices(id),
  assignee TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  detail_json TEXT,
  resolution TEXT,
  close_reason TEXT,
  due_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ticket_status ON tickets (status);
CREATE INDEX IF NOT EXISTS idx_ticket_branch ON tickets (branch_id);

CREATE TABLE IF NOT EXISTS ticket_comments (
  id INTEGER PRIMARY KEY,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id),
  user_id INTEGER REFERENCES users(id),
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS window_settings (
  id INTEGER PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id INTEGER,
  evidence_type TEXT NOT NULL,
  window_min INTEGER NOT NULL,
  UNIQUE (scope, scope_id, evidence_type)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sim_world (
  branch_id INTEGER PRIMARY KEY REFERENCES branches(id),
  config_json TEXT NOT NULL DEFAULT '{}'
);
`);

export function now() {
  return Date.now();
}
