-- 0003_bot_models: each bot's models, in order (the first that works is used), and how
-- independently it works (ADR-010). The old single `model` column stays for compatibility.
ALTER TABLE agents ADD COLUMN model_chain TEXT NOT NULL DEFAULT '[]';
ALTER TABLE agents ADD COLUMN level TEXT NOT NULL DEFAULT 'automatic'
  CHECK (level IN ('supervised', 'automatic', 'full'));
