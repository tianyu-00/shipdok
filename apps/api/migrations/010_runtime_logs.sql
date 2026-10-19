-- Runtime logs: the app's own output. runtime.log holds the CURRENT run of the container and is reset whenever the
-- container starts again; the run before it is kept as runtime.previous.log (one generation). Both go away with the
-- deployment they belong to.
ALTER TABLE log_files DROP CONSTRAINT log_files_kind_check;
ALTER TABLE log_files ADD CONSTRAINT log_files_kind_check CHECK (kind IN ('build', 'runtime', 'runtime_previous'));

-- For a runtime log: which run of the container it holds (the container's StartedAt). A different value means a restart.
ALTER TABLE log_files ADD COLUMN run_started_at timestamptz;
