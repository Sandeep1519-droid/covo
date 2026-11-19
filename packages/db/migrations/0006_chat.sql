-- Phase 3 M3: chats. Each bot has conversations; your messages become tasks (runs). The bot's
-- replies are the runs themselves (state, summary, changes), so only your side is stored as text.
-- role 'bot' is for messages that aren't tasks, such as routine reports (M6).
CREATE TABLE conversations (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL REFERENCES agents(id),
  title       TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX conversations_agent ON conversations(agent_id, updated_at);

CREATE TABLE messages (
  id               TEXT PRIMARY KEY,
  conversation_id  TEXT NOT NULL REFERENCES conversations(id),
  role             TEXT NOT NULL CHECK (role IN ('you', 'bot')),
  text             TEXT NOT NULL,
  run_id           TEXT REFERENCES runs(id),
  model            TEXT,
  error            TEXT,
  created_at       INTEGER NOT NULL
);
CREATE INDEX messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX messages_run ON messages(run_id);
