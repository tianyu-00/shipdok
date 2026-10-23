-- Backups of an app's persistent volumes, in the same list as the backups of Shipdok itself.
--   kind 'platform'  the database and the platform secrets (as before)
--   kind 'volumes'   every mounted volume of ONE app, in one file; app_id says which (NULL once the app is deleted: the backup stays, app_name still says whose it was)
-- One waiting or running backup per kind and app (so a Shipdok backup and an app's volume backup may wait together, and the worker makes them one after the other).
ALTER TABLE backups
  ADD COLUMN kind         text NOT NULL DEFAULT 'platform' CHECK (kind IN ('platform', 'volumes')),
  ADD COLUMN app_id       uuid REFERENCES apps(id) ON DELETE SET NULL,
  ADD COLUMN app_name     text,
  ADD COLUMN volume_count integer CHECK (volume_count IS NULL OR volume_count >= 0),
  ADD CONSTRAINT backups_kind_app CHECK (kind = 'volumes' OR (app_id IS NULL AND app_name IS NULL));

ALTER TABLE backups DROP CONSTRAINT backups_filename_check;
ALTER TABLE backups ADD CONSTRAINT backups_filename_check
  CHECK (filename IS NULL OR filename ~ '^shipdok-(backup|volumes)-[0-9]{8}-[0-9]{6}-[0-9a-f]{8}\.tar(\.enc)?$');

DROP INDEX backups_one_active;
CREATE UNIQUE INDEX backups_one_active ON backups (kind, (coalesce(app_id, '00000000-0000-0000-0000-000000000000'::uuid))) WHERE status IN ('queued', 'running');
CREATE INDEX backups_app_idx ON backups (app_id, requested_at DESC) WHERE kind = 'volumes';

-- Per app: is its data included in the scheduled backups, is the app stopped briefly while it is copied (a database in a volume is copied
-- consistently only then), how many to keep. volume_backup_changed_at stops a switch turned on after today's slot from backing up for that slot.
ALTER TABLE apps
  ADD COLUMN volume_backup_enabled    boolean NOT NULL DEFAULT false,
  ADD COLUMN volume_backup_stop       boolean NOT NULL DEFAULT false,
  ADD COLUMN volume_backup_keep       integer NOT NULL DEFAULT 3 CHECK (volume_backup_keep BETWEEN 1 AND 60),
  ADD COLUMN volume_backup_changed_at timestamptz;
