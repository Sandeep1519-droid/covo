-- 0002_run_summary: the bot's own one-line summary of what it did, shown in `covo status` and later in chat.
ALTER TABLE runs ADD COLUMN summary TEXT;
