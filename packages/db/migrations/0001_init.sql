-- 0001_init: Phase 1 core tables.
-- Later phases add routines, plugins, policy cache, memory and browser tables in new migrations.

CREATE TABLE departments (
  id              TEXT PRIMARY KEY,                 -- 'dept_…' or 'dept_default'
  name            TEXT NOT NULL UNIQUE,
  workspace_path  TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL DEFAULT 1,       -- 8 GB Mac: one run at a time (ADR-001)
  sandbox_profile TEXT NOT NULL DEFAULT 'base',
  net_allowlist   TEXT NOT NULL DEFAULT '[]',       -- JSON array of host globs
  created_at      INTEGER NOT NULL,
  archived_at     INTEGER
);

CREATE TABLE agents (
  id               TEXT PRIMARY KEY,
  department_id    TEXT NOT NULL REFERENCES departments(id),
  name             TEXT NOT NULL,
  avatar_shape     TEXT NOT NULL DEFAULT 'Blob',
  avatar_color     TEXT NOT NULL DEFAULT 'sky',
  purpose          TEXT NOT NULL DEFAULT '',
  model            TEXT NOT NULL DEFAULT 'auto',     -- e.g. 'ollama:qwen3:4b'
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'archived')),
  created_at       INTEGER NOT NULL,
  UNIQUE (department_id, name)
);

CREATE TABLE runs (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents(id),
  department_id    TEXT NOT NULL REFERENCES departments(id),
  parent_run_id    TEXT REFERENCES runs(id),
  trigger          TEXT NOT NULL,                   -- cli | chat | cron | heartbeat | webhook
  goal             TEXT NOT NULL,
  state            TEXT NOT NULL CHECK (state IN (
                     'QUEUED', 'PREPARING', 'RUNNING', 'AWAITING_APPROVAL', 'HELP_REQUESTED',
                     'REVIEWING', 'AWAITING_MERGE_APPROVAL', 'MERGING', 'KEPT', 'SUCCEEDED',
                     'DISCARDED', 'FAILED', 'DENIED', 'STOPPED', 'STALLED', 'ROLLED_BACK', 'CANCELLED')),
  ws_path          TEXT,
  base_manifest    TEXT,                            -- sha256 of the workspace manifest at clone time
  model            TEXT,
  strikes          INTEGER NOT NULL DEFAULT 0,
  cost_usd         REAL NOT NULL DEFAULT 0,
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  created_at       INTEGER NOT NULL,
  started_at       INTEGER,
  finished_at      INTEGER
);
CREATE INDEX runs_state_idx ON runs(state, department_id);
CREATE INDEX runs_agent_idx ON runs(agent_id, created_at DESC);

CREATE TABLE run_steps (
  id               INTEGER PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id),
  seq              INTEGER NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('model', 'tool', 'approval', 'handover', 'checkin', 'state')),
  tool_name        TEXT,
  args_json        TEXT,
  result_digest    TEXT,                            -- sha256 of the full result
  result_preview   TEXT,                            -- first 2 KB, for `cw log`
  fingerprint      TEXT,                            -- tool + args + result digest, for loop detection
  mutating         INTEGER NOT NULL DEFAULT 0,
  decision         TEXT,                            -- allow | ask | deny
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  UNIQUE (run_id, seq)
);

CREATE TABLE approvals (
  id               TEXT PRIMARY KEY,
  run_id           TEXT NOT NULL REFERENCES runs(id),
  step_seq         INTEGER,
  kind             TEXT NOT NULL CHECK (kind IN ('tool_call', 'merge', 'spend', 'secret', 'handover')),
  summary          TEXT NOT NULL,
  payload_json     TEXT NOT NULL,
  payload_hash     TEXT NOT NULL,
  requires_touchid INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  decided_by       TEXT,
  decided_at       INTEGER,
  expires_at       INTEGER NOT NULL
);

-- Append-only activity log. Each row's hash covers the previous row's hash,
-- so any edit, deletion or reordering breaks the chain (see packages/db/src/audit.ts).
CREATE TABLE audit_log (
  seq              INTEGER PRIMARY KEY,             -- 1, 2, 3 … with no gaps
  ts               INTEGER NOT NULL,                -- unix ms
  run_id           TEXT,
  actor            TEXT NOT NULL,                   -- system | user | agent:<id> | tool:<name>
  action           TEXT NOT NULL,                   -- e.g. 'system.init', 'tool.exec'
  target           TEXT,
  decision         TEXT,                            -- allow | deny | ask
  detail_json      TEXT NOT NULL DEFAULT '{}',      -- canonical JSON
  prev_hash        TEXT NOT NULL,
  hash             TEXT NOT NULL UNIQUE
);
CREATE INDEX audit_run_idx ON audit_log(run_id, seq);
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

-- Append-only spending record. Limits come from the signed policy (Phase 2), never from this table.
CREATE TABLE budget_ledger (
  id               INTEGER PRIMARY KEY,
  ts               INTEGER NOT NULL,
  run_id           TEXT REFERENCES runs(id),
  agent_id         TEXT,
  department_id    TEXT,
  tier             TEXT NOT NULL CHECK (tier IN ('local', 'cli', 'api')),
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  tokens_in        INTEGER NOT NULL DEFAULT 0,
  tokens_out       INTEGER NOT NULL DEFAULT 0,
  usd              REAL NOT NULL DEFAULT 0,
  estimated        INTEGER NOT NULL DEFAULT 0
);
CREATE TRIGGER ledger_no_update BEFORE UPDATE ON budget_ledger
BEGIN SELECT RAISE(ABORT, 'budget_ledger is append-only'); END;
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON budget_ledger
BEGIN SELECT RAISE(ABORT, 'budget_ledger is append-only'); END;

CREATE TABLE events (
  id               INTEGER PRIMARY KEY,
  run_id           TEXT,
  ts               INTEGER NOT NULL,
  type             TEXT NOT NULL,
  payload_json     TEXT NOT NULL
);
CREATE INDEX events_run_idx ON events(run_id, id);
