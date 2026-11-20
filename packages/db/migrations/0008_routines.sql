-- Phase 3 M6: routines (tasks on a schedule) and the daily summary.
CREATE TABLE routines (
  id            TEXT PRIMARY KEY,
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  name          TEXT NOT NULL,
  task          TEXT NOT NULL,                 -- what to do each time
  schedule      TEXT NOT NULL,                 -- as you wrote it, e.g. "weekdays 9:00"
  model         TEXT,                          -- a model to use instead of the bot's own
  run_limit_usd REAL,                          -- spending limit per run, instead of the bot's
  quiet         INTEGER NOT NULL DEFAULT 0,    -- 1: message your phone only if something needs you
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'removed')),
  next_at       INTEGER,                       -- when it runs next
  last_at       INTEGER,                       -- when it last started
  last_error    TEXT,                          -- why it last couldn't start
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);
CREATE INDEX routines_due ON routines(status, next_at);

ALTER TABLE runs ADD COLUMN routine_id TEXT REFERENCES routines(id);
CREATE INDEX runs_routine ON runs(routine_id, created_at);

-- Bot messages that carry more than text (the daily summary's sections, a routine you made in chat).
ALTER TABLE messages ADD COLUMN data_json TEXT;
