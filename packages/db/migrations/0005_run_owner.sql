-- 0005_run_owner: which process runs a run, so the service can tell a crashed run from a live one.
ALTER TABLE runs ADD COLUMN pid INTEGER;
