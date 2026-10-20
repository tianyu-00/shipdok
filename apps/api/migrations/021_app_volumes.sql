-- Persistent storage for apps: Docker named volumes that outlive every deployment.
--   in_use     listed in the app's persistent storage and mounted by its deployments
--   detached   the path was removed from the list: the volume and its data are KEPT, just not mounted (adding the path again re-attaches it)
--   orphaned   the app was deleted and the administrator chose to keep its data
-- A volume is only ever deleted by an explicit request (or "delete the volumes too" when deleting the app).
CREATE TABLE app_volumes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id           uuid REFERENCES apps(id) ON DELETE SET NULL,   -- NULL once the app is gone
  app_name         text NOT NULL,                                  -- the app's name, so a volume can still be told apart after the app is gone
  container_path   text NOT NULL,
  docker_name      text NOT NULL UNIQUE,                           -- shipdok-vol-<id>, generated here, never built from user text
  state            text NOT NULL DEFAULT 'in_use' CHECK (state IN ('in_use', 'detached', 'orphaned')),
  remove_error     text,                                           -- why the last "delete this volume" did not work
  created_at       timestamptz NOT NULL DEFAULT now(),
  state_changed_at timestamptz NOT NULL DEFAULT now()
);
-- One mounted volume per path and app.
CREATE UNIQUE INDEX app_volumes_one_in_use_per_path ON app_volumes (app_id, container_path) WHERE state = 'in_use';
CREATE INDEX app_volumes_app_idx ON app_volumes (app_id);
