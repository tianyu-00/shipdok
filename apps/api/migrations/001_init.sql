-- Shipdok initial schema (draft for review).

-- Single administrator. The unique index on a constant expression allows at most
-- one row ever, so first-run setup is atomic: a concurrent second INSERT fails.
CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_single_admin ON users ((true));

-- One row per application. id is the stable internal ID used in Docker labels.
CREATE TABLE apps (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL UNIQUE,            -- display name, editable
  slug          text NOT NULL UNIQUE,            -- normalised, used for future Docker names
  repo          text NOT NULL CHECK (repo ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'),  -- GitHub owner/repo
  github_installation_id bigint,                 -- GitHub App installation; NULL until the app is wired up
  branch        text NOT NULL DEFAULT 'main',
  root_dir      text NOT NULL DEFAULT '.',
  container_port integer NOT NULL CHECK (container_port BETWEEN 1 AND 65535),
  host_port     integer UNIQUE CHECK (host_port BETWEEN 1 AND 65535),  -- NULL = auto-allocate
  health_path   text,
  memory_mb     integer NOT NULL DEFAULT 512 CHECK (memory_mb > 0),
  cpus          numeric(4,2) NOT NULL DEFAULT 1 CHECK (cpus > 0),
  desired_state text NOT NULL DEFAULT 'running' CHECK (desired_state IN ('running', 'stopped')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per deployment attempt. Deployment status is separate from runtime health.
CREATE TABLE deployments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          uuid NOT NULL REFERENCES apps(id) ON DELETE RESTRICT,
  commit_sha      text,
  trigger         text NOT NULL CHECK (trigger IN ('manual', 'webhook', 'rollback')),
  status          text NOT NULL DEFAULT 'queued' CHECK (status IN (
                    'queued', 'building', 'starting', 'validating',
                    'successful', 'failed', 'cancelled', 'superseded', 'interrupted')),
  image_ref       text,                          -- set once built; protects the image from cleanup
  config_snapshot jsonb NOT NULL,                -- settings used for THIS deployment (no secret values)
  error_summary   text,                          -- kept even if detailed logs are deleted
  job_id          text,                          -- BullMQ job ID
  queued_at       timestamptz NOT NULL DEFAULT now(),
  started_at      timestamptz,
  finished_at     timestamptz
);
CREATE INDEX deployments_app_queued_idx ON deployments (app_id, queued_at DESC);
CREATE INDEX deployments_active_idx ON deployments (status)
  WHERE status IN ('queued', 'building', 'starting', 'validating');
