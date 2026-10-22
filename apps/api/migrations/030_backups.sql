-- Backups of Shipdok itself: the database and the platform secrets (the key without which its encrypted data cannot be read), in one file.
-- The files live in a Docker volume (BACKUP_DIR); this table says which exist and how each went. A backup is asked for here (status 'queued',
-- by the dashboard or by the schedule) and made by the worker, which notices it within a few seconds; it does not wait behind builds.
--   queued -> running -> ok | failed
-- Only one backup may be waiting or running at a time (the unique index): a second request is refused, and so is a schedule that fires twice.
-- The schedule and the passphrase are rows of `settings` (backup_schedule, backup_passphrase; the passphrase encrypted with the platform key).
CREATE TABLE backups (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'ok', 'failed')),
  trigger      text NOT NULL CHECK (trigger IN ('manual', 'scheduled')),
  filename     text CHECK (filename IS NULL OR filename ~ '^shipdok-backup-[0-9]{8}-[0-9]{6}-[0-9a-f]{8}\.tar(\.enc)?$'),
  size_bytes   bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  encrypted    boolean,
  verified     boolean,          -- the dump was read back (pg_restore --list) and had content
  version      text,             -- the Shipdok version that made it
  warning      text,             -- something the person should know, for example that the secrets could not be included
  error        text
);
CREATE UNIQUE INDEX backups_one_active ON backups ((true)) WHERE status IN ('queued', 'running');
CREATE INDEX backups_requested_idx ON backups (requested_at DESC);

-- Setting or removing the backup passphrase, and downloading a backup (both ask for the password), are recorded in the sign-ins list.
ALTER TABLE login_attempts DROP CONSTRAINT login_attempts_kind_check;
ALTER TABLE login_attempts ADD CONSTRAINT login_attempts_kind_check CHECK (kind IN ('login', 'setup', 'recovery', 'reset', 'settings', 'github', 'backup', 'download'));
