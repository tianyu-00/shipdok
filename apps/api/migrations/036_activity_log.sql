-- The activity log: changing how long attempts and activity are kept is itself recorded ("logsettings").
-- How long they are kept is a row of `settings` (activity_keep_days: 7, 30, 90 or 365; 30 when there is none).
ALTER TABLE login_attempts DROP CONSTRAINT login_attempts_kind_check;
ALTER TABLE login_attempts ADD CONSTRAINT login_attempts_kind_check CHECK (kind IN ('login', 'setup', 'recovery', 'reset', 'settings', 'github', 'backup', 'download', 'restore', 'logsettings'));
