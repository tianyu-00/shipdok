-- Each app gets its own schedule for the backups of its persistent volumes (it was one on/off switch on the schedule of Shipdok's own backups).
-- frequency 'off' = not in the automatic backups. An app that was switched on keeps what it had: the shared schedule's frequency, hour and weekday as they
-- are now. The number of volume backups to keep now starts at 2 for an app that never set it (an app already saved keeps its number).
ALTER TABLE apps
  ADD COLUMN volume_backup_frequency text    NOT NULL DEFAULT 'off' CHECK (volume_backup_frequency IN ('off', 'daily', 'weekly')),
  ADD COLUMN volume_backup_hour      integer NOT NULL DEFAULT 3 CHECK (volume_backup_hour BETWEEN 0 AND 23),
  ADD COLUMN volume_backup_weekday   integer NOT NULL DEFAULT 1 CHECK (volume_backup_weekday BETWEEN 0 AND 6);

UPDATE apps SET
  volume_backup_frequency = CASE
    WHEN NOT volume_backup_enabled THEN 'off'
    WHEN (SELECT value->>'frequency' FROM settings WHERE key = 'backup_schedule') IN ('off', 'daily', 'weekly') THEN (SELECT value->>'frequency' FROM settings WHERE key = 'backup_schedule')
    ELSE 'daily' END,
  volume_backup_hour = COALESCE((SELECT (value->>'hour')::int FROM settings WHERE key = 'backup_schedule' AND (value->>'hour') ~ '^([0-9]|1[0-9]|2[0-3])$'), 3),
  volume_backup_weekday = COALESCE((SELECT (value->>'weekday')::int FROM settings WHERE key = 'backup_schedule' AND (value->>'weekday') ~ '^[0-6]$'), 1);

ALTER TABLE apps DROP COLUMN volume_backup_enabled;
ALTER TABLE apps ALTER COLUMN volume_backup_keep SET DEFAULT 2;
