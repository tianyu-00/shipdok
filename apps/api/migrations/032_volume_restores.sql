-- Restoring an app's persistent volumes from a volume backup (the Restore button on the Storage page).
-- A restore is asked for here (status 'queued') and carried out by the worker beside the deployment queue, one thing at a time with the backups:
--   queued -> running -> ok | failed
-- mode: replace = the volume ends up exactly as the backup was (files that are not in it are removed); add = the backup's files are written over
-- the current ones; empty = only when the volume holds nothing. safety_backup: a normal volume backup of the current data is made first
-- (safety_backup_id says which). passphrase_enc: the backup's own passphrase when it is not the current one, encrypted with the platform key and
-- removed as soon as the restore ends.
CREATE TABLE volume_restores (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backup_id        uuid REFERENCES backups(id) ON DELETE SET NULL,
  app_id           uuid REFERENCES apps(id) ON DELETE SET NULL,
  app_name         text NOT NULL,
  backup_made_at   timestamptz,
  mode             text NOT NULL CHECK (mode IN ('replace', 'add', 'empty')),
  safety_backup    boolean NOT NULL,
  safety_backup_id uuid REFERENCES backups(id) ON DELETE SET NULL,
  passphrase_enc   text,
  status           text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ok', 'failed')),
  requested_at     timestamptz NOT NULL DEFAULT now(),
  started_at       timestamptz,
  finished_at      timestamptz,
  volume_count     integer CHECK (volume_count IS NULL OR volume_count >= 0),
  warning          text,
  error            text
);
-- One restore waiting or running per app.
CREATE UNIQUE INDEX volume_restores_one_active ON volume_restores (app_id) WHERE status IN ('queued', 'running');
CREATE INDEX volume_restores_requested_idx ON volume_restores (requested_at DESC);

-- A backup made just before a restore replaces the data says so; a restore asks for the password again and is recorded in the sign-ins list.
ALTER TABLE backups DROP CONSTRAINT backups_trigger_check;
ALTER TABLE backups ADD CONSTRAINT backups_trigger_check CHECK (trigger IN ('manual', 'scheduled', 'before_restore'));
ALTER TABLE login_attempts DROP CONSTRAINT login_attempts_kind_check;
ALTER TABLE login_attempts ADD CONSTRAINT login_attempts_kind_check CHECK (kind IN ('login', 'setup', 'recovery', 'reset', 'settings', 'github', 'backup', 'download', 'restore'));
