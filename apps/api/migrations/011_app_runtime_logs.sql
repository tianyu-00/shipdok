-- Runtime logs belong to the APP, not to a deployment: one current run (runtime.log) and one earlier run
-- (runtime.previous.log) per app, reset whenever the container starts again, a new deployment included.
-- Build logs stay one per deployment (log_files, kind 'build').
CREATE TABLE runtime_logs (
  app_id         uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind           text NOT NULL CHECK (kind IN ('runtime', 'runtime_previous')),
  deployment_id  uuid REFERENCES deployments(id) ON DELETE SET NULL, -- whose container wrote it (information only)
  container_id   text,                                               -- which container; a different one is a new deployment
  run_started_at timestamptz,                                        -- the container's StartedAt: a different value means a restart
  bytes          bigint NOT NULL DEFAULT 0,                          -- final size; while ended_at is NULL the file on disk is the truth
  truncated      boolean NOT NULL DEFAULT false,
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz,                                        -- NULL while the log is still being written
  PRIMARY KEY (app_id, kind)
);

-- Runtime logs kept per deployment by the earlier version are dropped; the worker removes their files at its next start.
DELETE FROM log_files WHERE kind <> 'build';
ALTER TABLE log_files DROP CONSTRAINT log_files_kind_check;
ALTER TABLE log_files ADD CONSTRAINT log_files_kind_check CHECK (kind = 'build');
ALTER TABLE log_files DROP COLUMN run_started_at;
