-- Which log files exist on disk for a deployment, and how big. The text itself lives in files under LOG_DIR
-- (<app-id>/<deployment-id>/build.log and runtime.log); this table lets the API list sizes and warn about disk use
-- without walking the directory tree. A deployment's logs are kept until the deployment is deleted.
CREATE TABLE log_files (
  deployment_id uuid NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
  app_id        uuid NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('build', 'runtime')),
  bytes         bigint NOT NULL DEFAULT 0,         -- final size; while ended_at is NULL the file on disk is the truth
  truncated     boolean NOT NULL DEFAULT false,    -- the size cap was reached and later output was not stored
  started_at    timestamptz NOT NULL DEFAULT now(),
  ended_at      timestamptz,                       -- NULL while the log is still being written
  PRIMARY KEY (deployment_id, kind)
);
CREATE INDEX log_files_app_idx ON log_files (app_id);
