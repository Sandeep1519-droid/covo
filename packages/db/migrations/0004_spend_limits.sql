-- 0004_spend_limits: a bot's own spending limit per task, in US dollars (NULL = use the general one).
ALTER TABLE agents ADD COLUMN run_limit_usd REAL CHECK (run_limit_usd IS NULL OR run_limit_usd >= 0);
