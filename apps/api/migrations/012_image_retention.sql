-- Image retention, rollback and manual clean-up.
--
-- keep_previous_images: how many earlier successful versions' images are kept besides the live one (default 1: the
--   live version and the one before it, so a rollback is always possible). auto_prune: clean up after every
--   successful deployment (off by default: pruning is normally requested by the administrator).
ALTER TABLE apps
  ADD COLUMN keep_previous_images integer NOT NULL DEFAULT 1 CHECK (keep_previous_images BETWEEN 0 AND 10),
  ADD COLUMN auto_prune           boolean NOT NULL DEFAULT false;

-- image_bytes: size of the image when the deployment went live (so the API can show what pruning would free
--   without asking Docker). image_removed_at: the image was pruned; the deployment and its logs stay, but it can
--   no longer be rolled back to. rollback_of: the deployment whose image a rollback reuses (no rebuild).
ALTER TABLE deployments
  ADD COLUMN image_bytes      bigint,
  ADD COLUMN image_removed_at timestamptz,
  ADD COLUMN rollback_of      uuid REFERENCES deployments(id) ON DELETE SET NULL;

-- What the last clean-up of an app did, for the API to show (the worker does the work; the API never touches Docker).
CREATE TABLE app_cleanup (
  app_id        uuid PRIMARY KEY REFERENCES apps(id) ON DELETE CASCADE,
  last_run_at   timestamptz NOT NULL DEFAULT now(),
  trigger       text NOT NULL CHECK (trigger IN ('manual', 'auto')),
  images_removed integer NOT NULL DEFAULT 0,
  freed_bytes   bigint NOT NULL DEFAULT 0,
  skipped       integer NOT NULL DEFAULT 0,     -- images that could not be removed (for example, in use)
  error         text
);
